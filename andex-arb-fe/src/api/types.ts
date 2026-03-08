// Version
export interface VersionDto {
  name: string
  version: string
  environment: string
}

// Auth
export interface RequestSiweDto {
  address: string
}

export interface RequestSiweResponseDto {
  message: string
  nonce: string
}

export interface VerifySignatureDto {
  address: string
  message: string
  signature: string
}

export interface VerifySignatureResponseDto {
  apiKey: string
  user: {
    id: string
    address: string
  }
}

export interface WhoamiResponse {
  id: string
  address: string
  createdAt: string
  updatedAt: string
}

// Plans
export interface PlanDto {
  id: string
  name: string
  description: string | null
  price: string
  durationDays: number
  isActive: boolean
}

// Payments
export type ChainId = 'ethereum' | 'bsc' | 'arbitrum' | 'base'

export interface SupportedToken {
  symbol: string
  address: string
}

export interface CreatePaymentRequestDto {
  planId: string
  chainId: ChainId
}

export interface PaymentRequestResponseDto {
  id: string
  planId: string
  amount: string
  chainId: ChainId
  status: string
  walletAddress: string
  tokenSymbol: string | null
  supportedTokens: SupportedToken[]
  expiresAt: string
  createdAt: string
}

// Subscriptions
export interface SubscriptionStatusDto {
  active: boolean
}

export interface ActiveSubscriptionDto {
  id: string
  planId: string
  planName: string
  status: string
  startsAt: string
  expiresAt: string
  createdAt: string
}

export interface SubscriptionHistoryItemDto {
  id: string
  planName: string
  status: string
  startsAt: string
  expiresAt: string
  createdAt: string
}

// Arbitrage
export interface ArbitrageLeg {
  platformSlug: string        // "polymarket" | "kalshi" | "opinion"
  platformName: string        // "Polymarket" | "Kalshi" | "Opinion"
  eventExternalId: string
  eventTitle: string
  outcomeExternalId: string
  outcomeName: string         // "Yes", "No", "Trump", "Arsenal" etc.
  price: number               // 0.0 - 1.0
  url?: string
}

export interface Opportunity {
  id: string
  type: 'binary' | 'multi'
  profitPercentage: number
  /** Weighted avg profit % from order book depth. Null until order book fetched at least once. */
  weightedAvgProfit: number | null
  /** Total gross profit in $ across all executable tiers. Null until order book fetched at least once. */
  totalGrossProfit: number | null
  totalCost: number
  guaranteedPayout: number    // always 1.0
  legs: ArbitrageLeg[]
  isLive?: boolean
  status: 'active'
  foundAt: string
  lastValidatedAt: string
  expiredAt: string | null
  matchTitle: string
}

export interface OpportunitiesResponse {
  items: Opportunity[]
  total: number
  limit: number
  offset: number
}

// Sports Arbitrage (PM vs DexSport)
export interface SportsOpportunityLeg {
  platform: 'polymarket' | 'dexsport'
  outcomeName: string
  probability: number       // 0..1 (price in $; cents = *100)
  decimalOdds: number       // 1/probability
  pmBestAskQty: number      // contracts at best ask (0 for DEX legs)
  url?: string
}

export interface SportsOpportunity extends Opportunity {
  sportKey: string
  tournamentName: string | null
  marketType: string
  dexMarketName?: string
  sportsLegs: SportsOpportunityLeg[]
}

export interface SportsOpportunitiesResponse {
  items: SportsOpportunity[]
  total: number
  limit: number
  offset: number
}

export interface StatsResponse {
  activeCount: number
  avgProfit: number
  maxProfit: number
  totalFound: number
  connectedClients: number
}

export interface Platform {
  id: string
  slug: string
  name: string
  baseUrl: string
  isActive: boolean
  pollIntervalMs: number
  lastPolledAt: string
}

// WebSocket events
export interface NewOpportunityEvent {
  id: string
  matchTitle: string
  profitPercentage: number
  totalCost: number
  legs: ArbitrageLeg[]
  type: 'binary' | 'multi'
  foundAt: string
}

export interface UpdatedOpportunityEvent {
  id: string
  profitPercentage: number
  totalCost: number
  legs: ArbitrageLeg[]
  lastValidatedAt: string
}

export interface ExpiredOpportunityEvent {
  id: string
  expiredAt: string
}

// OrderBook
export interface OrderBookEntry {
  price: number      // 0.0 - 1.0
  quantity: number   // кол-во контрактов
}

export interface OrderBook {
  bids: OrderBookEntry[]   // sorted by price DESC
  asks: OrderBookEntry[]   // sorted by price ASC
  lastPrice?: number
  timestamp?: number       // Unix ms
}

export interface LegOrderBook {
  platformSlug: string
  platformName: string
  outcomeName: string
  orderBook: OrderBook
  /** Суммарное кол-во контрактов в стакане (asks) */
  availableQuantity: number
  /** Лучший ASK */
  effectivePrice: number
}

export interface ArbitrageTier {
  /** Кол-во контрактов в этом тире */
  quantity: number
  /** Цена на каждой платформе */
  legPrices: {
    platformSlug: string
    platformName: string
    outcomeName: string
    price: number
    url?: string
  }[]
  /** Суммарная стоимость за 1 контракт (все ноги) */
  totalCostPerContract: number
  /** % прибыли: (1.0 - totalCost) / totalCost * 100 */
  profitPercentage: number
  /** Вложение для этого тира: quantity * totalCostPerContract */
  investmentAmount: number
  /** Гросс профит: quantity * (1.0 - totalCostPerContract) */
  grossProfit: number
}

export interface ArbitrageTiersSummary {
  /** Тиры от лучшего к худшему профиту */
  tiers: ArbitrageTier[]
  /** Суммарно контрактов по всем тирам */
  totalQuantity: number
  /** Суммарное вложение ($) */
  totalInvestment: number
  /** Суммарный гросс профит ($) */
  totalGrossProfit: number
  /** Средневзвешенный % прибыли */
  weightedAvgProfit: number
  /** Лучший % (первый тир) */
  bestProfitPercentage: number
  /** Худший % (последний тир, но всё ещё прибыльный) */
  worstProfitPercentage: number
}

export interface OrderBookAnalysisResponse {
  opportunityId: string
  matchTitle?: string
  /** Ордербук каждой ноги (сырые данные) */
  legs: LegOrderBook[]
  /** Исполняемые тиры арбитража */
  tiers: ArbitrageTiersSummary
  /** Когда был сделан анализ */
  analyzedAt: string
}
