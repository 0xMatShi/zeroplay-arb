import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  SportsMatch,
  SportsArbitrageOpportunity,
  SportsArbLeg,
} from '../interfaces/sports-arb.types';

/**
 * Scans matched Polymarket ↔ DexSport event pairs for arbitrage.
 *
 * Strategy (moneyline, 2-way or 3-way):
 *   For each outcome, pick the platform offering the LOWER probability
 *   (= higher decimal odds = better value).
 *   If sum of best probabilities < 1.0 → profitable arbitrage exists.
 *
 * Note: DexSport has overround (~106-110%), so it will rarely be cheaper than
 * Polymarket (which sums to ~100%). Arb appears when Polymarket mis-prices one
 * outcome significantly above the DexSport line.
 */
@Injectable()
export class SportsArbScanner {
  private readonly logger = new Logger(SportsArbScanner.name);

  /** Minimum profit % to report (avoid noise from rounding) */
  private readonly MIN_PROFIT_PCT = 0.1;

  scan(matches: SportsMatch[]): SportsArbitrageOpportunity[] {
    const opportunities: SportsArbitrageOpportunity[] = [];

    for (const match of matches) {
      const opp = this.analyzeMatch(match);
      if (opp) opportunities.push(opp);
    }

    if (opportunities.length > 0) {
      this.logger.log(
        `SportsArbScanner: ${opportunities.length} opportunities found in ${matches.length} matches`,
      );
      for (const opp of opportunities) {
        this.logger.log(
          `  ARB ${opp.sport.toUpperCase()} "${opp.eventName}": ` +
          `profit=${opp.profitPercent.toFixed(2)}% totalCost=${(opp.totalCost * 100).toFixed(1)}%`,
        );
      }
    }

    return opportunities;
  }

  private analyzeMatch(match: SportsMatch): SportsArbitrageOpportunity | null {
    const { poly, dex } = match;

    // Build unified outcome list: outcome name → { polyProb, dexProb }
    // Polymarket outcomes are the actual team names (e.g. ["MOUZ", "Heroic"])
    // DexSport outcomes are mapped to team names in SportsMatcher

    const legs: SportsArbLeg[] = [];
    let totalCost = 0;

    for (let i = 0; i < poly.outcomeNames.length; i++) {
      const polyName = poly.outcomeNames[i];
      const polyProb = poly.outcomePrices[i] ?? 0;

      // Find matching DexSport outcome by team name
      const dexOutcome = dex.outcomes.find((o) => this.namesMatch(o.name, polyName));

      if (!dexOutcome) {
        // Can't pair this outcome — skip the whole match
        return null;
      }

      const dexProb = dexOutcome.probability;

      // Pick the cheaper platform (lower probability = better decimal odds)
      let bestProb: number;
      let bestLeg: SportsArbLeg;

      if (polyProb <= dexProb) {
        bestProb = polyProb;
        bestLeg = {
          platform: 'polymarket',
          outcomeName: polyName,
          probability: polyProb,
          decimalOdds: polyProb > 0 ? 1 / polyProb : 0,
          url: poly.url,
        };
      } else {
        bestProb = dexProb;
        bestLeg = {
          platform: 'dexsport',
          outcomeName: dexOutcome.name,
          probability: dexProb,
          decimalOdds: dexOutcome.decimalOdds,
        };
      }

      legs.push(bestLeg);
      totalCost += bestProb;
    }

    if (legs.length < 2) return null;

    const profitPercent = totalCost < 1
      ? ((1 - totalCost) / totalCost) * 100
      : 0;

    if (profitPercent < this.MIN_PROFIT_PCT) return null;

    const id = createHash('sha256')
      .update(`arb:${match.id}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);

    return {
      id,
      matchId: match.id,
      sport: match.sport,
      eventName: dex.name || `${match.teamA} vs ${match.teamB}`,
      legs,
      totalCost,
      profitPercent,
      detectedAt: Date.now(),
    };
  }

  private namesMatch(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const na = norm(a);
    const nb = norm(b);
    return na === nb || na.includes(nb) || nb.includes(na);
  }
}
