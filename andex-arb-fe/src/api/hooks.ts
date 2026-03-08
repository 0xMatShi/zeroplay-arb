import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  versionApi,
  authApi,
  plansApi,
  paymentsApi,
  subscriptionsApi,
  arbitrageApi,
  sportsArbApi,
} from './client'
import type {
  RequestSiweDto,
  VerifySignatureDto,
  CreatePaymentRequestDto,
  PlanDto,
} from './types'

const MOCK_PLANS: PlanDto[] = [
  {
    id: 'mock-free',
    name: 'Basic',
    description: 'Basic access to the scanner',
    price: '19.9',
    durationDays: 7,
    isActive: true,
  },
  {
    id: 'mock-pro',
    name: 'Medium',
    description: 'Extended access with more opportunities',
    price: '99.9',
    durationDays: 30,
    isActive: true,
  },
  {
    id: 'mock-enterprise',
    name: 'Pro',
    description: 'Maximum access for active trading',
    price: '199.9',
    durationDays: 30,
    isActive: true,
  },
]

/**
 * Query keys для кеширования
 */
export const queryKeys = {
  version: ['version'] as const,
  whoami: ['auth', 'whoami'] as const,
  plans: ['plans'] as const,
  plan: (id: string) => ['plans', id] as const,
  paymentRequests: ['payments', 'requests'] as const,
  subscriptionStatus: ['subscriptions', 'status'] as const,
  activeSubscription: ['subscriptions', 'active'] as const,
  subscriptionHistory: ['subscriptions', 'history'] as const,
  opportunities: ['arbitrage', 'opportunities'] as const,
  arbitrageStats: ['arbitrage', 'stats'] as const,
  platforms: ['arbitrage', 'platforms'] as const,
  orderBook: (id: string) => ['arbitrage', 'orderbook', id] as const,
  sportsOpportunities: ['sports-arbitrage', 'opportunities'] as const,
  sportsStats: ['sports-arbitrage', 'stats'] as const,
}

/**
 * Version hooks
 */
export const useVersion = () => {
  return useQuery({
    queryKey: queryKeys.version,
    queryFn: versionApi.getVersion,
  })
}

/**
 * Auth hooks
 */
export const useRequestSiwe = () => {
  return useMutation({
    mutationFn: (data: RequestSiweDto) => authApi.requestSiwe(data),
  })
}

export const useVerifySignature = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: VerifySignatureDto) => authApi.verifySignature(data),
    onSuccess: (data) => {
      // Сохраняем API ключ в localStorage
      localStorage.setItem('apiKey', data.apiKey)
      // Инвалидируем whoami запрос
      queryClient.invalidateQueries({ queryKey: queryKeys.whoami })
    },
  })
}

export const useWhoami = () => {
  return useQuery({
    queryKey: queryKeys.whoami,
    queryFn: authApi.whoami,
    enabled: !!localStorage.getItem('apiKey'), // Запрос выполняется только если есть API ключ
    retry: false, // Не повторяем запрос при ошибке 401
  })
}

/**
 * Plans hooks
 */
export const usePlans = () => {
  return useQuery({
    queryKey: queryKeys.plans,
    queryFn: async () => {
      try {
        const data = await plansApi.findAll()
        if (data && data.length > 0) return data
        return MOCK_PLANS
      } catch {
        return MOCK_PLANS
      }
    },
  })
}

export const usePlan = (id: string) => {
  return useQuery({
    queryKey: queryKeys.plan(id),
    queryFn: () => plansApi.findOne(id),
    enabled: !!id, // Запрос выполняется только если есть id
  })
}

/**
 * Payments hooks
 */
export const useCreatePaymentRequest = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreatePaymentRequestDto) => paymentsApi.createPaymentRequest(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paymentRequests })
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
      queryClient.invalidateQueries({ queryKey: queryKeys.activeSubscription })
    },
  })
}

export const useMyPaymentRequests = (polling = false) => {
  return useQuery({
    queryKey: queryKeys.paymentRequests,
    queryFn: paymentsApi.getMyPaymentRequests,
    enabled: !!localStorage.getItem('apiKey'),
    refetchInterval: polling ? 5_000 : false,
  })
}

export const useCancelPaymentRequest = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => paymentsApi.cancelPaymentRequest(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paymentRequests })
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
      queryClient.invalidateQueries({ queryKey: queryKeys.activeSubscription })
    },
  })
}

/**
 * Subscription hooks
 */
export const useSubscriptionStatus = () => {
  return useQuery({
    queryKey: queryKeys.subscriptionStatus,
    queryFn: subscriptionsApi.getStatus,
    enabled: !!localStorage.getItem('apiKey'),
  })
}

export const useActiveSubscription = () => {
  return useQuery({
    queryKey: queryKeys.activeSubscription,
    queryFn: subscriptionsApi.getActive,
    enabled: !!localStorage.getItem('apiKey'),
  })
}

export const useSubscriptionHistory = () => {
  return useQuery({
    queryKey: queryKeys.subscriptionHistory,
    queryFn: subscriptionsApi.getHistory,
    enabled: !!localStorage.getItem('apiKey'),
  })
}

/**
 * Arbitrage hooks
 */
export const useOpportunities = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: queryKeys.opportunities,
    queryFn: () => arbitrageApi.getOpportunities(limit, offset),
  })
}

export const useArbitrageStats = () => {
  return useQuery({
    queryKey: queryKeys.arbitrageStats,
    queryFn: arbitrageApi.getStats,
    refetchInterval: 30_000, // обновляем статистику раз в 30 сек
  })
}

export const usePlatforms = () => {
  return useQuery({
    queryKey: queryKeys.platforms,
    queryFn: arbitrageApi.getPlatforms,
  })
}

export const useSportsOpportunities = (paused = false) => {
  return useQuery({
    queryKey: queryKeys.sportsOpportunities,
    queryFn: sportsArbApi.getOpportunities,
    refetchInterval: paused ? false : 5_000,
  })
}

export const useSportsStats = () => {
  return useQuery({
    queryKey: queryKeys.sportsStats,
    queryFn: sportsArbApi.getStats,
    refetchInterval: 5_000,
  })
}

export const useOrderBook = (opportunityId: string, enabled = false) => {
  return useQuery({
    queryKey: queryKeys.orderBook(opportunityId),
    queryFn: () => arbitrageApi.getOrderBook(opportunityId),
    enabled: enabled && !!opportunityId,
    staleTime: 30_000, // не рефетчим чаще чем раз в 30 сек (особенно важно при enabled:true на всех карточках)
    gcTime: 60_000, // держим в кеше 60 сек после размонтирования
  })
}
