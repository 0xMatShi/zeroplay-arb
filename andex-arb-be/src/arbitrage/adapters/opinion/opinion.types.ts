/**
 * Opinion API response types.
 * Based on real API: https://proxy.opinion.trade:8443/api/bsc/api/v2/topic
 * No API key required.
 */

// ==================== Generic Response Wrapper ====================

export interface OpinionApiResponse<T> {
  errno: number; // 0 = success
  errmsg: string;
  result: T;
}

// ==================== Topic List ====================

export interface OpinionTopicListResult {
  list: OpinionTopic[];
  total: number;
}

// ==================== Topic (Parent Market) ====================

export interface OpinionTopic {
  // API returns both naming conventions depending on endpoint version
  marketId?: number;
  topicId?: number;         // actual field name in API response
  marketTitle?: string;
  title?: string;           // actual field name in API response

  /** 1 = created, 2 = activated, etc. */
  status: number;
  statusEnum?: string;

  /** 0 = binary, other = categorical */
  marketType?: number;
  topicType?: number;       // actual field name in API response

  // Child markets (present for categorical)
  childMarkets?: OpinionChildMarket[];
  childList?: OpinionChildMarket[]; // actual field name in API response

  // Labels
  yesLabel?: string;
  noLabel?: string;

  // Resolution rules — used as description
  rules?: string;

  // Token IDs — API returns yesPos/noPos
  yesTokenId?: string;
  noTokenId?: string;
  yesPos?: string;          // actual field name in API response
  noPos?: string;           // actual field name in API response
  conditionId?: string;
  resultTokenId?: string;

  // Volume (string numbers)
  volume?: string;
  volume24h?: string;
  volume7d?: string;

  // Chain
  quoteToken?: string;
  chainId?: string;

  // Identifiers
  questionId?: string;

  // Timestamps (Unix seconds)
  createdAt?: number;
  createTime?: number;      // actual field name in API response
  cutoffAt?: number;
  cutoffTime?: number;      // actual field name in API response
  resolvedAt?: number;
  resolvedTime?: number;    // actual field name in API response

  // Prices
  yesBuyPrice?: string;
  yesMarketPrice?: string;
  noBuyPrice?: string;

  // Misc
  incentiveFactor?: unknown;
  collection?: unknown;
  labelName?: string[];
  isShow?: number;
  slug?: string;
}

// ==================== Child Market (Outcome within Categorical) ====================

export interface OpinionChildMarket {
  marketId: number;
  marketTitle: string;

  status: number;
  statusEnum?: string;

  yesLabel?: string;
  noLabel?: string;

  rules?: string;

  // Token IDs
  yesTokenId: string;
  noTokenId: string;
  conditionId?: string;
  resultTokenId?: string;

  // Volume
  volume?: string;
  volume24h?: string;
  volume7d?: string;

  // Chain
  quoteToken?: string;
  chainId?: string;

  // Identifiers
  questionId?: string;

  // Timestamps
  createdAt?: number;
  cutoffAt?: number;
  resolvedAt?: number;

  // Prices (optional)
  yesBuyPrice?: string;
  yesMarketPrice?: string;
  noBuyPrice?: string;
  yesSellPrice?: string;
  noSellPrice?: string;
}

// ==================== Order Book ====================

export interface OpinionOrderBookResult {
  asks: [string, string][]; // [price, quantity][]
  bids: [string, string][]; // [price, quantity][]
  last_price: string;
  question_id: string;
  symbol: string;
  ts: number; // Unix ms timestamp
}
