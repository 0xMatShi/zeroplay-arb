import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  versionApi,
  authApi,
  subscriptionsApi,
  arbitrageApi,
  sportsArbApi,
  dashboardApi,
} from './client'
import type { CreateDashboardTradeDto } from './types'

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
  dashboardStats: (period: string) => ['dashboard', 'stats', period] as const,
  dashboardTrades: (limit: number, offset: number) => ['dashboard', 'trades', limit, offset] as const,
  dashboardLeaderboard: ['dashboard', 'leaderboard'] as const,
  dashboardProfile: ['dashboard', 'profile'] as const,
  dashboardMyStats: (period: string) => ['dashboard', 'my-stats', period] as const,
  dashboardMyTrades: ['dashboard', 'my-trades'] as const,
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

/**
 * Dashboard hooks
 */
export const useDashboardStats = (period: '1d' | '7d' | '30d' | 'all' = '1d') => {
  return useQuery({
    queryKey: queryKeys.dashboardStats(period),
    queryFn: () => dashboardApi.getStats(period),
    refetchInterval: 60_000,
  })
}

export const useDashboardTrades = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: queryKeys.dashboardTrades(limit, offset),
    queryFn: () => dashboardApi.getTrades(limit, offset),
    staleTime: 30_000,
  })
}

export const useDashboardLeaderboard = () => {
  return useQuery({
    queryKey: queryKeys.dashboardLeaderboard,
    queryFn: dashboardApi.getLeaderboard,
    staleTime: 60_000,
  })
}

export const useDashboardProfile = () => {
  return useQuery({
    queryKey: queryKeys.dashboardProfile,
    queryFn: dashboardApi.getProfile,
    enabled: !!localStorage.getItem('apiKey'),
    retry: false,
  })
}

export const useDashboardMyStats = (period: '1d' | '7d' | '30d' | 'all' = 'all') => {
  return useQuery({
    queryKey: queryKeys.dashboardMyStats(period),
    queryFn: () => dashboardApi.getMyStats(period),
    enabled: !!localStorage.getItem('apiKey'),
    retry: false,
  })
}

export const useDashboardMyTrades = () => {
  return useQuery({
    queryKey: queryKeys.dashboardMyTrades,
    queryFn: dashboardApi.getMyTrades,
    enabled: !!localStorage.getItem('apiKey'),
  })
}

export const useCreateDashboardTrade = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateDashboardTradeDto) => dashboardApi.createTrade(dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export const useUpdateDashboardTrade = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: Partial<CreateDashboardTradeDto> }) =>
      dashboardApi.updateTrade(id, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export const useDeleteDashboardTrade = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => dashboardApi.deleteTrade(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export const useUpdateDashboardNickname = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (nickname: string) => dashboardApi.updateNickname(nickname),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardProfile })
    },
  })
}
