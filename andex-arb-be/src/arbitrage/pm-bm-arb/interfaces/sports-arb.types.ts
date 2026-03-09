/**
 * In-memory types for the Sports Arbitrage pipeline (Polymarket ↔ DexSport).
 * Supports multiple market types per event (moneyline, totals, spreads, etc.).
 */

// ── Sport mapping ────────────────────────────────────────────

export interface SportDef {
  label: string;
  dexSlugs: string[];
  pmTags: string[];
}

// ── Polymarket sports ────────────────────────────────────────

export interface AskLevel {
  price: number;
  size: number;
}

export interface PmMarket {
  conditionId: string;
  sportsMarketType: string;
  question: string;
  outcomeNames: string[];
  /** Best ask price per outcome (updated via CLOB WS / REST books) */
  outcomePrices: number[];
  /** Best ask quantity per outcome (updated via CLOB WS / REST books) */
  outcomeQtys: number[];
  /** Full ask book per outcome sorted ascending by price (from WS book / REST books) */
  outcomeAsks: AskLevel[][];
  tokenIds: string[];
}

export interface PmSportsEvent {
  id: string;
  title: string;
  sportKey: string;
  slug: string;
  markets: PmMarket[];
  updatedAt: number;
}

// ── DexSport ─────────────────────────────────────────────────

export interface DexOutcome {
  name: string;
  /** Decimal odds, e.g. 1.85 */
  price: number;
}

export interface DexMarket {
  marketId: string;
  name: string;
  outcomes: DexOutcome[];
}

export interface DexSportsEvent {
  eventId: string;
  name: string;
  sportKey: string;
  isLive: boolean;
  startTime?: number;
  tournamentName?: string;
  markets: DexMarket[];
  updatedAt: number;
}

// ── Matched pair ─────────────────────────────────────────────

export interface MatchedMarketPair {
  pmType: string;
  pmMarket: PmMarket;
  dexMarket: DexMarket;
}

export interface SportsMatch {
  id: string;
  sportKey: string;
  pmEvent: PmSportsEvent;
  dexEvent: DexSportsEvent;
  similarity: number;
  matchedMarkets: MatchedMarketPair[];
  matchedAt: number;
}

// ── Arbitrage ────────────────────────────────────────────────

export interface SportsArbLeg {
  platform: 'polymarket' | 'dexsport';
  outcomeName: string;
  /** Probability 0..1 (cost per $1 payout) */
  probability: number;
  /** Decimal odds = 1 / probability */
  decimalOdds: number;
  /** PM only: contracts available at best ask */
  pmBestAskQty?: number;
}

export interface SportsArbitrageOpportunity {
  id: string;
  matchId: string;
  sportKey: string;
  eventName: string;
  /** Which market type this arb is on: 'moneyline', 'totals', etc. */
  marketType: string;
  pmQuestion: string;
  dexMarketName: string;
  legs: SportsArbLeg[];
  /** Sum of best leg probabilities — must be < 1.0 for profitable arb */
  totalCost: number;
  /** (1 - totalCost) / totalCost * 100 */
  profitPercent: number;
  /** Max total investment ($) across all profitable PM ask levels */
  maxInvestment: number;
  /** Max guaranteed profit ($) at maxInvestment depth */
  maxProfit: number;
  /** Timestamp of the latest scan that confirmed this opportunity */
  detectedAt: number;
  /** Timestamp when this opportunity was first detected (stable across rescans) */
  firstDetectedAt: number;
  isLive: boolean;
}
