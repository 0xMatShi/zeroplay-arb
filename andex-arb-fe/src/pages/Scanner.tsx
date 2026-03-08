import { useState, useMemo, useCallback, useRef, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Toast } from '../components/Toast'
import { useOpportunities, usePlatforms, useOrderBook, useSubscriptionStatus, useSportsOpportunities, queryKeys } from '../api/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { useArbitrageSocket } from '../hooks/useArbitrageSocket'
import { ApiError } from '../api/client'
import { formatRelativeTime } from '../utils/time'
import type { Opportunity, SportsOpportunity, SportsOpportunityLeg, NewOpportunityEvent, OrderBookAnalysisResponse, ArbitrageTier } from '../api/types'

type SortMode = 'profit' | 'profitUsd' | 'newest'
type TypeFilter = 'all' | 'binary' | 'multi'
type LiveFilter = 'all' | 'live' | 'pre'
type ArbMode = 'pm-pm' | 'pm-bm'
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
  arbMode,
}: {
  opp: Opportunity
  index: number
  locale: string
  arbMode: ArbMode
}) {
  const { t } = useTranslation()
  const [obOpen, setObOpen] = useState(false)
  const isPmPm = arbMode === 'pm-pm'
  const { data: obData, isLoading: obLoading, isError: obError } = useOrderBook(opp.id, isPmPm)
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

      {/* OrderBook Panel — only for PM-PM */}
      {isPmPm && (
        <OrderBookPanel data={ob} isLoading={obLoading} isError={obError} isOpen={obOpen} locale={locale} />
      )}

      {/* Card Footer */}
      <div className="opp-footer">
        <div className="opp-timestamps">
          <span className="opp-timestamp">
            {t('scanner.foundAt', { time: formatRelativeTime(opp.foundAt, locale) })}
          </span>
          <span className="opp-timestamp">
            {t('scanner.validatedAt', { time: formatRelativeTime(opp.lastValidatedAt, locale) })}
          </span>
        </div>
        {isPmPm && (
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
        )}
      </div>
    </div>
  )
}

// --- Helpers ---

const MARKET_TYPE_LABELS: Record<string, string> = {
  moneyline: 'Match Winner',
  totals: 'Total',
  spreads: 'Handicap',
  child_moneyline: 'Map Winner',
}

function formatMarketType(mt: string): string {
  return MARKET_TYPE_LABELS[mt] ?? mt
}

// --- Sports Opportunity Card (PM-BM) ---

function SportsOpportunityCard({
  opp,
  index,
  perfectAmount,
  isPinned,
  isStale,
  onPin,
  onUnpin,
}: {
  opp: SportsOpportunity
  index: number
  perfectAmount: number
  isPinned: boolean
  isStale: boolean
  onPin: (opp: SportsOpportunity) => void
  onUnpin: (id: string) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const pmLeg: SportsOpportunityLeg | undefined = opp.sportsLegs?.find(l => l.platform === 'polymarket')
  const dexLeg: SportsOpportunityLeg | undefined = opp.sportsLegs?.find(l => l.platform === 'dexsport')

  const totalCost = opp.totalCost
  const profitPct = opp.profitPercentage
  const isNegative = profitPct <= 0

  // Perfect amounts (proportional to leg probability)
  const pmPerfect = pmLeg ? perfectAmount * (pmLeg.probability / totalCost) : 0
  const dexPerfect = dexLeg ? perfectAmount * (dexLeg.probability / totalCost) : 0

  // Real amounts (limited by PM best ask qty)
  const pmQty = pmLeg?.pmBestAskQty ?? 0
  const pmReal = pmLeg ? pmQty * pmLeg.probability : 0
  const dexReal = dexLeg ? pmQty * dexLeg.probability : 0
  const realTotal = pmQty * totalCost
  const profitUsd = realTotal > 0 ? realTotal * (profitPct / 100) : 0

  const sportLabel = (opp.sportKey ?? '').toUpperCase()
  const secsAgo = Math.floor((Date.now() - new Date(opp.lastValidatedAt).getTime()) / 1000)
  const displayMarketType = opp.dexMarketName || formatMarketType(opp.marketType)

  let cardClass = 'opportunity-card sports-card'
  if (isPinned && !isStale) cardClass += ' sports-card--pinned'
  else if (isPinned && isStale) cardClass += ' sports-card--pinned-stale'
  else if (isStale) cardClass += ' sports-card--stale'

  return (
    <div className={cardClass} style={{ animationDelay: `${index * 0.05}s` }}>
      {/* Main row */}
      <div className="sports-card-main" onClick={() => setExpanded(prev => !prev)}>

        {/* Left: event info */}
        <div className="sports-card-info">
          <div className="sports-event-title">
            {opp.matchTitle}{opp.tournamentName ? ` — ${opp.tournamentName}` : ''}
          </div>
          <div className="sports-badges">
            {sportLabel && <span className="sports-sport-badge">{sportLabel}</span>}
            {opp.isLive ? (
              <span className="sports-live-badge sports-live-badge--live">
                <span className="sports-live-dot" />
                LIVE
              </span>
            ) : (
              <span className="sports-live-badge sports-live-badge--pre">PRE</span>
            )}
            <span className="sports-validated">{secsAgo}s</span>
          </div>
          <div className="sports-market-type">{displayMarketType}</div>
        </div>

        {/* Center: platform boxes */}
        <div className="sports-card-platforms">
          {/* Polymarket box */}
          <div className="sports-platform-box">
            <div className="sports-platform-label sports-platform-label--pm">POLYMARKET</div>
            <div className="sports-outcome-name">{pmLeg?.outcomeName ?? '—'}</div>
            <div className="sports-amounts-inline">
              <span className="sports-amount-key">A:</span>
              <span className="sports-amount-val">${pmPerfect.toFixed(0)}</span>
              <span className="sports-amounts-sep">|</span>
              <span className="sports-amount-key">R:</span>
              <span className="sports-amount-val">${pmReal.toFixed(0)}</span>
            </div>
            <div className="sports-price-row">
              {pmLeg ? (
                <>
                  <span className="sports-cents">{(pmLeg.probability * 100).toFixed(0)}¢</span>
                  <span className="sports-odds">{pmLeg.decimalOdds.toFixed(2)}x</span>
                </>
              ) : <span className="sports-cents">—</span>}
            </div>
          </div>

          {/* DexSport box */}
          <div className="sports-platform-box">
            <div className="sports-platform-label sports-platform-label--dex">DEXSPORT</div>
            <div className="sports-outcome-name">{dexLeg?.outcomeName ?? '—'}</div>
            <div className="sports-amounts-inline">
              <span className="sports-amount-key">A:</span>
              <span className="sports-amount-val">${dexPerfect.toFixed(0)}</span>
              <span className="sports-amounts-sep">|</span>
              <span className="sports-amount-key">R:</span>
              <span className="sports-amount-val">${dexReal.toFixed(0)}</span>
            </div>
            <div className="sports-price-row">
              {dexLeg ? (
                <>
                  <span className="sports-cents">{(dexLeg.probability * 100).toFixed(0)}¢</span>
                  <span className="sports-odds">{dexLeg.decimalOdds.toFixed(2)}x</span>
                </>
              ) : <span className="sports-cents">—</span>}
            </div>
          </div>
        </div>

        {/* Right: Spread + Profit */}
        <div className="sports-card-metrics">
          <div className="sports-metric-box">
            <div className={`sports-metric-value ${isNegative ? 'sports-metric-value--neg' : 'sports-metric-value--pos'}`}>
              {isNegative ? '' : '+'}{profitPct.toFixed(2)}%
            </div>
          </div>
          <div className="sports-metric-box">
            <div className={`sports-metric-value ${(isNegative || profitUsd === 0) ? 'sports-metric-value--neg' : 'sports-metric-value--pos'}`}>
              {profitUsd === 0 ? '—' : `${isNegative ? '-' : '+'}$${Math.abs(profitUsd).toFixed(2)}`}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded: action buttons */}
      <div className={`sports-card-actions ${expanded ? 'sports-card-actions--open' : ''}`}>
        <button
          className={`sports-action-btn sports-action-btn--pin ${isPinned ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isPinned) onUnpin(opp.id)
            else onPin(opp)
          }}
        >
          {isPinned ? t('scanner.unpin') : t('scanner.pin')}
        </button>
        <button
          className="sports-action-btn sports-action-btn--calc"
          onClick={(e) => e.stopPropagation()}
        >
          {t('scanner.calc')}
        </button>
        <button
          className="sports-action-btn sports-action-btn--open"
          onClick={(e) => {
            e.stopPropagation()
            if (pmLeg?.url) window.open(pmLeg.url, '_blank', 'noopener,noreferrer')
            if (dexLeg?.url) window.open(dexLeg.url, '_blank', 'noopener,noreferrer')
          }}
        >
          {t('scanner.open')}
        </button>
      </div>
    </div>
  )
}

// --- Scanner Page ---

export function Scanner() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()

  // Arb mode
  const [arbMode, setArbMode] = useState<ArbMode>('pm-pm')
  const queryClient = useQueryClient()

  const handleModeSwitch = useCallback((mode: ArbMode) => {
    setArbMode(mode)
    // Reset the target query cache so stale cards are cleared before fresh fetch
    if (mode === 'pm-pm') {
      queryClient.resetQueries({ queryKey: queryKeys.opportunities })
    } else {
      queryClient.resetQueries({ queryKey: queryKeys.sportsOpportunities })
    }
  }, [queryClient])

  // Filters
  const [searchQuery] = useState('')
  const [minRoi, setMinRoi] = useState(0.5)
  const [selectedPlatforms] = useState<Record<string, boolean>>({})
  const [typeFilter] = useState<TypeFilter>('all')
  const [liveFilter, setLiveFilter] = useState<LiveFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('profit')
  const [showPolymarketMin50c, setShowPolymarketMin50c] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [isPaused, setIsPaused] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)

  // PM-BM settings
  const [perfectAmount, setPerfectAmount] = useState(1000)
  const [realMinAmount, setRealMinAmount] = useState(10)
  const [pinnedOpps, setPinnedOpps] = useState<Map<string, SportsOpportunity>>(new Map())

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  // Subscription gate: check before loading arbitrage data
  const { data: subStatus, isLoading: isSubLoading } = useSubscriptionStatus()
  const hasSubscription = subStatus?.active === true
  const noApiKey = !localStorage.getItem('apiKey')

  // Data — only fetch when subscription is confirmed active
  const pmpmQuery = useOpportunities()
  const pmbmQuery = useSportsOpportunities(isPaused)
  const { data: platforms } = usePlatforms()

  // Select data source based on arb mode
  const { isLoading, isError, error } = arbMode === 'pm-pm' ? pmpmQuery : pmbmQuery

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
  }, [])

  const handleNewOpportunity = useCallback((data: NewOpportunityEvent) => {
    if (soundEnabled && data.profitPercentage >= minRoi) {
      playOpportunitySound()
    }
    setToast({
      message: t('scanner.newOpportunity', {
        profit: data.profitPercentage.toFixed(2),
        title: data.matchTitle,
      }),
      type: 'success',
    })
  }, [t, playOpportunitySound, minRoi, soundEnabled])

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


  // Filter & sort opportunities
  const filteredOpportunities = useMemo(() => {
    // Read directly from the correct query to avoid cross-mode contamination
    const sourceItems = arbMode === 'pm-pm' ? pmpmQuery.data?.items : pmbmQuery.data?.items
    if (!sourceItems) return []

    let result = sourceItems.filter((opp: Opportunity) => {
      // Search filter
      if (searchQuery && !opp.matchTitle.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false
      }

      // Min ROI filter
      // pm-bm: use profitPercentage directly (= profitPercent from the scanner)
      // pm-pm: prefer weightedAvgProfit (order-book depth) if available, fallback to profitPercentage
      const effectiveRoi = arbMode === 'pm-bm'
        ? Number(opp.profitPercentage) || 0
        : Number(opp.weightedAvgProfit ?? opp.profitPercentage) || 0
      if (effectiveRoi < minRoi) {
        return false
      }

      // Type filter (pm-pm only)
      if (arbMode === 'pm-pm' && typeFilter !== 'all' && opp.type !== typeFilter) {
        return false
      }

      // Live/pre filter (pm-bm only)
      if (arbMode === 'pm-bm') {
        if (liveFilter === 'live' && !opp.isLive) return false
        if (liveFilter === 'pre' && opp.isLive) return false
      }

      // Platform filter — only for pm-pm mode
      if (arbMode === 'pm-pm') {
        const allLegsSelected = opp.legs.every(
          (leg) => effectivePlatforms[leg.platformSlug] === true
        )
        if (!allLegsSelected) {
          return false
        }
      }

      // Polymarket pre-filter — hide low-priced legs (< $0.50) when enabled (pm-bm pre-match only)
      if (arbMode === 'pm-bm' && showPolymarketMin50c && !opp.isLive) {
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

      // REAL MIN filter — hide cards where PM liquidity is below threshold
      if (arbMode === 'pm-bm' && realMinAmount > 0) {
        const sOpp = opp as SportsOpportunity
        if (sOpp.sportsLegs?.length > 0) {
          const pmLeg = sOpp.sportsLegs.find(l => l.platform === 'polymarket')
          const realTotal = (pmLeg?.pmBestAskQty ?? 0) * opp.totalCost
          if (realTotal < realMinAmount) return false
        }
      }

      return true
    })

    // Sort
    result = [...result].sort((a, b) => {
      if (sortMode === 'profit') {
        const pa = arbMode === 'pm-bm'
          ? Number(a.profitPercentage) || 0
          : Number(a.weightedAvgProfit ?? a.profitPercentage) || 0
        const pb = arbMode === 'pm-bm'
          ? Number(b.profitPercentage) || 0
          : Number(b.weightedAvgProfit ?? b.profitPercentage) || 0
        return pb - pa
      }
      if (sortMode === 'profitUsd') {
        const getRealProfit = (o: Opportunity): number => {
          if (arbMode === 'pm-bm') {
            const sOpp = o as SportsOpportunity
            const pmLeg = sOpp.sportsLegs?.find(l => l.platform === 'polymarket')
            return (pmLeg?.pmBestAskQty ?? 0) * (1 - o.totalCost)
          }
          return Number(o.totalGrossProfit) || 0
        }
        return getRealProfit(b) - getRealProfit(a)
      }
      // newest
      return new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime()
    })

    return result
  }, [pmpmQuery.data, pmbmQuery.data, searchQuery, minRoi, typeFilter, liveFilter, effectivePlatforms, sortMode, showPolymarketMin50c, arbMode, realMinAmount])

  // PM-BM display list: pinned cards first, then non-pinned filtered cards
  const displayPmBmOpps = useMemo(() => {
    if (arbMode !== 'pm-bm') return []
    const filteredSports = filteredOpportunities.map(o => o as SportsOpportunity)
    const filteredIds = new Set(filteredSports.map(o => o.id))

    const pinnedList: Array<{ opp: SportsOpportunity; isStale: boolean }> =
      Array.from(pinnedOpps.entries()).map(([id, saved]) => {
        const latest = filteredSports.find(o => o.id === id)
        return { opp: latest ?? saved, isStale: !filteredIds.has(id) }
      })

    const nonPinned = filteredSports
      .filter(o => !pinnedOpps.has(o.id))
      .map(o => ({ opp: o, isStale: false }))

    return [...pinnedList, ...nonPinned]
  }, [arbMode, filteredOpportunities, pinnedOpps])


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
      <div className="scanner-layout">
        {/* Sidebar */}
        <aside className="scanner-sidebar">
          {/* Arb mode switcher */}
          <div className="sidebar-section">
            <label className="sidebar-section-label">{t('scanner.arbMode')}</label>
            <div className="sidebar-mode-buttons">
              <button
                className={`sidebar-mode-button ${arbMode === 'pm-pm' ? 'active' : ''}`}
                onClick={() => handleModeSwitch('pm-pm')}
              >
                PM — PM
              </button>
              <button
                className={`sidebar-mode-button ${arbMode === 'pm-bm' ? 'active' : ''}`}
                onClick={() => handleModeSwitch('pm-bm')}
              >
                PM — BK
              </button>
            </div>
          </div>

          {/* Settings — always visible */}
          <div className="sidebar-section">
            <label className="sidebar-section-label">{t('scanner.settings')}</label>
            <div className="settings-panel">
              <div className="settings-toolbar">
                <button
                  type="button"
                  className={`settings-icon-button ${soundEnabled ? 'active' : ''}`}
                  onClick={() => {
                    if (!soundEnabled) playOpportunitySound()
                    setSoundEnabled((prev) => !prev)
                  }}
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

              {arbMode === 'pm-pm' && (
                <div className="filter-group">
                  <label className="filter-label">{t('scanner.sortBy')}</label>
                  <div className="roi-buttons">
                    {(['profit', 'profitUsd'] as SortMode[]).map((value) => (
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
              )}
              {arbMode === 'pm-bm' && (
                <>
                  <div className="filter-group">
                    <label className="filter-label">{t('scanner.type')}</label>
                    <div className="roi-buttons">
                      {(['all', 'live', 'pre'] as LiveFilter[]).map((value) => (
                        <button
                          key={value}
                          className={`roi-button ${liveFilter === value ? 'active' : ''}`}
                          onClick={() => setLiveFilter(value)}
                        >
                          {t(`scanner.type${value.charAt(0).toUpperCase() + value.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="filter-group">
                    <label className="filter-label">{t('scanner.sortBy')}</label>
                    <div className="roi-buttons">
                      {(['profit', 'profitUsd'] as SortMode[]).map((value) => (
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
                </>
              )}

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
              </div>
            </div>
          </div>

          {/* PM-BM specific settings */}
          {arbMode === 'pm-bm' && (
            <>
              <div className="sidebar-section">
                <label className="sidebar-section-label">{t('scanner.pmBmConfig')}</label>
                <div className="settings-sliders">
                  <div className="settings-slider-row">
                    <div className="settings-slider-head">
                      <span className="settings-slider-label">ABSOLUTE ($)</span>
                      <span className="settings-slider-value">${perfectAmount}</span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={perfectAmount}
                      onChange={(e) => setPerfectAmount(Math.max(0, Number(e.target.value)))}
                      className="settings-number-input"
                    />
                  </div>
                  <div className="settings-slider-row">
                    <div className="settings-slider-head">
                      <span className="settings-slider-label">REAL MIN ($)</span>
                      <span className="settings-slider-value">${realMinAmount}</span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={realMinAmount}
                      onChange={(e) => setRealMinAmount(Math.max(0, Number(e.target.value)))}
                      className="settings-number-input"
                    />
                  </div>
                </div>
              </div>
              <div className="sidebar-section">
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
            </>
          )}
        </aside>

        {/* Main content */}
        <div className="scanner-main">


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
            ) : (arbMode === 'pm-bm' ? displayPmBmOpps.length : filteredOpportunities.length) === 0 ? (
              <div className="empty-state">
                <p>{t('scanner.noOpportunities')}</p>
                <p className="empty-hint">{t('scanner.emptyHint')}</p>
              </div>
            ) : arbMode === 'pm-bm' ? (
              displayPmBmOpps.map(({ opp, isStale }, index) => (
                <CardErrorBoundary key={`pm-bm-${opp.id}`}>
                  <SportsOpportunityCard
                    opp={opp}
                    index={index}
                    perfectAmount={perfectAmount}
                    isPinned={pinnedOpps.has(opp.id)}
                    isStale={isStale}
                    onPin={(o) => setPinnedOpps(prev => new Map(prev).set(o.id, o))}
                    onUnpin={(id) => setPinnedOpps(prev => { const n = new Map(prev); n.delete(id); return n })}
                  />
                </CardErrorBoundary>
              ))
            ) : (
              filteredOpportunities.map((opp, index) => (
                <CardErrorBoundary key={`pm-pm-${opp.id}`}>
                  <OpportunityCard opp={opp} index={index} locale={locale} arbMode={arbMode} />
                </CardErrorBoundary>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="scanner-footer">
            <p>{t('scanner.opportunitiesFound', { count: filteredOpportunities.length })}</p>
            <p className="scanner-disclaimer">{t('scanner.disclaimerText')}</p>
          </div>
        </div>
      </div>
      </>}
    </div>
  )
}
