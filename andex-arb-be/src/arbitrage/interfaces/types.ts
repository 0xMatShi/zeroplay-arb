// ==================== Enums ====================

export enum OutcomeType {
  BINARY = 'binary',
  MULTI = 'multi',
}

export enum EventStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  CANCELLED = 'cancelled',
}

export enum OpportunityStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CLOSED = 'closed',
}

export enum MatchStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
}

export enum MatchMethod {
  AUTO = 'auto',
  AI = 'ai',
  MANUAL = 'manual',
}

export const VerificationSource = {
  AUTO: 'auto',
  AI: 'ai',
  MANUAL: 'manual',
} as const;

// ==================== Normalized Data (adapter output) ====================

/** Unified event format that every source adapter must return */
export interface NormalizedEvent {
  /** ID on the source platform */
  externalId: string;
  /** Event/market question title */
  title: string;
  description?: string;
  category?: string;
  subcategory?: string;
  /** When the market resolves */
  endDate?: Date;
  status: EventStatus;
  outcomeType: OutcomeType;
  /** All tradeable outcomes with current prices */
  outcomes: NormalizedOutcome[];
  /** Direct link to this market on the platform */
  url?: string;
  /** Any platform-specific data we want to keep */
  metadata?: Record<string, any>;
}

/** A single tradeable outcome within an event */
export interface NormalizedOutcome {
  externalId: string;
  /** "Yes", "No", "Trump", "Biden", etc. */
  name: string;
  /** Price in range 0.0 - 1.0 (probability) */
  price: number;
  /** 24h trading volume in USD (if available) */
  volume24h?: number;
  metadata?: Record<string, any>;
}

// ==================== Order Book ====================

/** A single level in the order book */
export interface OrderBookEntry {
  /** Price level (0.0 - 1.0 for prediction markets) */
  price: number;
  /** Quantity (number of contracts / shares) available at this price */
  quantity: number;
}

/** Order book for a single outcome on a single platform */
export interface OrderBook {
  /** Buy orders — sorted by price DESC (best bid first) */
  bids: OrderBookEntry[];
  /** Sell orders — sorted by price ASC (best ask first) */
  asks: OrderBookEntry[];
  /** Last traded price */
  lastPrice?: number;
  /** Timestamp (ms) */
  timestamp?: number;
}

/** Order book data for one leg of an arbitrage opportunity */
export interface LegOrderBook {
  platformSlug: string;
  platformName: string;
  outcomeName: string;
  /** The order book for this outcome */
  orderBook: OrderBook;
  /** Total quantity available at or below the leg price (what user can actually buy) */
  availableQuantity: number;
  /** Weighted-average price across available quantity */
  effectivePrice: number;
}

// ==================== Arbitrage Tiers (order-book-based) ====================

/**
 * A single executable tier of an arbitrage opportunity.
 *
 * Computed by walking through the order books of all legs simultaneously.
 * Each tier represents a batch of contracts available at specific price levels.
 */
export interface ArbitrageTier {
  /** How many contracts can be filled at this tier */
  quantity: number;
  /** Price details for each leg at this tier */
  legPrices: {
    platformSlug: string;
    platformName: string;
    outcomeName: string;
    /** Ask price for this leg at this tier */
    price: number;
    url?: string;
  }[];
  /** Sum of all leg prices at this tier (per contract) */
  totalCostPerContract: number;
  /** Profit % at this tier: (1.0 - totalCost) / totalCost * 100 */
  profitPercentage: number;
  /** Total $ investment for this tier: quantity × totalCostPerContract */
  investmentAmount: number;
  /** Gross profit for this tier: quantity × (1.0 - totalCostPerContract) */
  grossProfit: number;
}

/**
 * Cumulative summary of all profitable tiers.
 */
export interface ArbitrageTiersSummary {
  /** All profitable tiers (sorted by profit DESC) */
  tiers: ArbitrageTier[];
  /** Total contracts executable across all tiers */
  totalQuantity: number;
  /** Total investment across all tiers */
  totalInvestment: number;
  /** Total gross profit across all tiers */
  totalGrossProfit: number;
  /** Weighted-average profit % across all tiers */
  weightedAvgProfit: number;
  /** Best profit % (first tier) */
  bestProfitPercentage: number;
  /** Worst profit % (last tier, still positive) */
  worstProfitPercentage: number;
}

// ==================== Arbitrage ====================

/** One leg (side) of an arbitrage trade */
export interface ArbitrageLeg {
  platformSlug: string;
  platformName: string;
  eventExternalId: string;
  eventTitle: string;
  outcomeExternalId: string;
  outcomeName: string;
  /** Price to buy this outcome */
  price: number;
  url?: string;
  /** Platform-specific metadata needed for order book / deep data queries */
  metadata?: Record<string, any>;
}

/** Full details of a detected arbitrage opportunity */
export interface ArbitrageDetails {
  /** All legs of the arb (what to buy and where) */
  legs: ArbitrageLeg[];
  /** Total cost to execute all legs (sum of prices, normalized to $1 payout) */
  totalCost: number;
  /** Guaranteed payout if any outcome wins (always 1.0 for normalized markets) */
  guaranteedPayout: number;
  /** Profit as percentage: (payout - cost) / cost * 100 */
  profitPercentage: number;
  /** Sum of implied probabilities across best prices */
  impliedProbabilitySum: number;
}

// ==================== Platform Info ====================

export interface PlatformInfo {
  slug: string;
  name: string;
  baseUrl: string;
  defaultPollIntervalMs: number;
}
