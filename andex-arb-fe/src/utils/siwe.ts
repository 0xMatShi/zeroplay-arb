import { SiweMessage } from 'siwe'
import { Address } from 'viem'

/**
 * Запрашивает SIWE сообщение с backend'а
 * @param address - Ethereum адрес пользователя
 * @returns Promise с SIWE сообщением
 */
export async function fetchSiweMessage(address: Address): Promise<string> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
  
  const response = await fetch(`${backendUrl}/auth/siwe/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address }),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch SIWE message: ${response.statusText}`)
  }

  const data = await response.json()
  return data.message
}

/**
 * Верифицирует подписанное SIWE сообщение на backend'е
 * @param message - SIWE сообщение
 * @param signature - Подпись сообщения
 * @returns Promise с результатом верификации
 */
export async function verifySiweMessage(
  message: string,
  signature: `0x${string}`,
  address: Address
): Promise<{ success: boolean; data?: {
  apiKey: string
  user: {
    id: string
    address: Address
  }
} }> {
  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'
  
  const response = await fetch(`${backendUrl}/auth/siwe/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, signature, address }),
  })

  if (!response.ok) {
    throw new Error(`Failed to verify SIWE message: ${response.statusText}`)
  }

  const data = await response.json()
  return {
    success: true,
    data
  }
}

/**
 * Парсит SIWE сообщение
 */
export function parseSiweMessage(message: string): SiweMessage {
  return new SiweMessage(message)
}
