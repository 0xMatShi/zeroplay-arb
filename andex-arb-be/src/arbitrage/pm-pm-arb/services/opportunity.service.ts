import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArbitrageOpportunity } from '../entities/arbitrage-opportunity.entity';
import { EventMatch } from '../entities/event-match.entity';
import { ScannerService } from './scanner.service';
import { MatchingService } from './matching.service';
import {
  OpportunityStatus,
  ArbitrageDetails,
  ArbitrageLeg,
  OutcomeType,
} from '../interfaces/types';

/**
 * Manages arbitrage opportunities lifecycle:
 * - Create new opportunities from scanner results
 * - Revalidate existing active opportunities
 * - Mark expired opportunities
 * - CRUD for API layer
 */
@Injectable()
export class OpportunityService {
  private readonly logger = new Logger(OpportunityService.name);

  constructor(
    @InjectRepository(ArbitrageOpportunity)
    private readonly opportunityRepo: Repository<ArbitrageOpportunity>,
    private readonly scannerService: ScannerService,
    private readonly matchingService: MatchingService,
  ) {}

  /**
   * Run a full scan cycle:
   * 1. Get all active matches
   * 2. Scan each for ALL profitable platform combinations
   * 3. Create new / update existing opportunities
   * Returns new opportunity IDs.
   */
  async runScanCycle(): Promise<string[]> {
    const matches = await this.matchingService.getScannableMatches();

    if (matches.length === 0) {
      return [];
    }

    const scanResults = this.scannerService.scanMatches(matches);
    const newIds: string[] = [];

    // scanResults is Map<matchId, ArbitrageDetails[]> — ALL combos per match
    let totalCombos = 0;
    for (const [matchId, detailsList] of scanResults) {
      const match = matches.find((m) => m.id === matchId);
      if (!match) continue;

      totalCombos += detailsList.length;

      for (const details of detailsList) {
        const id = await this.upsertOpportunity(match, details);
        if (id) newIds.push(id);
      }
    }

    // Mark opportunities as expired if their match no longer shows arb
    await this.expireStaleOpportunities(scanResults);

    this.logger.log(
      `Scan cycle complete: ${scanResults.size} matches with arb, ` +
        `${totalCombos} total combos, ${newIds.length} new opportunities`,
    );

    return newIds;
  }

  /**
   * Revalidate all active opportunities.
   * Re-checks current prices and expires opportunities that no longer exist.
   * Returns expired IDs and updated opportunities separately.
   */
  async revalidateActive(): Promise<{ expiredIds: string[]; updatedOpps: ArbitrageOpportunity[] }> {
    const refreshedOpps = await this.opportunityRepo.find({
      where: { status: OpportunityStatus.ACTIVE },
      relations: [
        'eventMatch',
        'eventMatch.events',
        'eventMatch.events.outcomes',
        'eventMatch.events.platform',
      ],
    });

    if (refreshedOpps.length === 0) return { expiredIds: [], updatedOpps: [] };

    const expiredIds: string[] = [];
    const updatedOpps: ArbitrageOpportunity[] = [];
    const now = new Date();

    // Group opportunities by match to avoid scanning the same match multiple times
    const oppsByMatch = new Map<string, ArbitrageOpportunity[]>();
    for (const opp of refreshedOpps) {
      if (!opp.eventMatch) {
        await this.expireOpportunity(opp, now);
        expiredIds.push(opp.id);
        continue;
      }
      const matchId = opp.eventMatch.id;
      if (!oppsByMatch.has(matchId)) {
        oppsByMatch.set(matchId, []);
      }
      oppsByMatch.get(matchId)!.push(opp);
    }

    for (const [, opps] of oppsByMatch) {
      const match = opps[0].eventMatch;
      if (!match) continue;

      // Scan ALL combinations for this match
      const allDetails = this.scannerService.scanAllCombinations(match);

      // Build fingerprint→details map for fast lookup
      const matchTitle = match.title || '';
      const detailsByFp = new Map<string, ArbitrageDetails>();
      for (const details of allDetails) {
        const fp = this.computeLegsFingerprint(details.legs, matchTitle);
        detailsByFp.set(fp, details);
      }

      // Check each opportunity against the fresh scan
      for (const opp of opps) {
        const matchTitle = match.title || '';
        const oppFp = this.computeLegsFingerprint(opp.legs, matchTitle);
        const freshDetails = detailsByFp.get(oppFp);

        if (!freshDetails) {
          // This specific combo no longer profitable
          await this.expireOpportunity(opp, now);
          expiredIds.push(opp.id);
          this.logger.log(`Opportunity expired: ${opp.id} for "${match.title}"`);
        } else {
          // Update with latest numbers
          const prevProfit = opp.profitPercentage;
          const prevLegsJson = JSON.stringify(opp.legs);
          opp.profitPercentage = freshDetails.profitPercentage;
          opp.totalCost = freshDetails.totalCost;
          opp.legs = freshDetails.legs;
          opp.lastValidatedAt = now;
          await this.opportunityRepo.save(opp);
          // Track as updated if numbers actually changed
          if (
            Number(prevProfit) !== Number(freshDetails.profitPercentage) ||
            prevLegsJson !== JSON.stringify(freshDetails.legs)
          ) {
            updatedOpps.push(opp);
          }
        }
      }
    }

    if (expiredIds.length > 0 || updatedOpps.length > 0) {
      this.logger.log(
        `Revalidation: ${expiredIds.length}/${refreshedOpps.length} expired, ` +
          `${updatedOpps.length} updated`,
      );
    }

    return { expiredIds, updatedOpps };
  }

  // ==================== CRUD ====================

  /**
   * Refresh prices from platform APIs, then revalidate and return active opportunities.
   * Combines revalidation + getActive for a guaranteed fresh response.
   */
  async refreshAndGetActive(
    limit = 50,
    offset = 0,
  ): Promise<{ items: ArbitrageOpportunity[]; total: number }> {
    await this.revalidateActive(); // return value intentionally ignored here
    return this.getActive(limit, offset);
  }

  /**
   * Get all active opportunities, deduplicated, highest profit first.
   *
   * Deduplication: if the same real-world event was matched multiple times
   * (different externalIds for the same question), we only return one
   * opportunity per unique platform+outcome combination.
   */
  async getActive(
    limit = 50,
    offset = 0,
  ): Promise<{ items: ArbitrageOpportunity[]; total: number }> {
    // Fetch more than requested to account for duplicates being removed
    const [allItems] = await this.opportunityRepo.findAndCount({
      where: { status: OpportunityStatus.ACTIVE },
      order: { profitPercentage: 'DESC' },
      relations: ['eventMatch'],
    });

    const deduplicated = this.deduplicateOpportunities(allItems);
    const total = deduplicated.length;
    const items = deduplicated.slice(offset, offset + limit);

    return { items, total };
  }

  /**
   * Get opportunity history (all statuses).
   */
  async getHistory(
    limit = 50,
    offset = 0,
    status?: OpportunityStatus,
  ): Promise<{ items: ArbitrageOpportunity[]; total: number }> {
    const where = status ? { status } : {};
    const [items, total] = await this.opportunityRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
      relations: ['eventMatch'],
    });

    return { items, total };
  }

  /**
   * Get a single opportunity by ID.
   */
  async getById(id: string): Promise<ArbitrageOpportunity | null> {
    return this.opportunityRepo.findOne({
      where: { id },
      relations: [
        'eventMatch',
        'eventMatch.events',
        'eventMatch.events.outcomes',
        'eventMatch.events.platform',
      ],
    });
  }

  /**
   * Get summary stats.
   */
  async getStats(): Promise<{
    activeCount: number;
    avgProfit: number;
    maxProfit: number;
    totalFound: number;
  }> {
    const active = await this.opportunityRepo.count({
      where: { status: OpportunityStatus.ACTIVE },
    });

    const stats = await this.opportunityRepo
      .createQueryBuilder('opp')
      .select('COUNT(*)', 'total')
      .addSelect('AVG(opp.profitPercentage)', 'avg')
      .addSelect('MAX(opp.profitPercentage)', 'max')
      .where('opp.status = :status', { status: OpportunityStatus.ACTIVE })
      .getRawOne();

    return {
      activeCount: active,
      avgProfit: parseFloat(stats?.avg) || 0,
      maxProfit: parseFloat(stats?.max) || 0,
      totalFound: parseInt(stats?.total) || 0,
    };
  }

  /**
   * Cache orderbook-derived metrics on the opportunity.
   * Called by OrderBookService after computing tiers.
   */
  async updateOrderBookMetrics(
    id: string,
    weightedAvgProfit: number,
    totalGrossProfit: number,
    totalInvestment: number,
    totalShares: number,
  ): Promise<void> {
    await this.opportunityRepo.update(id, { weightedAvgProfit, totalGrossProfit, totalInvestment, totalShares });
  }

  // ==================== Internal ====================

  /**
   * Create or update an opportunity for a specific platform combination.
   *
   * Uses fingerprint-based matching: each unique combo of
   * (match title + platform slugs + outcome names) gets its own opportunity.
   * This supports multiple opportunities per EventMatch (different platform pairs).
   */
  private async upsertOpportunity(
    match: EventMatch,
    details: ArbitrageDetails,
  ): Promise<string | null> {
    const now = new Date();
    const fingerprint = this.computeLegsFingerprint(details.legs, match.title);

    // Find existing opportunity by fingerprint (not just matchId!)
    const existing = await this.findByFingerprint(fingerprint);

    if (existing) {
      // Update existing with latest prices
      existing.profitPercentage = details.profitPercentage;
      existing.totalCost = details.totalCost;
      existing.legs = details.legs;
      existing.lastValidatedAt = now;
      await this.opportunityRepo.save(existing);
      return null; // Not new
    }

    // Create new
    const opportunity = this.opportunityRepo.create({
      eventMatchId: match.id,
      type: details.legs.length === 2 ? OutcomeType.BINARY : OutcomeType.MULTI,
      profitPercentage: details.profitPercentage,
      totalCost: details.totalCost,
      guaranteedPayout: details.guaranteedPayout,
      legs: details.legs,
      status: OpportunityStatus.ACTIVE,
      foundAt: now,
      lastValidatedAt: now,
    });

    const saved = await this.opportunityRepo.save(opportunity);
    return saved.id;
  }

  /**
   * Expire opportunities whose specific platform combination no longer shows arb.
   *
   * Now that we have multiple combos per match, we need to check each
   * opportunity's fingerprint against the current scan results.
   */
  private async expireStaleOpportunities(
    currentArbs: Map<string, ArbitrageDetails[]>,
  ): Promise<void> {
    const activeOpps = await this.opportunityRepo.find({
      where: { status: OpportunityStatus.ACTIVE },
      relations: ['eventMatch'],
    });

    // Build a set of all current fingerprints — use match title for consistency
    const currentFingerprints = new Set<string>();
    for (const [matchId, detailsList] of currentArbs) {
      // Find the match title to use the SAME title as upsertOpportunity used
      const matchTitle =
        activeOpps.find((o) => o.eventMatchId === matchId)?.eventMatch?.title || '';

      for (const details of detailsList) {
        const fp = this.computeLegsFingerprint(details.legs, matchTitle);
        currentFingerprints.add(fp);
      }
    }

    const now = new Date();

    for (const opp of activeOpps) {
      const matchTitle = opp.eventMatch?.title || '';
      const oppFp = this.computeLegsFingerprint(opp.legs, matchTitle);

      if (!currentFingerprints.has(oppFp)) {
        await this.expireOpportunity(opp, now);
      }
    }
  }

  /**
   * Mark an opportunity as expired.
   */
  private async expireOpportunity(opp: ArbitrageOpportunity, now: Date): Promise<void> {
    opp.status = OpportunityStatus.EXPIRED;
    opp.expiredAt = now;
    opp.lastValidatedAt = now;
    await this.opportunityRepo.save(opp);
  }

  // ==================== Deduplication ====================

  /**
   * Normalize a title for fingerprint comparison.
   * Lowercase, remove punctuation, collapse whitespace, sort words.
   * This handles minor variations like "Will X happen?" vs "will x happen"
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Compute a stable fingerprint that uniquely identifies an arbitrage trade.
   *
   * Includes BOTH the normalized event title AND the platform+outcome pairs.
   * This way:
   * - Same event matched twice (different IDs) → same fingerprint → deduped
   * - Different events on the same platforms → different fingerprint → kept
   *
   * @param legs       The arbitrage legs
   * @param matchTitle Optional match-level title (used in upsert context).
   *                   If not provided, falls back to first leg's eventTitle.
   */
  private computeLegsFingerprint(legs: ArbitrageLeg[], matchTitle?: string): string {
    const title = matchTitle || legs[0]?.eventTitle || '';
    const normalizedTitle = this.normalizeTitle(title);

    const legsKey = legs
      .map((leg) => `${leg.platformSlug}:${leg.outcomeName.toLowerCase().trim()}`)
      .sort()
      .join('|');

    return `${normalizedTitle}::${legsKey}`;
  }

  /**
   * Find an existing active opportunity with the same legs fingerprint.
   */
  private async findByFingerprint(fingerprint: string): Promise<ArbitrageOpportunity | null> {
    const activeOpps = await this.opportunityRepo.find({
      where: { status: OpportunityStatus.ACTIVE },
      relations: ['eventMatch'],
    });

    for (const opp of activeOpps) {
      const oppTitle = opp.eventMatch?.title || '';
      if (this.computeLegsFingerprint(opp.legs, oppTitle) === fingerprint) {
        return opp;
      }
    }

    return null;
  }

  /**
   * Deduplicate a list of opportunities by legs fingerprint.
   * Keeps the one with the highest profit for each fingerprint.
   * Expects items to have eventMatch relation loaded.
   */
  private deduplicateOpportunities(items: ArbitrageOpportunity[]): ArbitrageOpportunity[] {
    const seen = new Map<string, ArbitrageOpportunity>();

    for (const opp of items) {
      const title = opp.eventMatch?.title || '';
      const fp = this.computeLegsFingerprint(opp.legs, title);
      const existing = seen.get(fp);

      if (!existing || Number(opp.profitPercentage) > Number(existing.profitPercentage)) {
        seen.set(fp, opp);
      }
    }

    return Array.from(seen.values());
  }
}
