import { useState, useMemo, useCallback, useRef, useEffect, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Toast } from '../components/Toast'
import { useOpportunities, useArbitrageStats, usePlatforms, useOrderBook, useSubscriptionStatus } from '../api/hooks'
import { useArbitrageSocket } from '../hooks/useArbitrageSocket'
import { ApiError } from '../api/client'
import { formatRelativeTime } from '../utils/time'
import type { Opportunity, NewOpportunityEvent, OrderBookAnalysisResponse, ArbitrageTier } from '../api/types'

type SortMode = 'profit' | 'profitUsd' | 'newest'
type TypeFilter = 'all' | 'binary' | 'multi'
const POLYMARKET_MIN_PRICE = 0.5

// --- Error Boundary ---

class CardErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Card render error:', error, info)
  }
  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

// --- OrderBook Panel (per-card) ---

function OrderBookPanel({ data, isLoading, isError, isOpen, locale }: {
  data: OrderBookAnalysisResponse | undefined
  isLoading: boolean
  isError: boolean
  isOpen: boolean
  locale: string
}) {
  const { t } = useTranslation()

  const ob = data
  const tiersSummary = ob?.tiers
  const hasTiers = (tiersSummary?.tiers.length ?? 0) > 0

  const summaryRow = ob && tiersSummary ? (
    <div className="ob-summary">
      <div className="ob-summary-item">
        <span className="ob-summary-label">{t('scanner.tiersBestProfit')}</span>
        <span className="ob-summary-value ob-summary-value--green">
          {hasTiers ? `+${tiersSummary.bestProfitPercentage.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className="ob-summary-item">
        <span className="ob-summary-label">{t('scanner.tiersTotalContracts')}</span>
        <span className={`ob-summary-value ${!hasTiers ? 'ob-summary-value--warn' : ''}`}>
          {hasTiers ? tiersSummary.totalQuantity.toFixed(0) : t('scanner.noTiers')}
        </span>
      </div>
      <div className="ob-summary-item">
        <span className="ob-summary-label">{t('scanner.tiersTotalInvestment')}</span>
        <span className="ob-summary-value">${tiersSummary.totalInvestment.toFixed(2)}</span>
      </div>
      <div className="ob-summary-item">
        <span className="ob-summary-label">{t('scanner.tiersTotalGrossProfit')}</span>
        <span className="ob-summary-value ob-summary-value--green">
          ${tiersSummary.totalGrossProfit.toFixed(2)}
        </span>
      </div>
      <div className="ob-summary-item">
        <span className="ob-summary-label">{t('scanner.tiersAvgProfit')}</span>
        <span className="ob-summary-value">+{tiersSummary.weightedAvgProfit.toFixed(2)}%</span>
      </div>
    </div>
  ) : null

  if (!isOpen) {
    if (!summaryRow) return null
    return <div className="ob-panel ob-panel--summary-only">{summaryRow}</div>
  }

  if (isLoading && !ob) {
    return (
      <div className="ob-panel">
        <div className="ob-loading">{t('scanner.loadingOrderbook')}</div>
      </div>
    )
  }

  if (isError || !ob) {
    return (
      <div className="ob-panel">
        <div className="ob-error">{t('scanner.orderbookError')}</div>
      </div>
    )
  }

  return (
    <div className="ob-panel">
      {summaryRow}

      {!hasTiers && (
        <div className="ob-no-liquidity-hint">{t('scanner.noTiersHint')}</div>
      )}

      {/* Tiers table */}
      {hasTiers && tiersSummary && (
        <div className="ob-tiers-table-wrapper">
          <table className="ob-tiers-table">
            <thead>
              <tr>
                <th>{t('scanner.tiersTableQty')}</th>
                {tiersSummary.tiers[0].legPrices.map((lp, i) => (
                  <th key={i}>{lp.platformName} ({lp.outcomeName})</th>
                ))}
                <th>{t('scanner.tiersTableCost')}</th>
                <th>{t('scanner.tiersTableProfit')}</th>
                <th>{t('scanner.tiersTableInvestment')}</th>
                <th>{t('scanner.tiersTableGross')}</th>
              </tr>
            </thead>
            <tbody>
              {tiersSummary.tiers.map((tier: ArbitrageTier, i: number) => (
                <tr key={i} className={i === 0 ? 'ob-tier-row--best' : ''}>
                  <td>{tier.quantity}</td>
                  {tier.legPrices.map((lp, j) => (
                    <td key={j}>
                      ${lp.price.toFixed(2)}
                      {lp.url && (
                        <a href={lp.url} target="_blank" rel="noopener noreferrer" className="ob-tier-link" title={lp.platformName}>
                          &#8599;
                        </a>
                      )}
                    </td>
                  ))}
                  <td>${tier.totalCostPerContract.toFixed(2)}</td>
                  <td className="ob-tier-profit">+{tier.profitPercentage.toFixed(2)}%</td>
                  <td>${tier.investmentAmount.toFixed(2)}</td>
                  <td className="ob-tier-gross">${tier.grossProfit.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}



      {/* Analyzed at */}
      <div className="ob-analyzed-at">
        {t('scanner.analyzedAt', { time: formatRelativeTime(ob.analyzedAt, locale) })}
      </div>
    </div>
  )
}

// --- Opportunity Card ---

function OpportunityCard({
  opp,
  index,
  locale,
}: {
  opp: Opportunity
  index: number
  locale: string
}) {
  const { t } = useTranslation()
  const [obOpen, setObOpen] = useState(false)
  const { data: obData, isLoading: obLoading, isError: obError } = useOrderBook(opp.id, true)
  const ob = obData as OrderBookAnalysisResponse | undefined

  return (
    <div
      className={`opportunity-card opportunity-card--clickable ${obOpen ? 'opportunity-card--expanded' : ''}`}
      style={{ animationDelay: `${index * 0.05}s`, cursor: 'pointer' }}
      onClick={() => setObOpen((prev) => !prev)}
    >
      {/* Card Header */}
      <div className="opp-header">
        <div className="opp-header-left">
          <span className={`opp-type-badge opp-type-badge--${opp.type}`}>
            {opp.type.toUpperCase()}
          </span>
          <h3 className="opp-match-title">
            {opp.legs.map((leg, i) => (
              <span key={i}>
                {i > 0 && <span className="opp-match-title__sep"> / </span>}
                <span className="opp-match-title__platform">({leg.platformName})</span>
                {' '}
                {leg.eventTitle}
              </span>
            ))}
          </h3>
        </div>
        <div className="opp-header-right">
          {(() => {
            const displayProfit = opp.weightedAvgProfit ?? opp.profitPercentage
            return (
              <span className={`opp-profit ${displayProfit < 0.5 ? 'opp-profit--dim' : ''}`}>
                {t('scanner.profit', { value: displayProfit.toFixed(2) })}
              </span>
            )
          })()}
        </div>
      </div>

      {/* Legs */}
      <div className="opp-legs">
        {opp.legs.map((leg, legIndex) => {
          const obLeg = ob?.legs?.[legIndex]
          return (
          <div key={legIndex} className="arb-leg">
            <div className="leg-platform">{leg.platformName}</div>
            <div className="leg-outcome">
              <span className="leg-outcome-label">{t('scanner.buy')}</span>
              <span className="leg-outcome-name">{leg.outcomeName}</span>
            </div>
            <div className="leg-price">
              ${(obLeg ? obLeg.effectivePrice : leg.price).toFixed(2)}
            </div>
            {leg.url && (
              <a
                href={leg.url}
                target="_blank"
                rel="noopener noreferrer"
                className="leg-open-link"
                onClick={(e) => e.stopPropagation()}
              >
                {t('scanner.openPlatform')}
              </a>
            )}
          </div>
          )
        })}
      </div>

      {/* OrderBook Panel */}
      <OrderBookPanel data={ob} isLoading={obLoading} isError={obError} isOpen={obOpen} locale={locale} />

      {/* Card Footer */}
      <div className="opp-footer">
        <div className="opp-cost-payout">
          <span className="opp-cost">
            {t('scanner.totalCost', { value: opp.totalCost.toFixed(4) })}
          </span>
          <span className="opp-arrow">&rarr;</span>
          <span className="opp-payout">
            {t('scanner.payout', { value: opp.guaranteedPayout.toFixed(2) })}
          </span>
        </div>
        <div className="opp-footer-right">
          <div className="opp-timestamps">
            <span className="opp-timestamp">
              {t('scanner.foundAt', { time: formatRelativeTime(opp.foundAt, locale) })}
            </span>
            <span className="opp-timestamp">
              {t('scanner.validatedAt', { time: formatRelativeTime(opp.lastValidatedAt, locale) })}
            </span>
          </div>
          <button
            className={`ob-toggle-button ${obOpen ? 'ob-toggle-button--active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              if (obOpen) setObOpen(false)
              else setObOpen(true)
            }}
          >
            {obOpen ? t('scanner.hideDepth') : t('scanner.viewDepth')}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Scanner Page ---

export function Scanner() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [minRoi, setMinRoi] = useState(0.5)
  const [soundRoi, setSoundRoi] = useState(1)
  const [waitTimeSec, setWaitTimeSec] = useState(0)
  const [selectedPlatforms, setSelectedPlatforms] = useState<Record<string, boolean>>({})
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('profit')
  const [showPolymarketMin50c, setShowPolymarketMin50c] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [isPaused, setIsPaused] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  // Subscription gate: check before loading arbitrage data
  const { data: subStatus, isLoading: isSubLoading } = useSubscriptionStatus()
  const hasSubscription = subStatus?.active === true
  const noApiKey = !localStorage.getItem('apiKey')

  // Data — only fetch when subscription is confirmed active
  const { data: opportunitiesData, isLoading, isError, error } = useOpportunities()
  const { data: stats } = useArbitrageStats()
  const { data: platforms } = usePlatforms()

  // Access control: subscription check first, then fallback to API 401/403
  const blockedReason = useMemo(() => {
    if (noApiKey) return 'auth_required' as const
    if (!isSubLoading && subStatus && !hasSubscription) return 'subscription_required' as const
    if (error instanceof ApiError) {
      if (error.status === 401) return 'auth_required' as const
      if (error.status === 403) return 'subscription_required' as const
    }
    return null
  }, [noApiKey, isSubLoading, subStatus, hasSubscription, error])

  // WebSocket
  const playOpportunitySound = useCallback(() => {
    if (!soundEnabled) return

    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext()
      }
      const audioCtx = audioContextRef.current
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume()
      }

      const now = audioCtx.currentTime
      const notes: Array<{ freq: number; offset: number; duration: number; type: OscillatorType }> = [
        { freq: 880, offset: 0, duration: 0.08, type: 'triangle' },
        { freq: 1320, offset: 0.1, duration: 0.11, type: 'sine' },
      ]

      notes.forEach((note) => {
        const oscillator = audioCtx.createOscillator()
        const gainNode = audioCtx.createGain()

        oscillator.type = note.type
        oscillator.frequency.setValueAtTime(note.freq, now + note.offset)

        gainNode.gain.setValueAtTime(0.0001, now + note.offset)
        gainNode.gain.exponentialRampToValueAtTime(0.08, now + note.offset + 0.01)
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + note.offset + note.duration)

        oscillator.connect(gainNode)
        gainNode.connect(audioCtx.destination)

        oscillator.start(now + note.offset)
        oscillator.stop(now + note.offset + note.duration)
      })
    } catch {
      // Ignore if audio playback is blocked by browser policy.
    }
  }, [soundEnabled])

  const handleNewOpportunity = useCallback((data: NewOpportunityEvent) => {
    if (data.profitPercentage >= soundRoi) {
      playOpportunitySound()
    }
    setToast({
      message: t('scanner.newOpportunity', {
        profit: data.profitPercentage.toFixed(2),
        title: data.matchTitle,
      }),
      type: 'success',
    })
  }, [t, playOpportunitySound, soundRoi])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const { isConnected, authError: wsAuthError } = useArbitrageSocket({
    onNewOpportunity: handleNewOpportunity,
    paused: isPaused,
  })

  const effectiveBlockedReason = blockedReason ?? wsAuthError

  // Initialize platform toggles from API data
  const platformSlugs = useMemo(() => {
    if (!platforms) return []
    return platforms.filter((p) => p.isActive).map((p) => p.slug)
  }, [platforms])

  // Effective selected platforms — default to all enabled
  const effectivePlatforms = useMemo(() => {
    if (Object.keys(selectedPlatforms).length === 0 && platformSlugs.length > 0) {
      const defaults: Record<string, boolean> = {}
      platformSlugs.forEach((slug) => {
        defaults[slug] = true
      })
      return defaults
    }
    return selectedPlatforms
  }, [selectedPlatforms, platformSlugs])

  const togglePlatform = (slug: string) => {
    setSelectedPlatforms((prev) => {
      const current = Object.keys(prev).length === 0
        ? platformSlugs.reduce((acc, s) => ({ ...acc, [s]: true }), {} as Record<string, boolean>)
        : prev
      return { ...current, [slug]: !current[slug] }
    })
  }

  // Filter & sort opportunities
  const filteredOpportunities = useMemo(() => {
    if (!opportunitiesData?.items) return []

    let result = opportunitiesData.items.filter((opp: Opportunity) => {
      // Search filter
      if (searchQuery && !opp.matchTitle.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false
      }

      // Min ROI filter
      const effectiveRoi = opp.weightedAvgProfit ?? opp.profitPercentage
      if (effectiveRoi < minRoi) {
        return false
      }

      // Wait time filter (age since first seen)
      if (waitTimeSec > 0) {
        const ageSeconds = Math.max(0, (nowMs - new Date(opp.foundAt).getTime()) / 1000)
        if (ageSeconds < waitTimeSec) {
          return false
        }
      }

      // Type filter
      if (typeFilter !== 'all' && opp.type !== typeFilter) {
        return false
      }

      // Platform filter — show only if ALL legs belong to enabled platforms
      const allLegsSelected = opp.legs.every(
        (leg) => effectivePlatforms[leg.platformSlug] === true
      )
      if (!allLegsSelected) {
        return false
      }

      // Polymarket pre-filter — hide low-priced legs (< $0.50) when enabled
      if (showPolymarketMin50c) {
        const hasLowPolymarketLeg = opp.legs.some((leg) => {
          const slug = leg.platformSlug.toLowerCase()
          const name = leg.platformName.toLowerCase()
          const isPolymarket = slug === 'polymarket' || name.includes('polymarket')
          return isPolymarket && leg.price < POLYMARKET_MIN_PRICE
        })

        if (hasLowPolymarketLeg) {
          return false
        }
      }

      return true
    })

    // Sort
    result = [...result].sort((a, b) => {
      if (sortMode === 'profit') {
        const pa = a.weightedAvgProfit ?? a.profitPercentage
        const pb = b.weightedAvgProfit ?? b.profitPercentage
        return pb - pa
      }
      if (sortMode === 'profitUsd') {
        const pa = a.totalGrossProfit ?? 0
        const pb = b.totalGrossProfit ?? 0
        return pb - pa
      }
      // newest
      return new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime()
    })

    return result
  }, [opportunitiesData, searchQuery, minRoi, waitTimeSec, nowMs, typeFilter, effectivePlatforms, sortMode, showPolymarketMin50c])

  const filteredAvgProfit = useMemo(() => {
    if (filteredOpportunities.length === 0) return null
    const sum = filteredOpportunities.reduce((acc, o) => acc + (o.weightedAvgProfit ?? o.profitPercentage), 0)
    return sum / filteredOpportunities.length
  }, [filteredOpportunities])

  const filteredMaxProfit = useMemo(() => {
    if (filteredOpportunities.length === 0) return null
    return Math.max(...filteredOpportunities.map((o) => o.weightedAvgProfit ?? o.profitPercentage))
  }, [filteredOpportunities])

  const locale = i18n.language === 'ru' ? 'ru' : 'en'

  return (
    <div className="scanner-page">
      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
          duration={4000}
        />
      )}

      {/* Header */}
      <div className="scanner-header">
        <div className="scanner-header-left">
          <h1 className="scanner-title">{t('scanner.title')}</h1>
          <div className="scanner-status">
            <span className="status-label">{t('scanner.systemLabel')}</span>
            <span className="status-value">
              {isPaused ? t('scanner.paused') : isConnected ? t('scanner.scanning') : t('scanner.wsReconnecting')}
            </span>
            <span className={`status-pulse ${isPaused ? 'status-pulse--paused' : isConnected ? '' : 'status-pulse--offline'}`}></span>
          </div>
        </div>
        <div className="scanner-header-right">
          <LanguageSwitcher />
          <button className="scanner-back-button" onClick={() => navigate('/dashboard')}>
            {t('scanner.backToDashboard')}
          </button>
        </div>
      </div>

      {/* Access Wall */}
      {effectiveBlockedReason && (
        <div className="access-wall">
          <div className="access-wall-content">
            <span className="access-wall-icon">🔒</span>
            <h2>{effectiveBlockedReason === 'subscription_required'
              ? t('scanner.subscriptionRequired')
              : t('scanner.loginRequired')
            }</h2>
            <p>{effectiveBlockedReason === 'subscription_required'
              ? t('scanner.subscriptionRequiredDesc')
              : t('scanner.loginRequiredDesc')
            }</p>
            <button
              className="primary-button"
              onClick={() => navigate(effectiveBlockedReason === 'subscription_required' ? '/dashboard' : '/')}
            >
              {effectiveBlockedReason === 'subscription_required'
                ? t('scanner.goToPayment')
                : t('scanner.goToLogin')
              }
            </button>
          </div>
        </div>
      )}

      {!effectiveBlockedReason && <>
      {/* Stats Bar */}
      <div className="stats-bar">
        <div className="stats-item">
          <span className="stats-label">{t('scanner.statsActive')}</span>
          <span className="stats-value">{stats?.activeCount ?? '—'}</span>
        </div>
        <div className="stats-item">
          <span className="stats-label">{t('scanner.statsAvgProfit')}</span>
          <span className="stats-value stats-value--green">
            {filteredAvgProfit !== null ? `+${filteredAvgProfit.toFixed(2)}%` : '—'}
          </span>
        </div>
        <div className="stats-item">
          <span className="stats-label">{t('scanner.statsMaxProfit')}</span>
          <span className="stats-value stats-value--green">
            {filteredMaxProfit !== null ? `+${filteredMaxProfit.toFixed(2)}%` : '—'}
          </span>
        </div>
        <div className="stats-item">
          <span className="stats-label">WS:</span>
          <span className={`stats-ws-badge ${isConnected ? 'stats-ws-badge--online' : 'stats-ws-badge--offline'}`}>
            {isConnected ? t('scanner.wsConnected') : t('scanner.wsDisconnected')}
          </span>
        </div>
      </div>

      {/* Filter Panel */}
      <div className="filter-panel">
        <div className="filter-group filter-search">
          <input
            type="text"
            placeholder={t('scanner.filterPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="filter-input"
          />
        </div>

        <div className="filter-group">
          <label className="filter-label">{t('scanner.type')}</label>
          <div className="roi-buttons">
            {(['all', 'binary', 'multi'] as TypeFilter[]).map((value) => (
              <button
                key={value}
                className={`roi-button ${typeFilter === value ? 'active' : ''}`}
                onClick={() => setTypeFilter(value)}
              >
                {t(`scanner.type${value.charAt(0).toUpperCase() + value.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <label className="filter-label">{t('scanner.sortBy')}</label>
          <div className="roi-buttons">
            {(['profit', 'profitUsd', 'newest'] as SortMode[]).map((value) => (
              <button
                key={value}
                className={`roi-button ${sortMode === value ? 'active' : ''}`}
                onClick={() => setSortMode(value)}
              >
                {t(`scanner.sort${value.charAt(0).toUpperCase() + value.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>

        {platformSlugs.length > 0 && (
          <div className="filter-group">
            <label className="filter-label">{t('scanner.platforms')}</label>
            <div className="market-toggles">
              {platforms?.filter((p) => p.isActive).map((platform) => (
                <button
                  key={platform.slug}
                  className={`market-toggle ${effectivePlatforms[platform.slug] !== false ? 'active' : ''}`}
                  onClick={() => togglePlatform(platform.slug)}
                >
                  [{effectivePlatforms[platform.slug] !== false ? 'x' : ' '}] {platform.name.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filter-group polymarket-config">
          <label className="filter-label">{t('scanner.polymarketConfig')}</label>
          <button
            type="button"
            className={`switch-toggle ${showPolymarketMin50c ? 'switch-toggle--active' : ''}`}
            onClick={() => setShowPolymarketMin50c((prev) => !prev)}
            aria-pressed={showPolymarketMin50c}
          >
            <span className="switch-toggle-label">{t('scanner.showPolymarketAbove50')}</span>
            <span className="switch-toggle-track">
              <span className="switch-toggle-thumb" />
            </span>
          </button>
        </div>

        <div className="filter-group scanner-settings">
          <label className="filter-label">{t('scanner.settings')}</label>
          <div className="settings-panel">
            <div className="settings-toolbar">
              <button
                type="button"
                className={`settings-icon-button ${soundEnabled ? 'active' : ''}`}
                onClick={() => setSoundEnabled((prev) => !prev)}
                aria-label={soundEnabled ? t('scanner.soundOn') : t('scanner.soundOff')}
                title={soundEnabled ? t('scanner.soundOn') : t('scanner.soundOff')}
                style={{ color: '#fff' }}
              >
                <span className="settings-icon-content" aria-hidden="true">
                  {soundEnabled
                    ? <Volume2 size={16} color="#fff" style={{ stroke: '#fff' }} />
                    : <VolumeX size={16} color="#fff" style={{ stroke: '#fff' }} />
                  }
                </span>
              </button>

              <button
                type="button"
                className={`settings-icon-button settings-icon-button--pause ${isPaused ? 'active' : ''}`}
                onClick={() => setIsPaused((prev) => !prev)}
                aria-label={isPaused ? t('scanner.resumeScanner') : t('scanner.pauseScanner')}
                title={isPaused ? t('scanner.resumeScanner') : t('scanner.pauseScanner')}
                style={{ color: '#fff' }}
              >
                <span className="settings-icon-content" aria-hidden="true">
                  {isPaused
                    ? <Play size={16} color="#fff" style={{ stroke: '#fff' }} />
                    : <Pause size={16} color="#fff" style={{ stroke: '#fff' }} />
                  }
                </span>
              </button>
            </div>

            <div className="settings-sliders">
              <div className="settings-slider-row">
                <div className="settings-slider-head">
                  <span className="settings-slider-label">{t('scanner.settingsMinRoi')}</span>
                  <span className="settings-slider-value">{minRoi.toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.1}
                  value={minRoi}
                  onChange={(e) => setMinRoi(Number(e.target.value))}
                  className="settings-range"
                />
              </div>

              <div className="settings-slider-row">
                <div className="settings-slider-head">
                  <span className="settings-slider-label">{t('scanner.settingsSoundRoi')}</span>
                  <span className="settings-slider-value settings-slider-value--accent">{soundRoi.toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.1}
                  value={soundRoi}
                  onChange={(e) => setSoundRoi(Number(e.target.value))}
                  className="settings-range"
                />
              </div>

              <div className="settings-slider-row">
                <div className="settings-slider-head">
                  <span className="settings-slider-label">{t('scanner.settingsWaitTime')}</span>
                  <span className="settings-slider-value">{waitTimeSec}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={120}
                  step={1}
                  value={waitTimeSec}
                  onChange={(e) => setWaitTimeSec(Number(e.target.value))}
                  className="settings-range"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Opportunities List */}
      <div className="opportunities-list">
        {isLoading ? (
          <div className="empty-state">
            <p>{t('scanner.loading')}</p>
          </div>
        ) : isError ? (
          <div className="empty-state">
            <p>{t('scanner.errorLoading')}</p>
          </div>
        ) : filteredOpportunities.length === 0 ? (
          <div className="empty-state">
            <p>{t('scanner.noOpportunities')}</p>
            <p className="empty-hint">{t('scanner.emptyHint')}</p>
          </div>
        ) : (
          filteredOpportunities.map((opp, index) => (
            <CardErrorBoundary key={opp.id}>
              <OpportunityCard opp={opp} index={index} locale={locale} />
            </CardErrorBoundary>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="scanner-footer">
        <p>{t('scanner.opportunitiesFound', { count: filteredOpportunities.length })}</p>
        <p className="scanner-disclaimer">{t('scanner.disclaimerText')}</p>
      </div>
      </>}
    </div>
  )
}
