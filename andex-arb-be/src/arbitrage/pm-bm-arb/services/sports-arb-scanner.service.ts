import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  SportsMatch,
  SportsArbitrageOpportunity,
  SportsArbLeg,
  MatchedMarketPair,
} from '../interfaces/sports-arb.types';

/**
 * Scans matched Polymarket ↔ DexSport event pairs for arbitrage.
 *
 * For each matched market pair (moneyline, totals, spreads, etc.):
 *   - Maps PM outcomes to DEX outcomes by name
 *   - For each outcome, picks the platform offering the lower probability
 *   - If sum of best probabilities < 1.0 → profitable arbitrage
 *
 * PM prices are probabilities (0..1), DEX prices are decimal odds.
 * Conversion: dexProbability = 1 / dexOdds
 */
@Injectable()
export class SportsArbScanner {
  private readonly logger = new Logger(SportsArbScanner.name);

  private readonly MIN_PROFIT_PCT = 0.1;

  scan(matches: SportsMatch[]): SportsArbitrageOpportunity[] {
    const opportunities: SportsArbitrageOpportunity[] = [];

    for (const match of matches) {
      for (const mp of match.matchedMarkets) {
        const opp = this.analyzeMarketPair(match, mp);
        if (opp) opportunities.push(opp);
      }
    }

    if (opportunities.length > 0) {
      this.logger.log(
        `SportsArbScanner: ${opportunities.length} opportunities found`,
      );
      for (const opp of opportunities) {
        this.logger.log(
          `  ARB ${opp.sportKey.toUpperCase()} [${opp.marketType}] "${opp.eventName}": ` +
          `profit=${opp.profitPercent.toFixed(2)}% totalCost=${(opp.totalCost * 100).toFixed(1)}%`,
        );
      }
    }

    return opportunities;
  }

  private analyzeMarketPair(
    match: SportsMatch,
    mp: MatchedMarketPair,
  ): SportsArbitrageOpportunity | null {
    const { pmMarket, dexMarket } = mp;

    // PM outcomes: names + probabilities
    const pmOutcomes = pmMarket.outcomeNames.map((name, i) => ({
      name,
      probability: pmMarket.outcomePrices[i] ?? 0,
    }));

    // DEX outcomes: names + decimal odds → probability
    const dexOutcomes = dexMarket.outcomes.map((o) => ({
      name: o.name,
      probability: o.price > 0 ? 1 / o.price : 0,
      decimalOdds: o.price,
    }));

    if (pmOutcomes.length < 2 || dexOutcomes.length < 2) return null;

    // Map PM outcomes to DEX outcomes by name
    const legs: SportsArbLeg[] = [];
    let totalCost = 0;

    for (const pmOut of pmOutcomes) {
      const dexOut = this.findMatchingOutcome(pmOut.name, dexOutcomes);
      if (!dexOut) return null; // can't pair → skip entire market

      const pmProb = pmOut.probability;
      const dexProb = dexOut.probability;

      // Pick the cheaper platform (lower probability = better odds)
      if (pmProb <= dexProb) {
        legs.push({
          platform: 'polymarket',
          outcomeName: pmOut.name,
          probability: pmProb,
          decimalOdds: pmProb > 0 ? 1 / pmProb : 0,
        });
        totalCost += pmProb;
      } else {
        legs.push({
          platform: 'dexsport',
          outcomeName: dexOut.name,
          probability: dexProb,
          decimalOdds: dexOut.decimalOdds,
        });
        totalCost += dexProb;
      }
    }

    if (legs.length < 2) return null;

    const profitPercent = totalCost < 1
      ? ((1 - totalCost) / totalCost) * 100
      : 0;

    if (profitPercent < this.MIN_PROFIT_PCT) return null;

    const id = createHash('sha256')
      .update(`arb:${match.id}:${mp.pmType}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);

    return {
      id,
      matchId: match.id,
      sportKey: match.sportKey,
      eventName: match.dexEvent.name || match.pmEvent.title,
      marketType: mp.pmType,
      pmQuestion: mp.pmMarket.question,
      dexMarketName: mp.dexMarket.name,
      legs,
      totalCost,
      profitPercent,
      detectedAt: Date.now(),
    };
  }

  /**
   * Find a DEX outcome that matches a PM outcome by name.
   * Uses normalized substring matching.
   */
  private findMatchingOutcome(
    pmName: string,
    dexOutcomes: Array<{ name: string; probability: number; decimalOdds: number }>,
  ): { name: string; probability: number; decimalOdds: number } | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const pmNorm = norm(pmName);

    // Exact normalized match
    const exact = dexOutcomes.find((d) => norm(d.name) === pmNorm);
    if (exact) return exact;

    // Substring match (handles "MOUZ" in "MOUZ Gaming", "Over" in "Over 132.5")
    const substr = dexOutcomes.find((d) => {
      const dn = norm(d.name);
      return dn.includes(pmNorm) || pmNorm.includes(dn);
    });
    if (substr) return substr;

    // Positional fallback for 2-way markets (Yes/No ↔ Over/Under, Home/Away)
    // PM "Yes" = first outcome, DEX first outcome
    if (dexOutcomes.length === 2) {
      const pmLower = pmName.toLowerCase();
      if (pmLower === 'yes' || pmLower === 'over') return dexOutcomes[0];
      if (pmLower === 'no' || pmLower === 'under') return dexOutcomes[1];
    }

    return null;
  }
}
