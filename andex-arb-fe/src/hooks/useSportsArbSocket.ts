import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../api/hooks'
import type { SportsOpportunitiesResponse, SportsOpportunity } from '../api/types'

const getBackendUrl = () => {
  return import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
}

export type SportsSocketAuthError = 'auth_required' | 'subscription_required' | null

interface UseSportsArbSocketOptions {
  onNewOpportunity?: (data: SportsOpportunity) => void
  paused?: boolean
}

export function useSportsArbSocket(options?: UseSportsArbSocketOptions) {
  const [isConnected, setIsConnected] = useState(false)
  const [authError, setAuthError] = useState<SportsSocketAuthError>(null)
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()
  const isFirstConnect = useRef(true)

  const onNewOpportunityRef = useRef(options?.onNewOpportunity)
  onNewOpportunityRef.current = options?.onNewOpportunity
  const pausedRef = useRef(options?.paused ?? false)
  pausedRef.current = options?.paused ?? false
  const prevPausedRef = useRef(options?.paused ?? false)

  const refetchAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sportsOpportunities })
  }, [queryClient])

  // Refetch once when unpausing
  useEffect(() => {
    const paused = options?.paused ?? false
    if (prevPausedRef.current && !paused) {
      refetchAll()
    }
    prevPausedRef.current = paused
  }, [options?.paused, refetchAll])

  useEffect(() => {
    const apiKey = localStorage.getItem('apiKey') || ''

    const socket = io(`${getBackendUrl()}/sports-arbitrage`, {
      transports: ['websocket'],
      auth: { apiKey },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setIsConnected(true)
      setAuthError(null)
      isFirstConnect.current = false
    })

    socket.on('disconnect', () => {
      setIsConnected(false)
    })

    socket.on('error', (err: { message?: string }) => {
      const msg = err?.message?.toLowerCase() ?? ''
      if (msg.includes('subscription')) {
        setAuthError('subscription_required')
      } else {
        setAuthError('auth_required')
      }
      socket.disconnect()
    })

    // New opportunity
    socket.on('sports:new', (data: SportsOpportunity) => {
      if (pausedRef.current) return
      queryClient.setQueryData<SportsOpportunitiesResponse>(
        queryKeys.sportsOpportunities,
        (old) => {
          if (!old) return old
          // Deduplicate: if already in cache treat as update to avoid duplicate keys
          if (old.items.some((item) => item.id === data.id)) {
            return { ...old, items: old.items.map((item) => (item.id === data.id ? data : item)) }
          }
          return { ...old, items: [data, ...old.items], total: old.total + 1 }
        },
      )
      onNewOpportunityRef.current?.(data)
    })

    // Updated opportunity (prices changed)
    socket.on('sports:updated', (data: Partial<SportsOpportunity> & { id: string }) => {
      if (pausedRef.current) return
      queryClient.setQueryData<SportsOpportunitiesResponse>(
        queryKeys.sportsOpportunities,
        (old) => {
          if (!old) return old
          const index = old.items.findIndex((item) => item.id === data.id)
          if (index === -1) return old
          const prev = old.items[index]
          const updatedItems = [...old.items]
          updatedItems[index] = {
            ...prev,
            ...(data.profitPercentage != null && { profitPercentage: data.profitPercentage }),
            ...(data.totalCost != null && { totalCost: data.totalCost }),
            ...(data.legs != null && { legs: data.legs }),
            ...(data.lastValidatedAt != null && { lastValidatedAt: data.lastValidatedAt }),
            ...(data.sportsLegs != null && { sportsLegs: data.sportsLegs }),
          }
          // Transition from non-profitable → profitable: treat as new for notifications
          const wasNonProfit = prev.profitPercentage <= 0
          const isNowProfit = data.profitPercentage != null && data.profitPercentage > 0
          if (wasNonProfit && isNowProfit) {
            onNewOpportunityRef.current?.(updatedItems[index])
          }
          return { ...old, items: updatedItems }
        },
      )
    })

    // Full snapshot on connect + every 5s — initializes or replaces entire cache
    socket.on('sports:snapshot', (data: SportsOpportunity[]) => {
      if (pausedRef.current) return
      queryClient.setQueryData<SportsOpportunitiesResponse>(
        queryKeys.sportsOpportunities,
        (old) => ({ ...(old ?? { items: [], total: 0 }), items: data, total: data.length }),
      )
    })

    // Expired opportunity
    socket.on('sports:expired', (data: { id: string }) => {
      if (pausedRef.current) return
      queryClient.setQueryData<SportsOpportunitiesResponse>(
        queryKeys.sportsOpportunities,
        (old) => {
          if (!old) return old
          const filtered = old.items.filter((item) => item.id !== data.id)
          if (filtered.length === old.items.length) return old
          return { ...old, items: filtered, total: old.total - 1 }
        },
      )
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [queryClient, refetchAll])

  return { isConnected, authError }
}
