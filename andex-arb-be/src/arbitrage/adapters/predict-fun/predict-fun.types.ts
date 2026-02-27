/**
 * Predict.fun REST API response types.
 *
 * API docs: https://api.predict.fun/docs
 * Base URL (mainnet): https://api.predict.fun  (API key required)
 * Base URL (testnet): https://api-testnet.predict.fun  (no key)
 */

// ==================== Generic Response Wrapper ====================

export interface PredictApiResponse<T> {
  success: boolean;
  data: T;
  cursor?: string | null;
}

export interface PredictListResponse<T> {
  success: boolean;
  data: T[];
  cursor: string | null;
}

// ==================== Market ====================

export interface PredictMarket {
  id: number;
  title: string;
  question: string;
  description: string;
  imageUrl: string;

  /** REGISTERED | PRICE_PROPOSED | PRICE_DISPUTED | PAUSED | UNPAUSED | RESOLVED */
  status: string;

  outcomes: PredictOutcome[];
  conditionId: string;
  oracleQuestionId: string;
  resolverAddress: string;

  /** Category URL slug — used for market page URL */
  categorySlug: string;
  /** Numeric index within a neg-risk group, null for standalone */
  questionIndex: number | null;

  /** Cross-platform references (very useful for matching!) */
  polymarketConditionIds: string[];
  kalshiMarketTicker: string | null;

  /** Neg-risk means outcomes across a group sum to 1.0 */
  isNegRisk: boolean;
  isYieldBearing: boolean;
  feeRateBps: number;

  /** 2 = cents ($0.01 precision), 3 = mils ($0.001 precision) */
  decimalPrecision: number;

  /** DEFAULT | SPORTS_MATCH | CRYPTO_UP_DOWN | TWEET_COUNT | SPORTS_TEAM_MATCH */
  marketVariant: string;
  variantData?: PredictCryptoUpDownData | PredictTweetCountData | null;

  isBoosted: boolean;
  boostStartsAt: string | null;
  boostEndsAt: string | null;

  resolution: PredictOutcome | null;
  createdAt: string;
}

export interface PredictOutcome {
  name: string;
  indexSet: number;
  /** Big number string — ERC-1155 token ID */
  onChainId: string;
  status: 'WON' | 'LOST' | null;
}

export interface PredictCryptoUpDownData {
  type: 'CRYPTO_UP_DOWN';
  startPrice: number;
  endPrice: number | null;
  priceFeedId: string;
}

export interface PredictTweetCountData {
  type: 'TWEET_COUNT';
  xAccountUsername: string;
  tweetCount: number;
}

// ==================== Market Stats ====================

export interface PredictMarketStats {
  totalLiquidityUsd: number;
  volumeTotalUsd: number;
  volume24hUsd: number;
}

// ==================== Order Book ====================

export interface PredictOrderBook {
  marketId: number;
  updateTimestampMs: number;
  /** [price, quantity][] — sorted by price ASC */
  asks: [number, number][];
  /** [price, quantity][] — sorted by price DESC */
  bids: [number, number][];
  lastOrderSettled?: {
    id: string;
    price: string;
    kind: string;
    marketId: number;
    side: string;
    outcome: string;
  };
}

// ==================== Category ====================

export interface PredictCategory {
  id: number;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  status: string;
  isNegRisk: boolean;
  startsAt?: string;
  endsAt?: string;
  markets: PredictMarket[];
  createdAt: string;
  publishedAt?: string;
}
