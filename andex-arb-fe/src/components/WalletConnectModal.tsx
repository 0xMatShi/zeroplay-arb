import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import { useTranslation } from 'react-i18next'
import { parseSiweMessage } from '../utils/siwe'
import { useRequestSiwe, useVerifySignature } from '../api'
import { Toast } from './Toast'

interface WalletConnectModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  planId?: string
}

export function WalletConnectModal({ isOpen, onClose, onSuccess }: WalletConnectModalProps) {
  const { t } = useTranslation()
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [isSigning, setIsSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const requestSiwe = useRequestSiwe()
  const verifySignature = useVerifySignature()

  const handleSignIn = async () => {
    if (!address) {
      setError(t('wallet.walletNotConnected'))
      return
    }

    try {
      setIsSigning(true)
      setError(null)

      const { message } = await requestSiwe.mutateAsync({ address: address as string })
      const siweMessage = parseSiweMessage(message)
      
      const signature = await signMessageAsync({
        message: siweMessage.prepareMessage(),
      })

      const result = await verifySignature.mutateAsync({
        address: address as string,
        message,
        signature,
      })
      
      if (result.apiKey) {
        onSuccess()
      }
    } catch (err) {
      console.error('SIWE error:', err)
      setError(err instanceof Error ? err.message : t('wallet.failedSignIn'))
    } finally {
      setIsSigning(false)
    }
  }

  const handleDisconnect = () => {
    disconnect()
    setError(null)
  }

  if (!isOpen) return null

  if (isPending || isSigning) {
    return (
      <div className="modal-overlay">
        <div className="modal-content">
          <div className="modal-loading">
            <div className="loading-spinner"></div>
            <div className="loading-text">
              {isPending && t('wallet.connecting')}
              {isSigning && t('wallet.verifying')}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{t('wallet.connectTitle')}</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          
          <div className="modal-body">
            {!isConnected ? (
              <>
                <p>{t('wallet.connectPrompt')}</p>
                <div className="wallet-connectors">
                  {connectors.map((connector) => (
                    <button
                      key={connector.uid}
                      className="wallet-button"
                      onClick={() => connect({ connector })}
                      disabled={isPending}
                    >
                      {connector.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="wallet-info">
                  <p><strong>{t('wallet.connected')}</strong> {address}</p>
                  <button className="secondary-button" onClick={handleDisconnect}>
                    {t('wallet.disconnect')}
                  </button>
                </div>
                
                <button
                  className="primary-button"
                  onClick={handleSignIn}
                  disabled={isSigning}
                >
                  {t('wallet.signIn')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <Toast
          message={`[ERROR] ${error.toUpperCase()}`}
          type="error"
          onClose={() => setError(null)}
        />
      )}
    </>
  )
}
