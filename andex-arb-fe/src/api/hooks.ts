import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  versionApi,
  authApi,
  subscriptionsApi,
  arbitrageApi,
  sportsArbApi,
} from './client'

/**
 * Query keys для кеширования
 */
export const queryKeys = {
  version: ['version'] as const,
  whoami: ['auth', 'whoami'] as const,
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
export const useLoginWithApiKey = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (apiKey: string) => {
      localStorage.setItem('apiKey', apiKey)
      return apiKey
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.whoami })
    },
  })
}

export const useWhoami = () => {
  return useQuery({
    queryKey: queryKeys.whoami,
    queryFn: authApi.whoami,
    enabled: !!localStorage.getItem('apiKey'),
    retry: false,
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
    refetchInterval: 30_000,
  })
}

export const usePlatforms = () => {
  return useQuery({
    queryKey: queryKeys.platforms,
    queryFn: arbitrageApi.getPlatforms,
  })
}

export const useSportsOpportunities = () => {
  return useQuery({
    queryKey: queryKeys.sportsOpportunities,
    queryFn: sportsArbApi.getOpportunities,
    enabled: false,
    initialData: { items: [], total: 0, limit: 100, offset: 0 },
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
    staleTime: 30_000,
    gcTime: 60_000,
  })
}
