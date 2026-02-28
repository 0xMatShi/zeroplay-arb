import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { PlatformEvent } from '../entities/platform-event.entity';
import { EventMatch } from '../entities/event-match.entity';
import { VerifiedMatch } from '../entities/verified-match.entity';
import { EventStatus, MatchStatus, MatchMethod, VerificationSource } from '../interfaces/types';

/** Minimum similarity score to auto-create a match */
const DEFAULT_MATCH_THRESHOLD = 0.15;

/** Pre-filter: max days difference in end dates */
const MAX_END_DATE_DIFF_DAYS = 30;

/** Minimum shared keywords to even consider a pair as candidate */
const MIN_SHARED_KEYWORDS = 2;

interface MatchCandidate {
  event1: PlatformEvent;
  event2: PlatformEvent;
  similarity: number;
}

/** Lightweight event for indexing (no outcomes, no rawData) */
interface IndexedEvent {
  id: string;
  platformSlug: string;
  title: string;
  endDate: Date | null;
  words: string[]; // pre-computed normalized words
}

/**
 * Matches events from different platforms that represent the same real-world event.
 *
 * PAIR-ONLY MATCHING: Every EventMatch contains exactly 2 events.
 * An event can appear in multiple matches (e.g. A↔B and A↔C simultaneously).
 * No N-way expansion — this prevents false positives from transitive matches.
 *
 * Strategy (inverted index):
 * 1. Normalize titles, extract keywords for ALL active events
 * 2. Build inverted index: keyword -> events from each platform
 * 3. Only compare cross-platform pairs that share >= MIN_SHARED_KEYWORDS
 * 4. Skip pairs that already exist in a non-rejected match
 * 5. Create new pair matches for candidates above threshold
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly matchThreshold: number;

  /** Words that don't carry matching information */
  private readonly stopWords = new Set([
    'will',
    'the',
    'a',
    'an',
    'be',
    'is',
    'are',
    'was',
    'were',
    'to',
    'of',
    'in',
    'for',
    'on',
    'at',
    'by',
    'with',
    'from',
    'that',
    'this',
    'it',
    'its',
    'as',
    'or',
    'and',
    'but',
    'if',
    'do',
    'does',
    'did',
    'has',
    'have',
    'had',
    'not',
    'no',
    'yes',
    'what',
    'who',
    'when',
    'where',
    'how',
    'which',
    'than',
    'then',
    'before',
    'after',
    'above',
    'below',
    'between',
    'during',
    'about',
    'into',
    'through',
    'over',
    'under',
    'again',
    'further',
    'once',
    'market',
    'close',
    'price',
    'end',
    'day',
    'month',
    'year',
  ]);

  constructor(
    @InjectRepository(PlatformEvent)
    private readonly eventRepo: Repository<PlatformEvent>,
    @InjectRepository(EventMatch)
    private readonly matchRepo: Repository<EventMatch>,
    @InjectRepository(VerifiedMatch)
    private readonly verifiedMatchRepo: Repository<VerifiedMatch>,
  ) {
    this.matchThreshold =
      parseFloat(process.env.MATCH_CONFIDENCE_THRESHOLD) || DEFAULT_MATCH_THRESHOLD;
  }

  /**
   * Find new event pairs across platforms and create EventMatch records.
   *
   * Pair-only matching: every EventMatch contains exactly 2 events.
   * An event can appear in multiple matches simultaneously (A↔B and A↔C).
   */
  async matchNewEvents(): Promise<number> {
    const startTime = Date.now();

    // 1. Load ALL active events (lightweight — no outcomes)
    const allEvents = await this.eventRepo
      .createQueryBuilder('e')
      .select(['e.id', 'e.title', 'e.endDate', 'e.platformId'])
      .innerJoin('e.platform', 'p')
      .addSelect(['p.slug'])
      .where('e.status = :status', { status: EventStatus.ACTIVE })
      .getMany();

    this.logger.log(`Loaded ${allEvents.length} active events for matching`);

    // 2. Load all existing non-rejected pairs to avoid duplicates
    const existingPairs = await this.loadExistingPairs();

    // 3. Index all events
    const allIndexedEvents: IndexedEvent[] = [];

    for (const event of allEvents) {
      allIndexedEvents.push({
        id: event.id,
        platformSlug: event.platform?.slug || event.platformId,
        title: event.title,
        endDate: event.endDate,
        words: this.normalizeText(event.title),
      });
    }

    // Check we have events from 2+ platforms total
    const platforms = new Set(allIndexedEvents.map((e) => e.platformSlug));
    if (platforms.size < 2) {
      this.logger.debug('Events from fewer than 2 platforms, nothing to match');
      return 0;
    }

    // 4. Build inverted index over ALL events
    const invertedIndex = new Map<string, IndexedEvent[]>();
    for (const event of allIndexedEvents) {
      for (const word of event.words) {
        if (!invertedIndex.has(word)) {
          invertedIndex.set(word, []);
        }
        invertedIndex.get(word)!.push(event);
      }
    }

    // 5. Generate cross-platform candidate pairs, skipping already-existing ones
    const pairScores = new Map<
      string,
      { e1: IndexedEvent; e2: IndexedEvent; sharedCount: number }
    >();

    for (const [, events] of invertedIndex) {
      const byPlatform = new Map<string, IndexedEvent[]>();
      for (const event of events) {
        if (!byPlatform.has(event.platformSlug)) {
          byPlatform.set(event.platformSlug, []);
        }
        byPlatform.get(event.platformSlug)!.push(event);
      }

      const slugs = Array.from(byPlatform.keys());
      for (let i = 0; i < slugs.length; i++) {
        for (let j = i + 1; j < slugs.length; j++) {
          const list1 = byPlatform.get(slugs[i])!;
          const list2 = byPlatform.get(slugs[j])!;

          if (list1.length > 2000 || list2.length > 2000) continue;

          for (const e1 of list1) {
            for (const e2 of list2) {
              const pairKey = e1.id < e2.id ? `${e1.id}:${e2.id}` : `${e2.id}:${e1.id}`;

              // Skip pairs that already have a non-rejected match
              if (existingPairs.has(pairKey)) continue;

              const existing = pairScores.get(pairKey);
              if (existing) {
                existing.sharedCount++;
              } else {
                pairScores.set(pairKey, { e1, e2, sharedCount: 1 });
              }
            }
          }
        }
      }
    }

    // 6. Filter candidates, compute full similarity
    const newPairCandidates: MatchCandidate[] = [];
    const nearMisses: { title1: string; title2: string; sim: number }[] = [];
    let pairsChecked = 0;

    const candidateEventIds = new Set<string>();

    for (const [, { e1, e2, sharedCount }] of pairScores) {
      if (sharedCount < MIN_SHARED_KEYWORDS) continue;
      if (!this.datesCompatible(e1.endDate, e2.endDate)) continue;

      pairsChecked++;
      const similarity = this.computeSimilarity(e1.title, e2.title);

      if (similarity < this.matchThreshold) {
        if (similarity >= 0.1) {
          nearMisses.push({ title1: e1.title, title2: e2.title, sim: similarity });
        }
        continue;
      }

      newPairCandidates.push({
        event1: { id: e1.id, title: e1.title } as PlatformEvent,
        event2: { id: e2.id, title: e2.title } as PlatformEvent,
        similarity,
      });
      candidateEventIds.add(e1.id);
      candidateEventIds.add(e2.id);
    }

    nearMisses.sort((a, b) => b.sim - a.sim);

    const indexTime = Date.now() - startTime;
    this.logger.log(
      `Inverted index: ${pairScores.size} candidate pairs, ${pairsChecked} checked, ` +
        `${newPairCandidates.length} new pairs, ${nearMisses.length} near-misses (${indexTime}ms)`,
    );

    if (nearMisses.length > 0) {
      const top = nearMisses.slice(0, 10);
      for (const nm of top) {
        this.logger.log(
          `  Near miss (${(nm.sim * 100).toFixed(1)}%): "${nm.title1}" <-> "${nm.title2}"`,
        );
      }
    }

    if (newPairCandidates.length === 0) return 0;

    // 7. Load full events with outcomes for all candidates
    const fullEvents = await this.eventRepo.find({
      where: { id: In(Array.from(candidateEventIds)) },
      relations: ['platform', 'outcomes'],
    });
    const fullEventMap = new Map(fullEvents.map((e) => [e.id, e]));

    // Replace lightweight refs with full events
    for (const candidate of newPairCandidates) {
      candidate.event1 = fullEventMap.get(candidate.event1.id) || candidate.event1;
      candidate.event2 = fullEventMap.get(candidate.event2.id) || candidate.event2;
    }

    // 8. Create new pair matches
    const totalChanges = await this.createMatches(newPairCandidates);

    const totalTime = Date.now() - startTime;
    this.logger.log(`Matching complete: ${totalChanges} new pairs in ${totalTime}ms`);

    return totalChanges;
  }

  /**
   * Load all existing non-rejected pairs as canonical "id1:id2" keys (id1 < id2).
   * Used to skip re-creating matches that already exist.
   */
  private async loadExistingPairs(): Promise<Set<string>> {
    const rows: { eventId1: string; eventId2: string }[] = await this.matchRepo.query(
      `SELECT
         LEAST(eme1."platformEventId", eme2."platformEventId") as "eventId1",
         GREATEST(eme1."platformEventId", eme2."platformEventId") as "eventId2"
       FROM event_matches em
       INNER JOIN event_match_events eme1 ON eme1."eventMatchId" = em.id
       INNER JOIN event_match_events eme2 ON eme2."eventMatchId" = em.id
         AND eme2."platformEventId" > eme1."platformEventId"
       WHERE em.status != $1`,
      [MatchStatus.REJECTED],
    );

    const pairs = new Set<string>();
    for (const row of rows) {
      pairs.add(`${row.eventId1}:${row.eventId2}`);
    }
    return pairs;
  }

  /**
   * Create EventMatch records from pair candidates.
   * Each candidate becomes its own 2-event match.
   * An event may appear in multiple matches (A↔B and A↔C are separate records).
   */
  private async createMatches(candidates: MatchCandidate[]): Promise<number> {
    candidates.sort((a, b) => b.similarity - a.similarity);

    let created = 0;

    for (const candidate of candidates) {
      const { event1, event2, similarity } = candidate;

      try {
        const outcomeMapping = this.buildOutcomeMapping([event1, event2]);

        const match = this.matchRepo.create({
          title: event1.title,
          matchMethod: MatchMethod.AUTO,
          confidence: similarity,
          status: MatchStatus.PENDING,
          events: [event1, event2],
          outcomeMapping,
        });

        await this.matchRepo.save(match);
        created++;

        this.logger.log(
          `NEW Match (${(similarity * 100).toFixed(1)}%): "${event1.title}" <-> "${event2.title}"`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to create match: "${event1.title}" <-> "${event2.title}": ${error.message}`,
        );
      }
    }

    return created;
  }

  // ==================== Text Similarity ====================

  /**
   * Compute similarity between two event titles.
   */
  computeSimilarity(title1: string, title2: string): number {
    const words1 = this.normalizeText(title1);
    const words2 = this.normalizeText(title2);

    if (words1.length === 0 || words2.length === 0) return 0;

    const jaccard = this.jaccardSimilarity(words1, words2);

    // Anagram detection: same word set but different original titles.
    // These are likely opposite outcomes of the same event (e.g. "R Senate, D House" vs "D Senate, R House").
    // Force AI verification by returning a score below the auto-confirm threshold.
    if (jaccard === 1.0 && title1.toLowerCase().trim() !== title2.toLowerCase().trim()) {
      return 0.89;
    }

    const orderSim = this.wordOrderSimilarity(words1, words2);

    return jaccard * 0.8 + orderSim * 0.2;
  }

  /**
   * Normalize text: lowercase -> remove punctuation -> remove stop words -> stem
   */
  private normalizeText(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !this.stopWords.has(word))
      .map((word) => this.stemWord(word));
  }

  private stemWord(word: string): string {
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
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
      return word.slice(0, -1);
    }
    return word;
  }

  private jaccardSimilarity(words1: string[], words2: string[]): number {
    const set1 = new Set(words1);
    const set2 = new Set(words2);

    let intersection = 0;
    for (const word of set1) {
      if (set2.has(word)) intersection++;
    }

    const union = set1.size + set2.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
  }

  private wordOrderSimilarity(words1: string[], words2: string[]): number {
    const commonWords = words1.filter((w) => words2.includes(w));
    if (commonWords.length === 0) return 0;

    let orderScore = 0;
    for (const word of commonWords) {
      const pos1 = words1.indexOf(word) / words1.length;
      const pos2 = words2.indexOf(word) / words2.length;
      orderScore += 1 - Math.abs(pos1 - pos2);
    }

    return orderScore / commonWords.length;
  }

  // ==================== Helpers ====================

  private datesCompatible(date1: Date | null, date2: Date | null): boolean {
    if (!date1 || !date2) return true;
    const diffMs = Math.abs(date1.getTime() - date2.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= MAX_END_DATE_DIFF_DAYS;
  }

  /**
   * Build outcome mapping across ALL events in a match.
   * Supports 2, 3, 4, or more events from different platforms.
   *
   * Format: { "yes": { "polymarket": "outcome-id-1", "kalshi": "outcome-id-2", "opinion": "outcome-id-3" } }
   */
  private buildOutcomeMapping(events: PlatformEvent[]): Record<string, Record<string, string>> {
    // Collect all unique outcome names (normalized) across all events
    const outcomeNameSet = new Set<string>();
    for (const event of events) {
      for (const outcome of event.outcomes || []) {
        outcomeNameSet.add(outcome.name.toLowerCase().trim());
      }
    }

    const mapping: Record<string, Record<string, string>> = {};

    for (const outcomeName of outcomeNameSet) {
      const platformMap: Record<string, string> = {};

      for (const event of events) {
        const slug = event.platform?.slug || 'unknown';
        const matched = (event.outcomes || []).find(
          (o) => o.name.toLowerCase().trim() === outcomeName,
        );
        if (matched) {
          platformMap[slug] = matched.externalId;
        }
      }

      // Only include if at least 2 platforms have this outcome
      if (Object.keys(platformMap).length >= 2) {
        mapping[outcomeName] = platformMap;
      }
    }

    return mapping;
  }

  // ==================== Public Query Methods ====================

  /**
   * Get matches suitable for arbitrage scanning.
   *
   * Reads ONLY from verified_matches — the table of fully-confirmed matches.
   * No fallback on high-confidence PENDING matches.
   */
  async getScannableMatches(): Promise<EventMatch[]> {
    const verified = await this.verifiedMatchRepo.find({
      relations: [
        'eventMatch',
        'eventMatch.events',
        'eventMatch.events.outcomes',
        'eventMatch.events.platform',
      ],
    });

    return verified.map((v) => v.eventMatch).filter((m) => m != null);
  }

  /**
   * Seed verified_matches from all existing CONFIRMED event_matches.
   * Run once on startup to backfill historical data.
   */
  async seedVerifiedMatches(): Promise<void> {
    const confirmed = await this.matchRepo.find({
      where: { status: MatchStatus.CONFIRMED },
    });

    for (const match of confirmed) {
      const source =
        match.matchMethod === MatchMethod.AI ? VerificationSource.AI : VerificationSource.AUTO;
      await this.verifiedMatchRepo.upsert(
        {
          eventMatchId: match.id,
          verificationSource: source,
          confidence: Number(match.confidence),
        },
        ['eventMatchId'],
      );
    }

    this.logger.log(`Seeded ${confirmed.length} verified matches from existing CONFIRMED event_matches`);
  }

  /**
   * Get all confirmed matches (for arbitrage scanning).
   * @deprecated Use getScannableMatches() instead for broader coverage.
   */
  async getConfirmedMatches(): Promise<EventMatch[]> {
    return this.matchRepo.find({
      where: { status: MatchStatus.CONFIRMED },
      relations: ['events', 'events.outcomes', 'events.platform'],
    });
  }

  /**
   * Get all non-rejected matches (for display purposes — includes pending).
   */
  async getActiveMatches(): Promise<EventMatch[]> {
    return this.matchRepo.find({
      where: [{ status: MatchStatus.CONFIRMED }, { status: MatchStatus.PENDING }],
      relations: ['events', 'events.outcomes', 'events.platform'],
    });
  }

  /**
   * Manually confirm or reject a match.
   * Syncs verified_matches accordingly.
   */
  async updateMatchStatus(matchId: string, status: MatchStatus): Promise<EventMatch> {
    const match = await this.matchRepo.findOne({ where: { id: matchId } });
    if (!match) throw new Error(`Match ${matchId} not found`);

    match.status = status;
    const saved = await this.matchRepo.save(match);

    if (status === MatchStatus.CONFIRMED) {
      await this.verifiedMatchRepo.upsert(
        {
          eventMatchId: matchId,
          verificationSource: VerificationSource.MANUAL,
          confidence: Number(match.confidence),
        },
        ['eventMatchId'],
      );
    } else if (status === MatchStatus.REJECTED) {
      await this.verifiedMatchRepo.delete({ eventMatchId: matchId });
    }

    return saved;
  }
}
