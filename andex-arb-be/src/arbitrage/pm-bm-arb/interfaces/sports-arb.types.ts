/**
 * In-memory types for the Sports Arbitrage pipeline (Polymarket ↔ DexSport).
 * No database persistence — all data is kept in memory and refreshed continuously.
 */

// ── Polymarket sports ──────────────────────────────────────────

export interface PolymarketSportsEvent {
  conditionId: string;
  slug: string;
  question: string;
  /** Normalized sport slug: 'csgo', 'football', 'basketball', etc. */
  sport: string;
  teamA: string;
  teamB: string;
  /** CLOB token IDs for each outcome (index matches outcomeNames) */
  tokenIds: string[];
  outcomeNames: string[];
  /** Current probabilities 0..1 (from CLOB mid-price, updated via WS) */
  outcomePrices: number[];
  isLive: boolean;
  url: string;
  updatedAt: number;
}

// ── DexSport ───────────────────────────────────────────────────

export interface DexsportSportsOutcome {
  name: string;
  /** Decimal odds, e.g. 1.85 */
  decimalOdds: number;
  /** Implied probability = 1 / decimalOdds */
  probability: number;
}

export interface DexsportSportsEvent {
  /** "2.33944196" (live) or "1.33944196" (prematch) */
  eventId: string;
  /** "MOUZ vs Heroic" */
  name: string;
  /** 'csgo', 'football', etc. */
  sport: string;
  teamA: string;
  teamB: string;
  isLive: boolean;
  marketId: string;
  outcomes: DexsportSportsOutcome[];
  updatedAt: number;
}

// ── Matched pair ───────────────────────────────────────────────

export interface SportsMatch {
  /** Stable ID: hash of poly.conditionId + dex.eventId */
  id: string;
  sport: string;
  teamA: string;
  teamB: string;
  poly: PolymarketSportsEvent;
  dex: DexsportSportsEvent;
  matchedAt: number;
}

// ── Arbitrage ─────────────────────────────────────────────────

export interface SportsArbLeg {
  platform: 'polymarket' | 'dexsport';
  outcomeName: string;
  /** Probability 0..1 (cost per $1 payout) */
  probability: number;
  /** Decimal odds = 1 / probability */
  decimalOdds: number;
  url?: string;
}

export interface SportsArbitrageOpportunity {
  id: string;
  matchId: string;
  sport: string;
  /** "MOUZ vs Heroic" */
  eventName: string;
  legs: SportsArbLeg[];
  /** Sum of leg probabilities — must be < 1.0 for profitable arb */
  totalCost: number;
  /** (1 - totalCost) / totalCost * 100 */
  profitPercent: number;
  detectedAt: number;
}
