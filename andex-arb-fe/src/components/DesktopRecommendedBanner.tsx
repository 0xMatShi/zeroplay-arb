import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './DesktopRecommendedBanner.css'

const STORAGE_KEY = 'desktop_recommended_banner_hidden'

export function DesktopRecommendedBanner() {
  const { t } = useTranslation()
  const [isHidden, setIsHidden] = useState(false)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') {
        setIsHidden(true)
      }
    } catch {
      // Ignore storage failures in private mode.
    }
  }, [])

  const handleClose = () => {
    setIsHidden(true)
    try {
      window.localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Ignore storage failures in private mode.
    }
  }

  if (isHidden) return null

  return (
    <div className="desktop-recommended-banner" role="status" aria-live="polite">
      <div className="desktop-recommended-banner__text">
        <strong>{t('mobileNotice.title')}</strong>
        <span>{t('mobileNotice.message')}</span>
      </div>
      <button
        type="button"
        className="desktop-recommended-banner__close"
        aria-label={t('mobileNotice.close')}
        onClick={handleClose}
      >
        ×
      </button>
    </div>
  )
}
