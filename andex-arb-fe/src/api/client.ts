import { clearAuthCookies } from '../utils/authCookies'
import type {
  VersionDto,
  WhoamiResponse,
  SubscriptionStatusDto,
  ActiveSubscriptionDto,
  SubscriptionHistoryItemDto,
  OpportunitiesResponse,
  SportsOpportunitiesResponse,
  StatsResponse,
  Platform,
  OrderBookAnalysisResponse,
  DashboardGlobalStats,
  DashboardTradeWithNickname,
  DashboardLeaderboardEntry,
  DashboardProfileResponse,
  DashboardTrade,
  CreateDashboardTradeDto,
} from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json()

  const body = await response.json().catch(() => ({}))

  if (response.status === 401 || response.status === 403) {
    const hadSession = !!localStorage.getItem('sessionToken')
    if (hadSession) {
      localStorage.removeItem('apiKey')
      localStorage.removeItem('sessionToken')
      clearAuthCookies()
      window.dispatchEvent(new CustomEvent('auth:unauthorized'))
    }
    throw new ApiError(body.message ?? response.statusText, response.status)
  }

  throw new ApiError(body.message ?? response.statusText, response.status)
}

const getBackendUrl = () => {
  return import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
}

const getApiKey = () => localStorage.getItem('apiKey') || ''
const getSessionToken = () => localStorage.getItem('sessionToken') || ''

const createHeaders = (includeAuth = false): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }

  if (includeAuth) {
    const apiKey = getApiKey()
    const sessionToken = getSessionToken()
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    if (sessionToken) headers['X-Session-Token'] = sessionToken
  }

  return headers
}

/**
 * Version API
 */
export const versionApi = {
  getVersion: async (): Promise<VersionDto> => {
    const response = await fetch(`${getBackendUrl()}/version`, {
      method: 'GET',
      headers: createHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to get version: ${response.statusText}`)
    }

    return response.json()
  },
}

/**
 * Auth API
 */
export const authApi = {
  createSession: async (apiKey: string): Promise<{ sessionToken: string }> => {
    const response = await fetch(`${getBackendUrl()}/auth/siwe/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    })
    if (!response.ok) {
      throw new ApiError('Invalid API key', response.status)
    }
    return response.json()
  },

  whoami: async (): Promise<WhoamiResponse> => {
    const response = await fetch(`${getBackendUrl()}/auth/siwe/whoami`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },
}

/**
 * Subscriptions API (requires auth)
 */
export const subscriptionsApi = {
  getStatus: async (): Promise<SubscriptionStatusDto> => {
    const response = await fetch(`${getBackendUrl()}/subscriptions/status`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  getActive: async (): Promise<ActiveSubscriptionDto | null> => {
    const response = await fetch(`${getBackendUrl()}/subscriptions/active`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  getHistory: async (): Promise<SubscriptionHistoryItemDto[]> => {
    const response = await fetch(`${getBackendUrl()}/subscriptions/history`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },
}

/**
 * Sports Arbitrage API — PM vs BM (requires auth + active subscription)
 */
export const sportsArbApi = {
  getOpportunities: async (): Promise<SportsOpportunitiesResponse> => {
    const response = await fetch(
      `${getBackendUrl()}/sports-arbitrage/opportunities`,
      { method: 'GET', headers: createHeaders(true) }
    )
    return handleResponse(response)
  },

  getStats: async (): Promise<StatsResponse> => {
    const response = await fetch(`${getBackendUrl()}/sports-arbitrage/stats`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },
}

/**
 * Arbitrage API (requires auth + active subscription)
 */
export const arbitrageApi = {
  getOpportunities: async (limit = 50, offset = 0): Promise<OpportunitiesResponse> => {
    const response = await fetch(
      `${getBackendUrl()}/arbitrage/opportunities?limit=${limit}&offset=${offset}`,
      { method: 'GET', headers: createHeaders(true) }
    )
    return handleResponse(response)
  },

  getStats: async (): Promise<StatsResponse> => {
    const response = await fetch(`${getBackendUrl()}/arbitrage/stats`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  getPlatforms: async (): Promise<Platform[]> => {
    const response = await fetch(`${getBackendUrl()}/arbitrage/platforms`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  getOrderBook: async (opportunityId: string): Promise<OrderBookAnalysisResponse> => {
    const response = await fetch(
      `${getBackendUrl()}/arbitrage/opportunities/${opportunityId}/orderbook`,
      { method: 'GET', headers: createHeaders(true) }
    )
    return handleResponse(response)
  },
}

/**
 * Dashboard API
 */
export const dashboardApi = {
  getStats: async (): Promise<DashboardGlobalStats> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/stats`, {
      method: 'GET',
      headers: createHeaders(),
    })
    return handleResponse(response)
  },

  getTrades: async (limit = 50, offset = 0): Promise<{ trades: DashboardTradeWithNickname[]; total: number }> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/trades?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      headers: createHeaders(),
    })
    return handleResponse(response)
  },

  getLeaderboard: async (): Promise<DashboardLeaderboardEntry[]> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/leaderboard`, {
      method: 'GET',
      headers: createHeaders(),
    })
    return handleResponse(response)
  },

  getProfile: async (): Promise<DashboardProfileResponse> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/profile`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  updateNickname: async (nickname: string): Promise<{ id: string; nickname: string }> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/profile`, {
      method: 'PUT',
      headers: createHeaders(true),
      body: JSON.stringify({ nickname }),
    })
    return handleResponse(response)
  },

  getMyTrades: async (): Promise<DashboardTrade[]> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/my-trades`, {
      method: 'GET',
      headers: createHeaders(true),
    })
    return handleResponse(response)
  },

  createTrade: async (dto: CreateDashboardTradeDto): Promise<DashboardTrade> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/trades`, {
      method: 'POST',
      headers: createHeaders(true),
      body: JSON.stringify(dto),
    })
    return handleResponse(response)
  },

  updateTrade: async (id: string, dto: Partial<CreateDashboardTradeDto>): Promise<DashboardTrade> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/trades/${id}`, {
      method: 'PUT',
      headers: createHeaders(true),
      body: JSON.stringify(dto),
    })
    return handleResponse(response)
  },

  deleteTrade: async (id: string): Promise<void> => {
    const response = await fetch(`${getBackendUrl()}/dashboard/trades/${id}`, {
      method: 'DELETE',
      headers: createHeaders(true),
    })
    if (!response.ok) throw new Error(`Delete failed: ${response.statusText}`)
  },
}
