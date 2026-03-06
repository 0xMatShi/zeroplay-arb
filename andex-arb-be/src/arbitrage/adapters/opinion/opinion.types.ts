/**
 * Opinion OpenAPI types.
 * Base URL: https://openapi.opinion.trade/openapi
 * Auth: apikey header
 */

// ==================== Generic Response Wrapper ====================

export interface OpinionApiResponse<T> {
  errno: number; // 0 = success
  errmsg: string;
  result: T;
}

// ==================== Market List ====================

export interface OpinionMarketListResult {
  list: OpinionMarket[];
  total: number;
}

// ==================== Market ====================

export interface OpinionMarket {
  marketId: number;
  marketTitle: string;
  status: number; // 1=Created, 2=Activated, 3=Resolving, 4=Resolved, 5=Failed, 6=Deleted
  statusEnum: string;
  marketType: number; // 0=binary, 1=categorical
  childMarkets?: OpinionChildMarket[];
  yesLabel?: string;
  noLabel?: string;
  rules?: string;
  yesTokenId?: string;
  noTokenId?: string;
  conditionId?: string;
  resultTokenId?: string;
  volume?: string;
  volume24h?: string;
  volume7d?: string;
  quoteToken?: string;
  chainId?: string;
  questionId?: string;
  createdAt?: number;
  cutoffAt?: number;
  resolvedAt?: number;
  slug?: string;
}

// ==================== Child Market (Categorical outcome) ====================

export interface OpinionChildMarket {
  marketId: number;
  marketTitle: string;
  status: number;
  statusEnum?: string;
  yesLabel?: string;
  noLabel?: string;
  rules?: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId?: string;
  resultTokenId?: string;
  volume?: string;
  volume24h?: string;
  volume7d?: string;
  quoteToken?: string;
  chainId?: string;
  questionId?: string;
  createdAt?: number;
  cutoffAt?: number;
  resolvedAt?: number;
}

// ==================== WebSocket Messages ====================

export interface OpinionDepthDiffMessage {
  marketId: number;
  rootMarketId?: number;
  tokenId: string;
  outcomeSide: number; // 1=yes, 2=no
  side: 'bids' | 'asks';
  price: string;
  size: string; // "0" means remove the level
  msgType: 'market.depth.diff';
}

// ==================== HTTP Orderbook Response ====================

export interface OpinionHttpOrderbookLevel {
  price: string;
  size: string;
}

export interface OpinionHttpOrderbookResult {
  market: string;   // conditionId
  tokenId: string;
  timestamp: number;
  bids: OpinionHttpOrderbookLevel[];
  asks: OpinionHttpOrderbookLevel[];
}

// ==================== Orderbook Cache Entry ====================

export interface OpinionOrderbookEntry {
  bids: Map<string, number>; // price -> size
  asks: Map<string, number>; // price -> size
}
