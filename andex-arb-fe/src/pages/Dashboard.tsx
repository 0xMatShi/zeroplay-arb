import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useWhoami, useActiveSubscription } from '../api'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { clearAuthCookies } from '../utils/authCookies'

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: user, isLoading: isLoadingUser } = useWhoami()
  const { data: activeSubscription } = useActiveSubscription()

  useEffect(() => {
    const apiKey = localStorage.getItem('apiKey')
    if (!isLoadingUser && !user && !apiKey) {
      navigate('/')
    }
  }, [user, isLoadingUser, navigate])

  const calculateTimeRemaining = (expiresAt: Date) => {
    const diff = expiresAt.getTime() - Date.now()
    if (diff <= 0) return { days: 0, hours: 0 }
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    return { days, hours }
  }

  const calculateProgress = (startsAt: Date, expiresAt: Date) => {
    const total = expiresAt.getTime() - startsAt.getTime()
    const elapsed = Date.now() - startsAt.getTime()
    return Math.max(0, Math.min(100, (elapsed / total) * 100))
  }

  if (isLoadingUser) {
    return (
      <div className="dashboard">
        <div className="container">
          <div className="loading">{t('dashboard.loading')}</div>
        </div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="dashboard">
      <div className="dashboard-container">
        <div className="dashboard-main">
          {/* Status Banner */}
          {activeSubscription ? (
            <div className="status-banner status-banner--active">
              <span className="status-banner-icon">●</span>
              <span>{t('dashboard.statusActive', { plan: activeSubscription.planSlug ?? 'Active' })}</span>
            </div>
          ) : (
            <div className="status-banner status-banner--inactive">
              <span className="status-banner-icon">○</span>
              <span>{t('dashboard.statusNoSub')}</span>
            </div>
          )}

          <div className="dashboard-header">
            <div className="dashboard-header-left">
              <h1>{t('dashboard.title')}</h1>
              <button
                className={`scanner-button ${!activeSubscription ? 'scanner-button--locked' : ''}`}
                onClick={() => navigate('/scanner')}
              >
                {!activeSubscription && <span className="scanner-lock-icon">🔒</span>}
                {t('dashboard.openScanner')}
              </button>
            </div>
            <div className="user-info">
              <LanguageSwitcher />
              <button className="logout-button" onClick={() => {
                localStorage.removeItem('apiKey')
                localStorage.removeItem('sessionToken')
                clearAuthCookies()
                queryClient.clear()
                navigate('/')
              }}>
                {t('dashboard.logout')}
              </button>
            </div>
          </div>

          {/* Active Subscription Panel */}
          {activeSubscription && (
            <section className="dashboard-section">
              <div className="system-status-panel">
                <div className="status-panel-top">
                  <div className="status-panel-plan">
                    <span className="status-panel-label">{t('dashboard.systemStatusOnline')}</span>
                    <span className="plan-name-large">{activeSubscription.planSlug ?? 'Active'}</span>
                  </div>
                  {activeSubscription.expiresAt && (
                    <div className="status-panel-time">
                      <span className="status-panel-time-label">{t('dashboard.timeLeft')}</span>
                      <span className="status-panel-time-value">
                        {calculateTimeRemaining(new Date(activeSubscription.expiresAt)).days}{t('dashboard.daysShort')}{' '}
                        {calculateTimeRemaining(new Date(activeSubscription.expiresAt)).hours}{t('dashboard.hoursShort')}
                      </span>
                    </div>
                  )}
                </div>

                {activeSubscription.expiresAt && (
                  <div className="time-progress">
                    <div className="progress-bar-container">
                      <div
                        className="progress-bar-fill"
                        style={{
                          width: `${100 - calculateProgress(
                            new Date(activeSubscription.startsAt),
                            new Date(activeSubscription.expiresAt),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="system-specs">
                  <div className="spec-item">
                    <span className="spec-icon">⚡</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.dataFeed')}</span>
                      <span className="spec-value">{t('dashboard.realTime')}</span>
                    </div>
                  </div>
                  <div className="spec-item">
                    <span className="spec-icon">↗</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.telegramAlerts')}</span>
                      <span className="spec-value">{t('dashboard.activeStatus')}</span>
                    </div>
                  </div>
                  <div className="spec-item">
                    <span className="spec-icon">◈</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.accessLevel')}</span>
                      <span className="spec-value">{t('dashboard.tier1')}</span>
                    </div>
                  </div>
                </div>

                <div className="status-panel-actions">
                  <button className="status-btn-primary" onClick={() => navigate('/scanner')}>
                    {t('dashboard.launchScanner')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* No Subscription — direct to Telegram */}
          {!activeSubscription && (
            <section className="dashboard-section">
              <div className="system-status-panel">
                <p>{t('dashboard.noSubInfo')}</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
