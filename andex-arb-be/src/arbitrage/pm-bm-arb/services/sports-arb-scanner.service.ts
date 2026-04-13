import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  SportsMatch,
  SportsArbitrageOpportunity,
  SportsArbLeg,
  MatchedMarketPair,
  AskLevel,
  BmBmMatch,
  BmBmMarketPair,
} from '../interfaces/sports-arb.types';

/**
 * Scans matched Polymarket ↔ DexSport event pairs for arbitrage.
 *
 * For each matched market pair, enumerates all cross-platform leg assignments
 * (at least one leg on PM and at least one on DEX). Each valid combination
 * where sum of implied probabilities < 1.0 is reported as a separate opportunity.
 *
 * Depth analysis: walks PM ask levels to compute maxInvestment / maxProfit
 * (DEX is a bookmaker with a single fixed price, so depth is bounded by PM side).
 *
 * PM prices are probabilities (0..1), DEX prices are decimal odds.
 * Conversion: dexProbability = 1 / dexOdds
 */
@Injectable()
export class SportsArbScanner {
  private readonly logger = new Logger(SportsArbScanner.name);

  private readonly MIN_PROFIT_PCT = -100;

  scan(matches: SportsMatch[]): SportsArbitrageOpportunity[] {
    const opportunities: SportsArbitrageOpportunity[] = [];

    for (const match of matches) {
      for (const mp of match.matchedMarkets) {
        const opps = this.analyzeMarketPair(match, mp);
        opportunities.push(...opps);
      }
    }

    return opportunities;
  }

  scanBmBm(matches: BmBmMatch[]): SportsArbitrageOpportunity[] {
    const opportunities: SportsArbitrageOpportunity[] = [];

    for (const match of matches) {
      for (const mp of match.matchedMarkets) {
        if (mp.marketType === 'dc_vs_moneyline') {
          opportunities.push(...this.analyzeDcVsMoneylinePair(match, mp));
        } else {
          opportunities.push(...this.analyzeBmBmMarketPair(match, mp));
        }
      }
    }

    return opportunities;
  }

  private analyzeMarketPair(
    match: SportsMatch,
    mp: MatchedMarketPair,
  ): SportsArbitrageOpportunity[] {
    const { pmMarket, dexMarket } = mp;

    // Skip suspended bookmaker markets (e.g. Fonbet/Pari pausing lines for recalculation).
    if (dexMarket.isSuspended) return [];

    // Skip resolved PM markets: if any outcome price is near 0 (<2¢),
    // the market is already settled (e.g. completed CS:GO map) — not a real arb.
    if (Math.min(...pmMarket.outcomePrices) < 0.02) return [];

    // For child_moneyline (individual map/game markets in a series):
    // Only show map N if all preceding maps have been resolved on PM.
    // A resolved PM map has one outcome price near 0 (<5¢ — settled by oracle).
    // This prevents fake arbs for maps that may never be played (e.g. map 4 in a 3-0 Bo5).
    if (mp.pmType === 'child_moneyline') {
      const numMatch = mp.pmMarket.question.match(/(?:Map|Game)\s+(\d+)/i);
      const mapNum = numMatch ? parseInt(numMatch[1], 10) : 1;
      if (mapNum > 1) {
        const prevMapMarket = match.pmEvent.markets.find((m) => {
          if (m.sportsMarketType !== 'child_moneyline') return false;
          const q = m.question.match(/(?:Map|Game)\s+(\d+)/i);
          return q != null && parseInt(q[1], 10) === mapNum - 1;
        });
        // Previous map not found or not yet settled → this map hasn't been reached yet
        if (!prevMapMarket || Math.min(...prevMapMarket.outcomePrices) >= 0.01) return [];
      }
    }

    // PM outcomes: names + best-ask probabilities + best-ask qty + full ask levels
    const pmOutcomes = pmMarket.outcomeNames.map((name, i) => ({
      name,
      probability: pmMarket.outcomePrices[i] ?? 0,
      qty: pmMarket.outcomeQtys?.[i] ?? 0,
      asks: pmMarket.outcomeAsks?.[i] ?? [],
    }));

    // DEX outcomes: names + decimal odds → probability
    const dexOutcomes = dexMarket.outcomes.map((o) => ({
      name: o.name,
      probability: o.price > 0 ? 1 / o.price : 0,
      decimalOdds: o.price,
    }));

    if (pmOutcomes.length < 2 || dexOutcomes.length < 2) return [];

    // Map each PM outcome to its corresponding DEX outcome by name
    const pairs: Array<{
      pmOut: { name: string; probability: number; qty: number; asks: AskLevel[] };
      dexOut: { name: string; probability: number; decimalOdds: number };
    }> = [];

    for (const pmOut of pmOutcomes) {
      const dexOut = this.findMatchingOutcome(pmOut.name, dexOutcomes);
      if (!dexOut) return []; // can't pair all outcomes → skip entire market
      pairs.push({ pmOut, dexOut });
    }

    const n = pairs.length;
    const opportunities: SportsArbitrageOpportunity[] = [];

    // Enumerate all 2^n - 2 cross-platform assignments (mask bit i: 0=PM, 1=DEX).
    // Exclude mask=0 (all PM) and mask=(2^n - 1) (all DEX) — those are single-platform.
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const legs: SportsArbLeg[] = [];
      let totalCost = 0;

      for (let i = 0; i < n; i++) {
        const { pmOut, dexOut } = pairs[i];
        const useDex = (mask >> i) & 1;

        if (!useDex) {
          legs.push({
            platform: 'polymarket',
            outcomeName: pmOut.name,
            probability: pmOut.probability,
            decimalOdds: pmOut.probability > 0 ? 1 / pmOut.probability : 0,
            pmBestAskQty: pmOut.qty,
          });
          totalCost += pmOut.probability * (1 + 0.03 * (1 - pmOut.probability));
        } else {
          legs.push({
            platform: match.bookmakerPlatform,
            outcomeName: dexOut.name,
            probability: dexOut.probability,
            decimalOdds: dexOut.decimalOdds,
          });
          totalCost += dexOut.probability;
        }
      }

      const profitPercent = totalCost > 0 ? ((1 - totalCost) / totalCost) * 100 : -100;

      if (profitPercent < this.MIN_PROFIT_PCT) continue;

      // Include mask in ID so the two combos of the same market get distinct IDs
      const id = createHash('sha256')
        .update(`arb:${match.id}:${mp.pmType}:${mp.pmMarket.conditionId}:${mp.dexMarket.marketId}:${mask}`)
        .digest('hex')
        .slice(0, 16);

      const { maxInvestment, maxProfit } = this.computeDepth(pairs, mask, n);

      opportunities.push({
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
        maxInvestment,
        maxProfit,
        detectedAt: Date.now(),
        firstDetectedAt: Date.now(),
        isLive: match.dexEvent.isLive ||
          (match.pmEvent.startTime != null && Date.now() > match.pmEvent.startTime) ||
          (match.dexEvent.startTime != null && Date.now() > match.dexEvent.startTime * 1000),
      });
    }

    return opportunities;
  }

  /**
   * Walk PM ask levels to compute total investable amount and guaranteed profit.
   * DEX is a bookmaker — single fixed price, no depth constraint.
   * Stops when the combined cost (PM level + DEX fixed) >= 1.0.
   */
  private computeDepth(
    pairs: Array<{
      pmOut: { asks: AskLevel[]; probability: number };
      dexOut: { probability: number };
    }>,
    mask: number,
    n: number,
  ): { maxInvestment: number; maxProfit: number } {
    // Fixed DEX cost (sum of all DEX leg prices — bookmaker, no depth)
    let dexFixed = 0;
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) dexFixed += pairs[i].dexOut.probability;
    }

    // Collect ask arrays for all PM legs (bit=0 in mask)
    const pmAskArrays: AskLevel[][] = [];
    for (let i = 0; i < n; i++) {
      if (!((mask >> i) & 1)) pmAskArrays.push(pairs[i].pmOut.asks);
    }

    if (pmAskArrays.length === 0 || pmAskArrays.some((a) => a.length === 0)) {
      return { maxInvestment: 0, maxProfit: 0 };
    }

    // Cursor-based tier walking (same approach as pm-pm OrderBookService)
    const cursors = pmAskArrays.map((asks) => ({ idx: 0, asks, remaining: asks[0].size }));

    let maxInvestment = 0;
    let maxProfit = 0;
    const MAX_TIERS = 50;

    for (let tier = 0; tier < MAX_TIERS; tier++) {
      // Check all cursors still have levels
      if (cursors.some((c) => c.idx >= c.asks.length)) break;

      // Total cost at current PM levels + fixed DEX cost
      const pmTotal = cursors.reduce((sum, c) => {
        const price = c.asks[c.idx].price;
        return sum + price * (1 + 0.03 * (1 - price));
      }, 0);
      const totalCost = pmTotal + dexFixed;
      if (totalCost >= 1.0) break;

      // Fillable qty = minimum remaining across all PM legs
      const fillQty = Math.min(...cursors.map((c) => c.remaining));
      if (fillQty <= 0) break;

      maxInvestment += fillQty * totalCost;
      maxProfit += fillQty * (1.0 - totalCost);

      // Advance cursors
      for (const cursor of cursors) {
        cursor.remaining -= fillQty;
        if (cursor.remaining < 0.001) {
          cursor.idx++;
          cursor.remaining = cursor.asks[cursor.idx]?.size ?? 0;
        }
      }
    }

    return { maxInvestment, maxProfit };
  }

  private analyzeBmBmMarketPair(match: BmBmMatch, mp: BmBmMarketPair): SportsArbitrageOpportunity[] {
    const { dexMarket, bmMarket } = mp;

    // Skip suspended bookmaker markets.
    if (dexMarket.isSuspended || bmMarket.isSuspended) return [];

    const dexOutcomes = dexMarket.outcomes.map((o) => ({
      name: o.name,
      probability: o.price > 0 ? 1 / o.price : 0,
      decimalOdds: o.price,
    }));

    const bmOutcomes = bmMarket.outcomes.map((o) => ({
      name: o.name,
      probability: o.price > 0 ? 1 / o.price : 0,
      decimalOdds: o.price,
    }));

    if (dexOutcomes.length < 2 || bmOutcomes.length < 2) return [];

    // Pair each dexsport outcome with the corresponding bm outcome by name
    const pairs: Array<{
      dexOut: { name: string; probability: number; decimalOdds: number };
      bmOut:  { name: string; probability: number; decimalOdds: number };
    }> = [];

    for (const dexOut of dexOutcomes) {
      const bmOut = this.findMatchingOutcome(dexOut.name, bmOutcomes);
      if (!bmOut) return [];
      pairs.push({ dexOut, bmOut });
    }

    const n = pairs.length;
    const opportunities: SportsArbitrageOpportunity[] = [];

    // Enumerate cross-platform assignments (mask bit i: 0=dexsport, 1=bm)
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const legs: SportsArbLeg[] = [];
      let totalCost = 0;

      for (let i = 0; i < n; i++) {
        const { dexOut, bmOut } = pairs[i];
        const useBm = (mask >> i) & 1;

        if (!useBm) {
          legs.push({
            platform: 'dexsport',
            outcomeName: dexOut.name,
            probability: dexOut.probability,
            decimalOdds: dexOut.decimalOdds,
          });
          totalCost += dexOut.probability;
        } else {
          legs.push({
            platform: match.bmPlatform,
            outcomeName: bmOut.name,
            probability: bmOut.probability,
            decimalOdds: bmOut.decimalOdds,
          });
          totalCost += bmOut.probability;
        }
      }

      const profitPercent = totalCost > 0 ? ((1 - totalCost) / totalCost) * 100 : -100;
      if (profitPercent < this.MIN_PROFIT_PCT) continue;

      const id = createHash('sha256')
        .update(`bmbm:${match.id}:${mp.marketType}:${dexMarket.marketId}:${bmMarket.marketId}:${mask}`)
        .digest('hex')
        .slice(0, 16);

      opportunities.push({
        id,
        matchId: match.id,
        sportKey: match.sportKey,
        eventName: match.dexEvent.name,
        marketType: mp.marketType,
        pmQuestion: bmMarket.name,
        dexMarketName: dexMarket.name,
        legs,
        totalCost,
        profitPercent,
        maxInvestment: 0,
        maxProfit: 0,
        detectedAt: Date.now(),
        firstDetectedAt: Date.now(),
        isLive: match.dexEvent.isLive ||
          (match.dexEvent.startTime != null && Date.now() > match.dexEvent.startTime * 1000),
      });
    }

    return opportunities;
  }

  /**
   * Cross-type arb: Double Chance on one platform × 3-way Moneyline on the other.
   *
   * The BmBmMarketPair convention for dc_vs_moneyline:
   *   - dexMarket / bmMarket can be either DC or ML — we detect by outcome names.
   *
   * Valid 2-leg combinations (each covers all three football outcomes):
   *   "1X" (home+draw)  + ML Away  → complement = away win
   *   "X2" (away+draw)  + ML Home  → complement = home win
   *   "12" (home+away)  + ML Draw  → complement = draw
   *
   * Home/Away team names are resolved from the event name ("Liverpool vs PSG").
   */
  private analyzeDcVsMoneylinePair(match: BmBmMatch, mp: BmBmMarketPair): SportsArbitrageOpportunity[] {
    const { dexMarket, bmMarket } = mp;
    if (dexMarket.isSuspended || bmMarket.isSuspended) return [];

    const DC_NAMES = new Set(['1X', 'X2', '12']);
    const isDcMarket = (m: typeof dexMarket) => m.outcomes.some((o) => DC_NAMES.has(o.name));

    const dcMarket = isDcMarket(dexMarket) ? dexMarket : bmMarket;
    const mlMarket = isDcMarket(dexMarket) ? bmMarket : dexMarket;
    const dcPlatform = isDcMarket(dexMarket) ? 'dexsport' : match.bmPlatform;
    const mlPlatform = isDcMarket(dexMarket) ? match.bmPlatform : 'dexsport';

    // DC outcomes by canonical name
    const dcByName = new Map(dcMarket.outcomes.map((o) => [o.name, o]));
    const dc1X = dcByName.get('1X');
    const dcX2 = dcByName.get('X2');
    const dc12 = dcByName.get('12');
    if (!dc1X || !dcX2 || !dc12) return [];

    // Resolve home/away team names from event name "Home vs Away"
    const [rawHome = '', rawAway = ''] = match.dexEvent.name.split(' vs ');
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normHome = norm(rawHome);
    const normAway = norm(rawAway);

    const mlHome = mlMarket.outcomes.find((o) => {
      const n = norm(o.name);
      return n !== 'draw' && (n.includes(normHome) || normHome.includes(n));
    });
    const mlAway = mlMarket.outcomes.find((o) => {
      const n = norm(o.name);
      return n !== 'draw' && (n.includes(normAway) || normAway.includes(n));
    });
    const mlDraw = mlMarket.outcomes.find((o) => norm(o.name) === 'draw');

    if (!mlHome || !mlAway || !mlDraw) return [];

    const opportunities: SportsArbitrageOpportunity[] = [];

    // Enumerate the 3 valid combos
    const combos: Array<{ dcOut: typeof dc1X; mlOut: typeof mlHome; key: string }> = [
      { dcOut: dc1X, mlOut: mlAway, key: '1X_away' },
      { dcOut: dcX2, mlOut: mlHome, key: 'X2_home' },
      { dcOut: dc12, mlOut: mlDraw, key: '12_draw' },
    ];

    for (const { dcOut, mlOut, key } of combos) {
      const dcProb = dcOut.price > 0 ? 1 / dcOut.price : 0;
      const mlProb = mlOut.price > 0 ? 1 / mlOut.price : 0;
      if (dcProb <= 0 || mlProb <= 0) continue;

      const totalCost = dcProb + mlProb;
      const profitPercent = totalCost > 0 ? ((1 - totalCost) / totalCost) * 100 : -100;
      if (profitPercent < this.MIN_PROFIT_PCT) continue;

      const id = createHash('sha256')
        .update(`dcml:${match.id}:${dcMarket.marketId}:${mlMarket.marketId}:${key}`)
        .digest('hex')
        .slice(0, 16);

      opportunities.push({
        id,
        matchId: match.id,
        sportKey: match.sportKey,
        eventName: match.dexEvent.name,
        marketType: 'dc_vs_moneyline',
        pmQuestion: `DC ${dcOut.name} + ML ${mlOut.name}`,
        // "Double Chance | Moneyline" when DexSport holds DC (left box), "Moneyline | Double Chance" otherwise.
        dexMarketName: dcPlatform === 'dexsport' ? 'Double Chance | Moneyline' : 'Moneyline | Double Chance',
        legs: [
          {
            platform: dcPlatform as SportsArbLeg['platform'],
            outcomeName: dcOut.name,
            probability: dcProb,
            decimalOdds: dcOut.price,
          },
          {
            platform: mlPlatform as SportsArbLeg['platform'],
            outcomeName: mlOut.name,
            probability: mlProb,
            decimalOdds: mlOut.price,
          },
        ],
        totalCost,
        profitPercent,
        maxInvestment: 0,
        maxProfit: 0,
        detectedAt: Date.now(),
        firstDetectedAt: Date.now(),
        isLive: match.dexEvent.isLive ||
          (match.dexEvent.startTime != null && Date.now() > match.dexEvent.startTime * 1000),
      });
    }

    return opportunities;
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
