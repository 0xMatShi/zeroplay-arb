/**
 * Probable Markets API response types.
 *
 * Market Public API: https://market-api.probable.markets/public/api/v1
 * Orderbook (CLOB) API: https://api.probable.markets/public/api/v1
 *
 * Based on @prob/types SDK definitions.
 */

// ==================== Events ====================

export interface ProbableEventTag {
  id: number;
  label: string;
  slug: string;
}

export interface ProbableEvent {
  id: string;
  slug: string;
  title: string;
  marketStructure: 'single' | 'grouped';
  active: boolean;
  closed: boolean;
  archived: boolean;
  live: boolean;
  ended: boolean;
  description?: string;
  createdAt: string;
  image?: string;
  icon?: string;
  volume: string;
  volume24hr?: number;
  liquidity?: string;
  markets: ProbableMarket[];
  tags: ProbableEventTag[];
}

// ==================== Markets ====================

export interface ProbableMarketOutcome {
  name: string;
  address: string;
}

export interface ProbableMarketToken {
  token_id: string;
  outcome: string;
  price?: number;
}

export interface ProbableMarketResolveData {
  resolved: boolean;
  resolver: string;
  outcome: string;
  resolvedTx?: string;
  resolvedTimestamp?: number;
  disputed?: boolean;
}

export interface ProbableMarket {
  id: string;
  condition_id: `0x${string}`;
  slug?: string;
  market_slug?: string;
  question: string;
  question_id: `0x${string}`;
  description?: string;
  outcomes: string | ProbableMarketOutcome[];
  groupItemTitle?: string;
  tokens: ProbableMarketToken[];
  icon?: string;
  image?: string;
  category?: string;
  tags?: string[];
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  closedTime?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  resolved: boolean;
  resolve?: ProbableMarketResolveData;
  volume?: string;
  volume24hr?: string | number;
  liquidity?: string;
  clobTokenIds?: string;
  sportsMarketType?: string;
  gameStartTime?: string;
  liveness?: string;
  disputed?: boolean;
}

// ==================== Raw Market Data (from /markets listing) ====================

export interface ProbableRawMarketData {
  id?: string;
  condition_id: string;
  question: string;
  question_id?: string;
  market_slug: string;
  outcomes: string;
  volume24hr?: string;
  liquidity?: string;
  clobTokenIds?: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  closedTime?: string;
  sportsMarketType?: string;
  tokens?: Array<{
    token_id: `0x${string}`;
    outcome: string;
    price?: string;
    winner?: boolean;
  }>;
  icon?: string;
  image?: string;
  category?: string;
  description?: string;
  tags?: string[];
  groupItemTitle?: string;
  gameStartTime?: string;
  resolved?: boolean;
}

// ==================== Orderbook (CLOB) ====================

export interface ProbableOrderBookLevel {
  price: string;
  size: string;
}

export interface ProbableOrderBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: ProbableOrderBookLevel[];
  asks: ProbableOrderBookLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}

// ==================== Pagination ====================

export interface ProbablePaginationInfo {
  hasMore?: boolean;
  totalResults?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
}

export interface ProbableMarketsResponse {
  markets: ProbableRawMarketData[];
  pagination?: ProbablePaginationInfo;
}
