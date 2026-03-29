// Version
export interface VersionDto {
  name: string
  version: string
  environment: string
}

// Auth
export interface WhoamiResponse {
  id: string
  address: string | null
  createdAt: string
  updatedAt: string
}

// Subscriptions
export interface SubscriptionStatusDto {
  active: boolean
}

export interface ActiveSubscriptionDto {
  id: string
  planSlug: string | null
  status: string
  startsAt: string
  expiresAt: string | null
  createdAt: string
}

export interface SubscriptionHistoryItemDto {
  id: string
  planSlug: string | null
  status: string
  startsAt: string
  expiresAt: string | null
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
  platform: 'polymarket' | 'dexsport' | 'pinnacle' | 'stake' | 'cloudbet' | 'pari' | 'fonbet'
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
  startTime?: number | null
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

// Dashboard
export interface DashboardProfile {
  id: string
  userId: string
  nickname: string
  createdAt: string
  updatedAt: string
}

export interface DashboardTrade {
  id: string
  userId: string
  bookmaker1: string
  bookmaker2: string
  eventName: string
  sport: string | null
  outcome1: string | null
  outcome2: string | null
  odds1: number
  odds2: number
  stake1: number
  stake2: number
  profit: number | null
  profitPercent: number | null
  isPublic: boolean
  winner: string | null
  comment: string | null
  createdAt: string
  updatedAt: string
}

export interface DashboardTradeWithNickname extends DashboardTrade {
  nickname: string
}

export interface DashboardGlobalStats {
  periodProfit: number
  periodTrades: number
  periodBestProfit: number
}

export interface DashboardMyStats {
  totalProfit: number
  totalTrades: number
  bestProfit: number
}

export interface DashboardLeaderboardEntry {
  userId: string
  nickname: string
  totalTrades: number
  totalProfit: number
  bestProfit: number
}

export interface DashboardProfileResponse {
  profile: DashboardProfile
  stats: DashboardMyStats
}

export interface CreateDashboardTradeDto {
  bookmaker1: string
  bookmaker2: string
  eventName: string
  sport?: string
  outcome1?: string
  outcome2?: string
  odds1: number
  odds2: number
  stake1: number
  stake2: number
  profit?: number
  profitPercent?: number
  isPublic?: boolean
  winner?: string
  comment?: string
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
