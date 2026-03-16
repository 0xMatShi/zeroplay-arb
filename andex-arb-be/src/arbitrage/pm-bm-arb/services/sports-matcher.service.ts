import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import { PinnacleAdapter } from '../adapters/pinnacle/pinnacle.adapter';
import { StakeAdapter } from '../adapters/stake/stake.adapter';
import { CloudbetAdapter } from '../adapters/cloudbet/cloudbet.adapter';
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

/**
 * Extracts the team name with the NEGATIVE handicap from a PM spread/handicap question.
 *
 * Handles two PM question formats:
 *   - spreads:      "Spread: Iowa Hawkeyes (-1.5)"
 *   - map_handicap: "Map Handicap: UNiTY (-1.5) vs LPH Gaming (+1.5)"
 *
 * In both cases the negative team appears right after the colon and before `(-X.X)`.
 */
function extractPmNegativeTeam(question: string): string | null {
  const m = question.match(/:\s*(.+?)\s*\(-[\d.]+\)/i);
  return m ? m[1].trim() : null;
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

  // ── Fast path: adapter knows exact market type (e.g. Pinnacle, Stake) ───
  const explicitMarkets = dexMarkets.filter((d) => d.marketType !== undefined);
  if (explicitMarkets.length > 0) {
    if (type === 'child_moneyline') {
      const numMatch = pm.question.match(/(?:Map|Game)\s+(\d+)/i);
      if (!numMatch) return null;
      const n = numMatch[1];
      return explicitMarkets.find(
        (d) => d.marketType === 'child_moneyline' && d.name === `child_moneyline_map${n}`,
      ) ?? null;
    }

    const typeMatches = explicitMarkets.filter((d) => d.marketType === type);
    if (typeMatches.length === 0) return null;

    // For value-based types (totals, spreads, handicaps) compare numeric values
    // — there can be multiple lines (e.g. Total 220.5 and Total 224.5) and we need
    // the one that matches the PM question's line, not just the first by marketType.
    if (VALUE_TYPES.has(type)) {
      const pmValue = extractPmValue(pm.question);
      if (pmValue !== null) {
        const valueMatches = typeMatches.filter((dex) => {
          const dexValue = extractDexValue(dex.outcomes);
          if (dexValue === null) return false;
          if (SPREAD_TYPES.has(type)) {
            return Math.abs(Math.abs(pmValue) - Math.abs(dexValue)) < 0.01;
          }
          return Math.abs(pmValue - dexValue) < 0.01;
        });
        if (valueMatches.length === 0) return null;

        // For spread/handicap: also verify direction alignment
        if (SPREAD_TYPES.has(type)) {
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
          const pmNegNorms = [extractPmNegativeTeam(pm.question), pm.outcomeNames[0] ?? '']
            .filter(Boolean)
            .map((s) => norm(s!))
            .filter((n) => n.length > 0);

          if (pmNegNorms.length > 0) {
            const matchesNegTeam = (teamNorm: string) =>
              pmNegNorms.some((n) => teamNorm.includes(n) || n.includes(teamNorm));

            const directionMatch = valueMatches.find((dex) =>
              dex.outcomes.some((o) => {
                if (!o.name.includes('-')) return false;
                const teamNorm = norm(o.name.replace(/\s*[+-][\d.]+$/, '').trim());
                return matchesNegTeam(teamNorm);
              }),
            );
            if (directionMatch) return directionMatch;

            const invertedDirection = valueMatches.some((dex) =>
              dex.outcomes.some((o) => {
                if (!o.name.includes('+')) return false;
                const teamNorm = norm(o.name.replace(/\s*[+-][\d.]+$/, '').trim());
                return matchesNegTeam(teamNorm);
              }),
            );
            if (invertedDirection) return null;
          }
        }

        return valueMatches[0];
      }
    }

    return typeMatches[0];
  }

  // ── Name-based path: DexSport (market names come from API) ──────────────
  const sportMap = MARKET_MAP[sportKey] ?? {};
  const candidates: string[] = sportMap[type] ?? [];

  if (type === 'child_moneyline') {
    const numMatch = pm.question.match(/(?:Map|Game)\s+(\d+)/i);
    if (!numMatch) return null;
    const n = numMatch[1];
    // Exact match: "Winner. Map N" or "Winner. Game N", optionally "(With overtime)"
    // Excludes sub-markets like "Winner. Map 1. Pistol Round 1"
    const pattern = new RegExp(`^winner\\.\\s*(map|game)\\s+${n}(\\s*\\(with\\s+overtime\\))?$`, 'i');
    return dexMarkets.find((dex) => pattern.test(dex.name.trim())) ?? null;
  }

  if (candidates.length === 0) return null;

  const nameMatches = dexMarkets.filter((dex) =>
    candidates.some((c) => dexNameMatchesCandidate(dex.name, c)),
  );

  if (nameMatches.length === 0) return null;

  if (VALUE_TYPES.has(type)) {
    const pmValue = extractPmValue(pm.question);
    if (pmValue !== null) {
      const valueMatches = nameMatches.filter((dex) => {
        const dexValue = extractDexValue(dex.outcomes);
        if (dexValue === null) return false;
        if (SPREAD_TYPES.has(type)) {
          return Math.abs(Math.abs(pmValue) - Math.abs(dexValue)) < 0.01;
        }
        return Math.abs(pmValue - dexValue) < 0.01;
      });
      if (valueMatches.length === 0) return null;

      // For spread/handicap markets, verify that both platforms agree on WHICH team is the
      // favourite (i.e. has the negative sign). PM encodes this explicitly in the question:
      //   spreads:      "Spread: Iowa Hawkeyes (-1.5)"
      //   map_handicap: "Map Handicap: UNiTY (-1.5) vs LPH Gaming (+1.5)"
      // DEX encodes it in the outcome names: "Iowa Hawkeyes -1.5" / "Iowa Hawkeyes +1.5".
      if (SPREAD_TYPES.has(type)) {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Build a set of candidate norms for the PM negative team.
        // The question uses the abbreviated name (e.g. "NAVI") while outcomeNames[0] uses the
        // full name ("Natus Vincere") — we need both so DEX name matching works regardless of
        // which form DexSport uses in its outcome labels.
        const pmNegNorms = [extractPmNegativeTeam(pm.question), pm.outcomeNames[0] ?? '']
          .filter(Boolean)
          .map((s) => norm(s!))
          .filter((n) => n.length > 0);

        const matchesNegTeam = (teamNorm: string) =>
          pmNegNorms.some((n) => teamNorm.includes(n) || n.includes(teamNorm));

        if (pmNegNorms.length > 0) {
          // Find DEX market where PM's negative team also carries a NEGATIVE sign.
          const directionMatch = valueMatches.find((dex) =>
            dex.outcomes.some((o) => {
              if (!o.name.includes('-')) return false;
              const teamNorm = norm(o.name.replace(/\s*[+-][\d.]+$/, '').trim());
              return matchesNegTeam(teamNorm);
            }),
          );
          if (directionMatch) return directionMatch;

          // If PM's negative team appears with a POSITIVE sign on DEX the spread direction is
          // inverted — the platforms disagree on who the favourite is. Matching them would
          // produce false arb opportunities where both legs can lose simultaneously
          // (e.g. PM Iowa -1.5 at 45¢ + DEX Ohio State -1.5 at 53¢ = 98¢ looks profitable,
          // but both lose when Iowa wins by exactly 1 point).
          const invertedDirection = valueMatches.some((dex) =>
            dex.outcomes.some((o) => {
              if (!o.name.includes('+')) return false;
              const teamNorm = norm(o.name.replace(/\s*[+-][\d.]+$/, '').trim());
              return matchesNegTeam(teamNorm);
            }),
          );
          if (invertedDirection) return null;
        }
      }

      return valueMatches[0];
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
    private readonly pinnacleAdapter: PinnacleAdapter,
    private readonly stakeAdapter: StakeAdapter,
    private readonly cloudbetAdapter: CloudbetAdapter,
  ) {}

  findMatches(): SportsMatch[] {
    const pmEvents = this.polyAdapter.getEvents();

    const dexMatches      = this.matchBookmakerEvents(this.dexAdapter.getEvents(),      pmEvents, 'dexsport');
    const pinnacleMatches = this.matchBookmakerEvents(this.pinnacleAdapter.getEvents(), pmEvents, 'pinnacle');
    const stakeMatches    = this.matchBookmakerEvents(this.stakeAdapter.getEvents(),    pmEvents, 'stake');
    const cloudbetMatches = this.matchBookmakerEvents(this.cloudbetAdapter.getEvents(), pmEvents, 'cloudbet');

    const all = [...dexMatches, ...pinnacleMatches, ...stakeMatches, ...cloudbetMatches];
    const totalMarkets = all.reduce((s, p) => s + p.matchedMarkets.length, 0);
    this.logger.log(
      `SportsMatcher: ${pmEvents.length} PM | dexsport=${dexMatches.length} pinnacle=${pinnacleMatches.length}` +
      ` stake=${stakeMatches.length} cloudbet=${cloudbetMatches.length}` +
      ` → ${all.length} matched events, ${totalMarkets} matched markets`,
    );
    return all;
  }

  private matchBookmakerEvents(
    bmEvents: DexSportsEvent[],
    pmEvents: PmSportsEvent[],
    platform: 'dexsport' | 'pinnacle' | 'stake' | 'cloudbet',
  ): SportsMatch[] {
    // Resolve dexsport sport slugs to canonical sport keys.
    // Pinnacle and Stake already set the canonical sportKey — DEX_SLUG_TO_SPORT is a no-op for them.
    const bmMapped = bmEvents.map((e) => ({
      ...e,
      sportKey: DEX_SLUG_TO_SPORT.get(e.sportKey) ?? e.sportKey,
    }));

    const pairs: SportsMatch[] = [];

    const pmBySport = new Map<string, PmSportsEvent[]>();
    const bmBySport = new Map<string, DexSportsEvent[]>();

    for (const e of pmEvents) {
      if (!pmBySport.has(e.sportKey)) pmBySport.set(e.sportKey, []);
      pmBySport.get(e.sportKey)!.push(e);
    }
    for (const e of bmMapped) {
      if (!bmBySport.has(e.sportKey)) bmBySport.set(e.sportKey, []);
      bmBySport.get(e.sportKey)!.push(e);
    }

    for (const sportKey of Object.keys(SPORTS)) {
      const pmList = pmBySport.get(sportKey) ?? [];
      const bmList = bmBySport.get(sportKey) ?? [];

      if (pmList.length === 0 || bmList.length === 0) continue;

      // Build inverted index over bm events for quick candidate lookup
      const invertedIndex = new Map<string, DexSportsEvent[]>();
      for (const bm of bmList) {
        for (const word of normalizeText(bm.name)) {
          if (!invertedIndex.has(word)) invertedIndex.set(word, []);
          invertedIndex.get(word)!.push(bm);
        }
      }

      const usedBm = new Set<string>();

      for (const pm of pmList) {
        const pmStripped = stripPmTitle(pm.title);
        const pmWords = normalizeText(pmStripped);

        // Find candidate bm events sharing >= MIN_SHARED_WORDS words
        const sharedCount = new Map<string, number>();
        for (const word of pmWords) {
          for (const bm of invertedIndex.get(word) ?? []) {
            sharedCount.set(bm.eventId, (sharedCount.get(bm.eventId) ?? 0) + 1);
          }
        }

        let bestSim = MATCH_THRESHOLD;
        let bestBm: DexSportsEvent | null = null;

        for (const [bmId, count] of sharedCount) {
          if (count < MIN_SHARED_WORDS) continue;
          if (usedBm.has(bmId)) continue;

          const bm = bmList.find((d) => d.eventId === bmId)!;

          // Filter by startTime if both platforms have it (within 3 hours — same match)
          if (pm.startTime !== undefined && bm.startTime !== undefined && bm.startTime > 0) {
            const bmMs = bm.startTime * 1000;
            if (Math.abs(pm.startTime - bmMs) > 3 * 3_600_000) continue;
          }

          const sim = computeSimilarity(pmStripped, bm.name);
          const isBetter =
            sim > bestSim ||
            (sim === bestSim && Number(bm.eventId) > Number(bestBm?.eventId ?? '0'));
          if (isBetter) {
            bestSim = sim;
            bestBm = bm;
          }
        }

        if (bestBm) {
          usedBm.add(bestBm.eventId);
          const matchedMarkets = matchMarketsForPair(pm, bestBm, sportKey);
          const id = createHash('sha256')
            .update(`${platform}:${pm.id}:${bestBm.eventId}`)
            .digest('hex')
            .slice(0, 16);

          pairs.push({
            id,
            sportKey,
            pmEvent: pm,
            dexEvent: bestBm,
            similarity: bestSim,
            matchedMarkets,
            matchedAt: Date.now(),
            bookmakerPlatform: platform,
          });
        }
      }
    }

    return pairs;
  }
}
