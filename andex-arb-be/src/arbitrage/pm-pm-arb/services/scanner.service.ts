import { Injectable, Logger } from '@nestjs/common';
import { EventMatch } from '../entities/event-match.entity';
import { PlatformEvent } from '../entities/platform-event.entity';
import { Outcome } from '../entities/outcome.entity';
import { ArbitrageDetails, ArbitrageLeg } from '../interfaces/types';

/** Default minimum profit % to consider it an opportunity. Set via ARB_MIN_PROFIT_PERCENTAGE env */
const DEFAULT_MIN_PROFIT = 0.01;

/**
 * Core arbitrage detection engine.
 *
 * Generates ALL profitable platform combinations for each matched event group,
 * not just the single best one.
 *
 * For binary markets (Yes/No) with N platforms:
 *   For every pair (A, B) where A != B:
 *     - Buy Yes on A, Buy No on B
 *     - If priceA_yes + priceB_no < 1.0 → arb exists
 *   This gives up to N*(N-1) possible opportunities.
 *
 * For multi-outcome markets with N platforms and M outcomes:
 *   Generate all permutations of picking one platform per outcome.
 *   Filter to those where sum of prices < 1.0.
 *
 * This is a pure computation service — no DB access.
 */
@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);
  private readonly minProfit: number;

  constructor() {
    this.minProfit = parseFloat(process.env.ARB_MIN_PROFIT_PERCENTAGE) || DEFAULT_MIN_PROFIT;
  }

  /**
   * Scan a batch of matched events for arbitrage opportunities.
   * Returns ALL profitable combinations, not just the best.
   */
  scanMatches(matches: EventMatch[]): Map<string, ArbitrageDetails[]> {
    const results = new Map<string, ArbitrageDetails[]>();

    for (const match of matches) {
      const allDetails = this.scanAllCombinations(match);
      if (allDetails.length > 0) {
        results.set(match.id, allDetails);
      }
    }

    return results;
  }

  /**
   * Scan a single match and return ALL profitable platform combinations.
   */
  scanAllCombinations(match: EventMatch): ArbitrageDetails[] {
    const events = match.events;

    if (!events || events.length < 2) {
      return [];
    }

    const validEvents = events.filter((e) => e.outcomes && e.outcomes.length > 0);
    if (validEvents.length < 2) {
      return [];
    }

    const outcomeNames = this.collectOutcomeNames(validEvents, match.outcomeMapping);
    if (outcomeNames.size === 0) {
      return [];
    }

    // Build price table: outcomeName → [{price, outcome, event}, ...]
    const priceTable = this.buildPriceTable(validEvents, outcomeNames, match.outcomeMapping);

    const outcomeNameList = Array.from(outcomeNames);

    // Check every outcome has at least one price
    for (const name of outcomeNameList) {
      if (!priceTable.has(name) || priceTable.get(name)!.length === 0) {
        return [];
      }
    }

    // Generate all profitable combinations
    const results: ArbitrageDetails[] = [];

    if (outcomeNameList.length === 2) {
      // Binary: optimized pairwise scan
      this.scanBinaryCombinations(outcomeNameList, priceTable, match, results);
    } else {
      // Multi-outcome: generate permutations
      this.scanMultiCombinations(outcomeNameList, priceTable, match, results);
    }

    // Sort by profit DESC
    results.sort((a, b) => b.profitPercentage - a.profitPercentage);

    return results;
  }

  /**
   * For backwards compatibility — returns only the BEST opportunity.
   */
  scanSingleMatch(match: EventMatch): ArbitrageDetails | null {
    const all = this.scanAllCombinations(match);
    return all.length > 0 ? all[0] : null;
  }

  // ==================== Binary: Pairwise Combinations ====================

  /**
   * For binary markets (2 outcomes: yes/no), generate all profitable
   * cross-platform pairs: for each (platformA, platformB) where A != B,
   * check if buying outcome1 on A + outcome2 on B is profitable.
   */
  private scanBinaryCombinations(
    outcomeNames: string[],
    priceTable: Map<string, PriceEntry[]>,
    match: EventMatch,
    results: ArbitrageDetails[],
  ): void {
    const [name1, name2] = outcomeNames;
    const entries1 = priceTable.get(name1) || [];
    const entries2 = priceTable.get(name2) || [];

    // For every pair: buy outcome1 on platformA, buy outcome2 on platformB
    for (const e1 of entries1) {
      for (const e2 of entries2) {
        // Must be different platforms
        const slug1 = e1.event.platform?.slug;
        const slug2 = e2.event.platform?.slug;
        if (slug1 === slug2) continue;

        const totalCost = e1.price + e2.price;
        const guaranteedPayout = 1.0;
        const profitPercentage = ((guaranteedPayout - totalCost) / totalCost) * 100;

        if (profitPercentage < this.minProfit) continue;

        results.push({
          legs: [this.buildLeg(e1), this.buildLeg(e2)],
          totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
          guaranteedPayout,
          profitPercentage: Math.round(profitPercentage * 100) / 100,
          impliedProbabilitySum: totalCost,
        });
      }
    }
  }

  // ==================== Multi-outcome: All Permutations ====================

  /**
   * For multi-outcome markets, generate all permutations of picking
   * one platform per outcome, allowing platform reuse.
   *
   * A multi-outcome arb can use the same platform for different outcomes
   * as long as the total cost across all outcomes < 1.0 and at least
   * 2 different platforms are involved.
   */
  private scanMultiCombinations(
    outcomeNames: string[],
    priceTable: Map<string, PriceEntry[]>,
    _match: EventMatch,
    results: ArbitrageDetails[],
  ): void {
    this.scanMultiCombinationsAllowReuse(outcomeNames, priceTable, results);
  }

  /**
   * Multi-outcome with platform reuse allowed.
   * For each outcome, pick the cheapest price across all platforms.
   * Then generate variations by swapping one platform at a time.
   *
   * Simplified approach: just pick best price per outcome (may be same platform)
   * and also generate all unique platform combinations.
   */
  private scanMultiCombinationsAllowReuse(
    outcomeNames: string[],
    priceTable: Map<string, PriceEntry[]>,
    results: ArbitrageDetails[],
  ): void {
    const generate = (idx: number, currentLegs: PriceEntry[], currentCost: number) => {
      if (idx === outcomeNames.length) {
        const guaranteedPayout = 1.0;
        const profitPercentage = ((guaranteedPayout - currentCost) / currentCost) * 100;

        if (profitPercentage >= this.minProfit) {
          // Check at least 2 different platforms are involved
          const platforms = new Set(currentLegs.map((e) => e.event.platform?.slug));
          if (platforms.size < 2) return;

          results.push({
            legs: currentLegs.map((e) => this.buildLeg(e)),
            totalCost: Math.round(currentCost * 1_000_000) / 1_000_000,
            guaranteedPayout,
            profitPercentage: Math.round(profitPercentage * 100) / 100,
            impliedProbabilitySum: currentCost,
          });
        }
        return;
      }

      if (currentCost >= 1.0) return;

      const entries = priceTable.get(outcomeNames[idx]) || [];
      for (const entry of entries) {
        currentLegs.push(entry);
        generate(idx + 1, currentLegs, currentCost + entry.price);
        currentLegs.pop();
      }
    };

    generate(0, [], 0);
  }

  // ==================== Price Table ====================

  /**
   * Build a price table: outcomeName → array of {price, outcome, event}
   * for each platform that offers this outcome.
   * Sorted by price ASC (cheapest first) for pruning efficiency.
   */
  private buildPriceTable(
    events: PlatformEvent[],
    outcomeNames: Set<string>,
    outcomeMapping: Record<string, Record<string, string>>,
  ): Map<string, PriceEntry[]> {
    const table = new Map<string, PriceEntry[]>();

    for (const outcomeName of outcomeNames) {
      const entries: PriceEntry[] = [];

      for (const event of events) {
        const outcome = this.findOutcomeForEvent(event, outcomeName, outcomeMapping);
        if (!outcome) continue;

        const price = Number(outcome.price);
        if (price > 0 && price < 1) {
          entries.push({ price, outcome, event });
        }
      }

      // Sort cheapest first
      entries.sort((a, b) => a.price - b.price);
      table.set(outcomeName, entries);
    }

    return table;
  }

  // ==================== Helpers ====================

  private buildLeg(entry: PriceEntry): ArbitrageLeg {
    return {
      platformSlug: entry.event.platform?.slug || 'unknown',
      platformName: entry.event.platform?.name || 'Unknown',
      eventExternalId: entry.event.externalId,
      eventTitle: entry.event.title,
      outcomeExternalId: entry.outcome.externalId,
      outcomeName: entry.outcome.name,
      price: entry.price,
      url: entry.event.url,
      metadata: entry.outcome.metadata || undefined,
    };
  }

  /**
   * Collect all unique outcome names across events.
   */
  private collectOutcomeNames(
    events: PlatformEvent[],
    outcomeMapping: Record<string, Record<string, string>>,
  ): Set<string> {
    const names = new Set<string>();

    if (outcomeMapping && Object.keys(outcomeMapping).length > 0) {
      for (const name of Object.keys(outcomeMapping)) {
        names.add(name);
      }
      return names;
    }

    for (const event of events) {
      for (const outcome of event.outcomes || []) {
        names.add(this.normalizeOutcomeName(outcome.name));
      }
    }

    return names;
  }

  /**
   * Find the outcome in an event for a given outcome name.
   */
  private findOutcomeForEvent(
    event: PlatformEvent,
    outcomeName: string,
    outcomeMapping: Record<string, Record<string, string>>,
  ): Outcome | null {
    const platformSlug = event.platform?.slug;

    if (outcomeMapping && outcomeMapping[outcomeName] && platformSlug) {
      const mappedExternalId = outcomeMapping[outcomeName][platformSlug];
      if (mappedExternalId) {
        const found = (event.outcomes || []).find((o) => o.externalId === mappedExternalId);
        if (found) return found;
      }
    }

    return (
      (event.outcomes || []).find((o) => this.normalizeOutcomeName(o.name) === outcomeName) || null
    );
  }

  private normalizeOutcomeName(name: string): string {
    return name.toLowerCase().trim();
  }
}

/** Internal type for price entries in the price table */
interface PriceEntry {
  price: number;
  outcome: Outcome;
  event: PlatformEvent;
}
