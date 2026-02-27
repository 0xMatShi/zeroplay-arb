import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../api/hooks'
import type {
  OpportunitiesResponse,
  Opportunity,
  NewOpportunityEvent,
  UpdatedOpportunityEvent,
  ExpiredOpportunityEvent,
} from '../api/types'

const getBackendUrl = () => {
  return import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
}

export type SocketAuthError = 'auth_required' | 'subscription_required' | null

interface UseArbitrageSocketOptions {
  onNewOpportunity?: (data: NewOpportunityEvent) => void
}

export function useArbitrageSocket(options?: UseArbitrageSocketOptions) {
  const [isConnected, setIsConnected] = useState(false)
  const [authError, setAuthError] = useState<SocketAuthError>(null)
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()
  const isFirstConnect = useRef(true)

  const onNewOpportunityRef = useRef(options?.onNewOpportunity)
  onNewOpportunityRef.current = options?.onNewOpportunity

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.opportunities })
    queryClient.invalidateQueries({ queryKey: queryKeys.arbitrageStats })
  }, [queryClient])

  useEffect(() => {
    const apiKey = localStorage.getItem('apiKey') || ''

    const socket = io(`${getBackendUrl()}/arbitrage`, {
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

      if (!isFirstConnect.current) {
        invalidateAll()
      }
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

    // Новая арбитражная возможность
    socket.on('opportunity:new', (data: NewOpportunityEvent) => {
      queryClient.setQueryData<OpportunitiesResponse>(
        queryKeys.opportunities,
        (old) => {
          if (!old) return old

          const newOpportunity: Opportunity = {
            ...data,
            status: 'active',
            lastValidatedAt: data.foundAt,
            expiredAt: null,
            guaranteedPayout: 1.0,
          }

          return {
            ...old,
            items: [newOpportunity, ...old.items],
            total: old.total + 1,
          }
        }
      )

      // Инвалидируем статистику — изменилось кол-во активных
      queryClient.invalidateQueries({ queryKey: queryKeys.arbitrageStats })

      // Вызываем callback для toast
      onNewOpportunityRef.current?.(data)
    })

    // Обновление цен существующей возможности
    socket.on('opportunity:updated', (data: UpdatedOpportunityEvent) => {
      queryClient.setQueryData<OpportunitiesResponse>(
        queryKeys.opportunities,
        (old) => {
          if (!old) return old

          const index = old.items.findIndex((item) => item.id === data.id)

          // Неизвестный id — могли пропустить opportunity:new, перезагружаем
          if (index === -1) {
            invalidateAll()
            return old
          }

          const updatedItems = [...old.items]
          updatedItems[index] = {
            ...updatedItems[index],
            profitPercentage: data.profitPercentage,
            totalCost: data.totalCost,
            legs: data.legs,
            lastValidatedAt: data.lastValidatedAt,
          }

          return {
            ...old,
            items: updatedItems,
          }
        }
      )
    })

    // Арбитраж истёк
    socket.on('opportunity:expired', (data: ExpiredOpportunityEvent) => {
      queryClient.setQueryData<OpportunitiesResponse>(
        queryKeys.opportunities,
        (old) => {
          if (!old) return old

          // Неизвестный id — просто игнорируем
          const filtered = old.items.filter((item) => item.id !== data.id)
          if (filtered.length === old.items.length) return old

          return {
            ...old,
            items: filtered,
            total: old.total - 1,
          }
        }
      )

      // Инвалидируем статистику
      queryClient.invalidateQueries({ queryKey: queryKeys.arbitrageStats })
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [queryClient, invalidateAll])

  return { isConnected, authError }
}
