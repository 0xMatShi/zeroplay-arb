/**
 * Polymarket Gamma API response types.
 * Based on: https://gamma-api.polymarket.com
 */

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  liquidity: string;
  volume: string;
  markets: PolymarketMarket[];
  /** e.g. "politics", "crypto", "sports" */
  category?: string;
  subcategory?: string;
}

export interface PolymarketMarketEvent {
  id: string;
  slug: string;
  title: string;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  /** JSON string: '["Yes","No"]' */
  outcomes: string;
  /** JSON string: '["0.55","0.45"]' */
  outcomePrices: string;
  /** JSON string with token IDs for each outcome */
  clobTokenIds: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  endDate: string;
  liquidity: string;
  volume: string;
  /** 24h volume */
  volume24hr?: string;
  description?: string;
  /** Parent events — returned by Gamma API */
  events?: PolymarketMarketEvent[];
}

export interface PolymarketEventsResponse {
  data: PolymarketEvent[];
  next_cursor?: string;
}

export interface PolymarketMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}

// ==================== CLOB Order Book ====================

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: PolymarketOrderBookLevel[];
  asks: PolymarketOrderBookLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}
