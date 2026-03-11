import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys, authApi } from '../api'

interface ApiKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function ApiKeyModal({ isOpen, onClose, onSuccess }: ApiKeyModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async () => {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      setError(t('apiKey.errorEmpty'))
      return
    }

    try {
      setIsLoading(true)
      setError(null)
      const { sessionToken } = await authApi.createSession(trimmed)
      localStorage.setItem('apiKey', trimmed)
      localStorage.setItem('sessionToken', sessionToken)
      queryClient.invalidateQueries({ queryKey: queryKeys.whoami })
      setApiKey('')
      onSuccess()
    } catch {
      setError(t('apiKey.errorInvalid'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('apiKey.title')}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p>{t('apiKey.prompt')}</p>
          <div className="api-key-form">
            <div className="api-key-input-wrapper">
              <input
                type="text"
                className="api-key-input"
                placeholder={t('apiKey.placeholder')}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                disabled={isLoading}
              />
            </div>
            {error && <p className="api-key-error">{error}</p>}
            <button className="primary-button api-key-submit" onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? t('apiKey.loading') : t('apiKey.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
