import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import {
  SportsMatch,
  MatchedMarketPair,
  PmSportsEvent,
  PmMarket,
  DexSportsEvent,
  DexMarket,
} from '../interfaces/sports-arb.types';
import {
  SPORTS,
  MARKET_MAP,
  VALUE_TYPES,
  SPREAD_TYPES,
  MATCH_THRESHOLD,
  MIN_SHARED_WORDS,
  TEAM_ALIASES,
  STOP_WORDS,
  DEX_SLUG_TO_SPORT,
} from './sports-constants';

// ── Text similarity (from test-match-events.ts) ──────────────

function stemWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('tion') || word.endsWith('sion')) return word.slice(0, -4);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ness') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('able') && word.length > 6) return word.slice(0, -4);
  if (word.endsWith('ful') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ous') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ive') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('er') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => TEAM_ALIASES[w] ?? w)
    .map(stemWord);
}

function jaccardSimilarity(words1: string[], words2: string[]): number {
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let intersection = 0;
  for (const w of set1) if (set2.has(w)) intersection++;
  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function wordOrderSimilarity(words1: string[], words2: string[]): number {
  const common = words1.filter((w) => words2.includes(w));
  if (common.length === 0) return 0;
  let score = 0;
  for (const w of common) {
    const p1 = words1.indexOf(w) / words1.length;
    const p2 = words2.indexOf(w) / words2.length;
    score += 1 - Math.abs(p1 - p2);
  }
  return score / common.length;
}

function containmentScore(words1: string[], words2: string[]): number {
  const [shorter, longer] = words1.length <= words2.length ? [words1, words2] : [words2, words1];
  if (shorter.length === 0) return 0;
  const longerSet = new Set(longer);
  return shorter.filter((w) => longerSet.has(w)).length / shorter.length;
}

function teamSimilarity(a: string, b: string): number {
  const wa = normalizeText(a);
  const wb = normalizeText(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  return Math.max(jaccardSimilarity(wa, wb), containmentScore(wa, wb));
}

function splitTeams(title: string): [string, string] | null {
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (vsMatch) return [vsMatch[1].trim(), vsMatch[2].trim()];
  const dashMatch = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) return [dashMatch[1].trim(), dashMatch[2].trim()];
  return null;
}

function computeSimilarity(title1: string, title2: string): number {
  const teams1 = splitTeams(title1);
  const teams2 = splitTeams(title2);

  if (teams1 && teams2) {
    const [t1a, t1b] = teams1;
    const [t2a, t2b] = teams2;
    const directScore = Math.min(teamSimilarity(t1a, t2a), teamSimilarity(t1b, t2b));
    const swappedScore = Math.min(teamSimilarity(t1a, t2b), teamSimilarity(t1b, t2a));
    return Math.max(directScore, swappedScore);
  }

  const w1 = normalizeText(title1);
  const w2 = normalizeText(title2);
  if (w1.length === 0 || w2.length === 0) return 0;
  const baseSim = Math.max(jaccardSimilarity(w1, w2), containmentScore(w1, w2));
  return baseSim * 0.8 + wordOrderSimilarity(w1, w2) * 0.2;
}

/**
 * Strip PM title to just "Team A vs Team B".
 * Removes sport prefix before colon, parenthesized content, tournament suffix.
 */
function stripPmTitle(title: string): string {
  let s = title.trim();

  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) {
    const afterColon = s.slice(colonIdx + 1).trim();
    if (/\bvs\.?\b/i.test(afterColon)) s = afterColon;
  }

  s = s.replace(/\s*\([^)]*\)/g, '').trim();

  if (/\bvs\.?\b/i.test(s)) {
    const dashIdx = s.lastIndexOf(' - ');
    if (dashIdx > 0) s = s.slice(0, dashIdx).trim();
  }

  return s;
}

// ── Market matching (from test-match-events.ts) ──────────────

function extractPmValue(question: string): number | null {
  const ouMatch = question.match(/O\/U\s+([\d.]+)/i);
  if (ouMatch) return parseFloat(ouMatch[1]);
  const spreadMatch = question.match(/\(([+-]?[\d.]+)\)/);
  if (spreadMatch) return parseFloat(spreadMatch[1]);
  return null;
}

function extractDexValue(outcomes: Array<{ name: string; price: number }>): number | null {
  for (const o of outcomes) {
    const match = o.name.match(/([\d.]+)/);
    if (match) return parseFloat(match[1]);
  }
  return null;
}

function dexNameMatchesCandidate(dexName: string, candidate: string): boolean {
  const dn = dexName.toLowerCase().trim();
  const cn = candidate.toLowerCase().trim();
  return dn === cn || dn.startsWith(cn);
}

function matchMarket(pm: PmMarket, dexMarkets: DexMarket[], sportKey: string): DexMarket | null {
  const type = pm.sportsMarketType;
  if (!type) return null;

  const sportMap = MARKET_MAP[sportKey] ?? {};
  let candidates: string[] = sportMap[type] ?? [];
  let isDynamic = false;

  if (type === 'child_moneyline') {
    const numMatch = pm.question.match(/(?:Map|Game)\s+(\d+)/i);
    if (!numMatch) return null;
    const n = numMatch[1];
    candidates = [`Winner. Map ${n}`, `Winner. Game ${n}`, `Map ${n}`, `Game ${n}`];
    isDynamic = true;
  }

  if (candidates.length === 0) return null;

  const nameMatches = dexMarkets.filter((dex) =>
    candidates.some((c) =>
      isDynamic
        ? dex.name.toLowerCase().includes(c.toLowerCase())
        : dexNameMatchesCandidate(dex.name, c),
    ),
  );

  if (nameMatches.length === 0) return null;

  if (VALUE_TYPES.has(type)) {
    const pmValue = extractPmValue(pm.question);
    if (pmValue !== null) {
      const valueMatch = nameMatches.find((dex) => {
        const dexValue = extractDexValue(dex.outcomes);
        if (dexValue === null) return false;
        if (SPREAD_TYPES.has(type)) {
          return Math.abs(Math.abs(pmValue) - Math.abs(dexValue)) < 0.01;
        }
        return Math.abs(pmValue - dexValue) < 0.01;
      });
      if (valueMatch) return valueMatch;
      return null;
    }
  }

  return nameMatches[0];
}

function matchMarketsForPair(pm: PmSportsEvent, dex: DexSportsEvent, sportKey: string): MatchedMarketPair[] {
  const results: MatchedMarketPair[] = [];
  const usedDexMarkets = new Set<string>();

  for (const pmMarket of pm.markets) {
    if (!pmMarket.sportsMarketType) continue;
    const dexMarket = matchMarket(
      pmMarket,
      dex.markets.filter((d) => !usedDexMarkets.has(d.name)),
      sportKey,
    );
    if (!dexMarket) continue;

    usedDexMarkets.add(dexMarket.name);
    results.push({
      pmType: pmMarket.sportsMarketType,
      pmMarket,
      dexMarket,
    });
  }

  return results;
}

// ── Service ──────────────────────────────────────────────────

@Injectable()
export class SportsMatcher {
  private readonly logger = new Logger(SportsMatcher.name);

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
  ) {}

  findMatches(): SportsMatch[] {
    const pmEvents = this.polyAdapter.getEvents();
    const dexEvents = this.dexAdapter.getEvents();

    // Resolve DEX sport slugs to our canonical sport keys
    const dexMapped = dexEvents.map((e) => ({
      ...e,
      sportKey: DEX_SLUG_TO_SPORT.get(e.sportKey) ?? e.sportKey,
    }));

    const pairs: SportsMatch[] = [];

    // Group by sport
    const pmBySport = new Map<string, PmSportsEvent[]>();
    const dexBySport = new Map<string, DexSportsEvent[]>();

    for (const e of pmEvents) {
      if (!pmBySport.has(e.sportKey)) pmBySport.set(e.sportKey, []);
      pmBySport.get(e.sportKey)!.push(e);
    }
    for (const e of dexMapped) {
      if (!dexBySport.has(e.sportKey)) dexBySport.set(e.sportKey, []);
      dexBySport.get(e.sportKey)!.push(e);
    }

    for (const sportKey of Object.keys(SPORTS)) {
      const pmList = pmBySport.get(sportKey) ?? [];
      const dexList = dexBySport.get(sportKey) ?? [];

      if (pmList.length === 0 || dexList.length === 0) continue;

      // Build inverted index over dex events for quick candidate lookup
      const invertedIndex = new Map<string, DexSportsEvent[]>();
      for (const dex of dexList) {
        for (const word of normalizeText(dex.name)) {
          if (!invertedIndex.has(word)) invertedIndex.set(word, []);
          invertedIndex.get(word)!.push(dex);
        }
      }

      const usedDex = new Set<string>();

      for (const pm of pmList) {
        const pmStripped = stripPmTitle(pm.title);
        const pmWords = normalizeText(pmStripped);

        // Find candidate dex events sharing >= MIN_SHARED_WORDS words
        const sharedCount = new Map<string, number>();
        for (const word of pmWords) {
          for (const dex of invertedIndex.get(word) ?? []) {
            sharedCount.set(dex.eventId, (sharedCount.get(dex.eventId) ?? 0) + 1);
          }
        }

        let bestSim = MATCH_THRESHOLD;
        let bestDex: DexSportsEvent | null = null;

        for (const [dexId, count] of sharedCount) {
          if (count < MIN_SHARED_WORDS) continue;
          if (usedDex.has(dexId)) continue;

          const dex = dexList.find((d) => d.eventId === dexId)!;
          const sim = computeSimilarity(pmStripped, dex.name);

          if (sim > bestSim) {
            bestSim = sim;
            bestDex = dex;
          }
        }

        if (bestDex) {
          usedDex.add(bestDex.eventId);

          const matchedMarkets = matchMarketsForPair(pm, bestDex, sportKey);

          const id = createHash('sha256')
            .update(`${pm.id}:${bestDex.eventId}`)
            .digest('hex')
            .slice(0, 16);

          pairs.push({
            id,
            sportKey,
            pmEvent: pm,
            dexEvent: bestDex,
            similarity: bestSim,
            matchedMarkets,
            matchedAt: Date.now(),
          });
        }
      }
    }

    this.logger.log(
      `SportsMatcher: ${pmEvents.length} PM + ${dexEvents.length} DEX → ${pairs.length} matched events, ` +
      `${pairs.reduce((sum, p) => sum + p.matchedMarkets.length, 0)} matched markets`,
    );

    return pairs;
  }
}
