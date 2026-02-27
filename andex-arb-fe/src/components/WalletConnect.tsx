import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import { fetchSiweMessage, verifySiweMessage, parseSiweMessage } from '../utils/siwe'
import type { Address } from 'viem'

export function WalletConnect() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [isSigning, setIsSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSignIn = async () => {
    if (!address) {
      setError('Wallet not connected')
      return
    }

    try {
      setIsSigning(true)
      setError(null)
      setSuccess(null)

      // Запрашиваем SIWE сообщение с backend'а
      const message = await fetchSiweMessage(address as Address)
      
      // Парсим сообщение для проверки
      const siweMessage = parseSiweMessage(message)
      
      // Подписываем сообщение
      const signature = await signMessageAsync({
        message: siweMessage.prepareMessage(),
      })

      // Верифицируем подпись на backend'е
      const result = await verifySiweMessage(message, signature, address as Address)
      
      if (result.success) {
        setSuccess('Successfully signed in with Ethereum!')
        console.log('Verification result:', result.data)
      } else {
        setError('Verification failed')
      }
    } catch (err) {
      console.error('SIWE error:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign in')
    } finally {
      setIsSigning(false)
    }
  }

  if (isConnected) {
    return (
      <div className="card">
        <h2>Wallet Connected</h2>
        <p>Address: {address}</p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '20px' }}>
          <button onClick={handleSignIn} disabled={isSigning}>
            {isSigning ? 'Signing...' : 'Sign In with Ethereum'}
          </button>
          <button onClick={() => disconnect()}>Disconnect</button>
        </div>
        {error && (
          <div style={{ color: 'red', marginTop: '10px' }}>
            Error: {error}
          </div>
        )}
        {success && (
          <div style={{ color: 'green', marginTop: '10px' }}>
            {success}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="card">
      <h2>Connect Wallet</h2>
      <p>Connect your wallet to sign in with Ethereum</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
        {connectors.map((connector) => (
          <button
            key={connector.uid}
            onClick={() => connect({ connector })}
            disabled={isPending}
          >
            {connector.name}
            {isPending && ' (connecting...)'}
          </button>
        ))}
      </div>
    </div>
  )
}
