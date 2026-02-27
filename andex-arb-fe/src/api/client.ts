import type {
  VersionDto,
  RequestSiweDto,
  RequestSiweResponseDto,
  VerifySignatureDto,
  VerifySignatureResponseDto,
  WhoamiResponse,
  PlanDto,
  CreatePaymentRequestDto,
  PaymentRequestResponseDto,
  SubscriptionStatusDto,
  ActiveSubscriptionDto,
  SubscriptionHistoryItemDto,
  OpportunitiesResponse,
  StatsResponse,
  Platform,
  OrderBookAnalysisResponse,
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

  if (response.status === 401 || response.status === 403) {
    const body = await response.json().catch(() => ({}))
    throw new ApiError(body.message ?? response.statusText, response.status)
  }

  throw new Error(`Request failed: ${response.statusText}`)
}

const getBackendUrl = () => {
  return import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
}

const getApiKey = () => {
  // Получаем API ключ из localStorage или другого места
  return localStorage.getItem('apiKey') || ''
}

const createHeaders = (includeAuth = false): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }

  if (includeAuth) {
    const apiKey = getApiKey()
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
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
  requestSiwe: async (data: RequestSiweDto): Promise<RequestSiweResponseDto> => {
    const response = await fetch(`${getBackendUrl()}/auth/siwe/request`, {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw new Error(`Failed to request SIWE: ${response.statusText}`)
    }

    return response.json()
  },

  verifySignature: async (data: VerifySignatureDto): Promise<VerifySignatureResponseDto> => {
    const response = await fetch(`${getBackendUrl()}/auth/siwe/verify`, {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw new Error(`Failed to verify signature: ${response.statusText}`)
    }

    return response.json()
  },

  whoami: async (): Promise<WhoamiResponse> => {
    const response = await fetch(`${getBackendUrl()}/auth/siwe/whoami`, {
      method: 'GET',
      headers: createHeaders(true),
    })

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.statusText}`)
    }

    return response.json()
  },
}

/**
 * Plans API
 */
export const plansApi = {
  findAll: async (): Promise<PlanDto[]> => {
    const response = await fetch(`${getBackendUrl()}/plans`, {
      method: 'GET',
      headers: createHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to get plans: ${response.statusText}`)
    }

    return response.json()
  },

  findOne: async (id: string): Promise<PlanDto> => {
    const response = await fetch(`${getBackendUrl()}/plans/${id}`, {
      method: 'GET',
      headers: createHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to get plan: ${response.statusText}`)
    }

    return response.json()
  },
}

/**
 * Payments API
 */
export const paymentsApi = {
  createPaymentRequest: async (data: CreatePaymentRequestDto): Promise<PaymentRequestResponseDto> => {
    const response = await fetch(`${getBackendUrl()}/payments/request`, {
      method: 'POST',
      headers: createHeaders(true),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw new Error(`Failed to create payment request: ${response.statusText}`)
    }

    return response.json()
  },

  getMyPaymentRequests: async (): Promise<PaymentRequestResponseDto[]> => {
    const response = await fetch(`${getBackendUrl()}/payments/my-requests`, {
      method: 'GET',
      headers: createHeaders(true),
    })

    if (!response.ok) {
      throw new Error(`Failed to get payment requests: ${response.statusText}`)
    }

    return response.json()
  },

  cancelPaymentRequest: async (id: string): Promise<PaymentRequestResponseDto> => {
    const response = await fetch(`${getBackendUrl()}/payments/request/${id}`, {
      method: 'DELETE',
      headers: createHeaders(true),
    })

    if (!response.ok) {
      throw new Error(`Failed to cancel payment request: ${response.statusText}`)
    }

    return response.json()
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
