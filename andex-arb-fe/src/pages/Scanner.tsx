import { useState, useMemo, useCallback, useRef, useEffect, Component, createElement } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import { CalculatorContent, type CalcParams } from '../components/CalculatorContent'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Calculator, ExternalLink, Pause, Pencil, Pin, Play, User, Volume2, VolumeX } from 'lucide-react'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { useOpportunities, useOrderBook, useSubscriptionStatus, useActiveSubscription, useSportsOpportunities, useWhoami, useDashboardProfile, useUpdateDashboardNickname, queryKeys } from '../api/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { useArbitrageSocket } from '../hooks/useArbitrageSocket'
import { useSportsArbSocket } from '../hooks/useSportsArbSocket'
import { ApiError } from '../api/client'
import { clearAuthCookies } from '../utils/authCookies'
import { SmokeCanvas } from '../components/SmokeCanvas'
import { formatRelativeTime } from '../utils/time'
import type { Opportunity, SportsOpportunity, SportsOpportunityLeg, NewOpportunityEvent, OrderBookAnalysisResponse } from '../api/types'

async function openCalcWindow(params: CalcParams) {
  const q = new URLSearchParams(params as unknown as Record<string, string>)

  if ('documentPictureInPicture' in window) {
    try {
      const pipWin: Window = await (window as { documentPictureInPicture: { requestWindow: (o: object) => Promise<Window> } }).documentPictureInPicture.requestWindow({ width: 480, height: 380 })

      // Copy all styles from the main document
      document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
        pipWin.document.head.appendChild(node.cloneNode(true))
      })
      pipWin.document.body.style.cssText = 'margin:0;padding:0;background:#191A21;'

      const container = pipWin.document.createElement('div')
      pipWin.document.body.appendChild(container)

      const root = createRoot(container)
      root.render(createElement(CalculatorContent, params))

      pipWin.addEventListener('pagehide', () => root.unmount())
      return
    } catch (err) {
      console.warn('[PiP] documentPictureInPicture failed, falling back to window.open:', err)
    }
  }

  window.open(
    `/calculator?${q}`,
    '_blank',
    'width=480,height=380,left=0,top=0,resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no',
  )
}

function useNow(intervalMs = 1000) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

type SortMode = 'profit' | 'profitUsd' | 'newest'
type TypeFilter = 'all' | 'binary' | 'multi'
type LiveFilter = 'all' | 'live' | 'pre'
type ArbMode = 'pm-pm' | 'pm-bm'
const POLYMARKET_MIN_PRICE = 0.5

function useLocalStorage<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue
    } catch {
      return defaultValue
    }
  })
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
  }, [key, value])
  return [value, setValue]
}

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
  useNow()
  const isPmPm = arbMode === 'pm-pm'
  const { data: obData } = useOrderBook(opp.id, isPmPm)
  const ob = obData as OrderBookAnalysisResponse | undefined

  return (
    <div
      className="opportunity-card"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      {/* Card Header */}
      <div className="opp-header">
        <div className="opp-header-left">
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
            const grossProfit = opp.totalGrossProfit
            return (
              <span className={`opp-profit ${displayProfit < 0.5 ? 'opp-profit--dim' : ''}`}>
                {t('scanner.profit', { value: displayProfit.toFixed(2) })}
                {grossProfit != null && ` | +$${grossProfit.toFixed(2)}`}
              </span>
            )
          })()}
        </div>
      </div>

      {/* Legs */}
      <div className="opp-legs">
        {opp.legs.map((leg, legIndex) => {
          const obLeg = ob?.legs?.[legIndex]
          const legInvestment = ob?.tiers?.tiers?.reduce(
            (sum, tier) => sum + tier.quantity * (tier.legPrices[legIndex]?.price ?? 0), 0
          ) ?? 0
          return (
          <div key={legIndex} className="arb-leg">
            <div className="leg-platform">{leg.platformName}</div>
            <div className="leg-outcome">
              <span className="leg-outcome-label">{t('scanner.buy')}</span>
              <span className="leg-outcome-name">{leg.outcomeName}</span>
            </div>
            <div className="leg-price">
              {(() => { const p = obLeg ? obLeg.effectivePrice : leg.price; return p < 1 ? `${Math.round(p * 100)}¢` : `$${p.toFixed(2)}`; })()}
              {legInvestment > 0 && <span className="leg-investment"> | ${legInvestment.toFixed(2)}</span>}
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

function effectiveIsLive(opp: SportsOpportunity): boolean {
  return opp.isLive || (opp.startTime != null && Date.now() > opp.startTime)
}

// --- Sports Opportunity Card (PM-BM) ---

function SportsOpportunityCard({
  opp,
  index,
  perfectAmount,
  isPinned,
  isStale,
  pmDisplayMode,
  onPin,
  onUnpin,
}: {
  opp: SportsOpportunity
  index: number
  perfectAmount: number
  isPinned: boolean
  isStale: boolean
  pmDisplayMode: 'shares' | 'odds'
  onPin: (opp: SportsOpportunity) => void
  onUnpin: (id: string) => void
}) {
  useTranslation()
  useNow()
  const [expanded, setExpanded] = useState(false)

  const pmLeg: SportsOpportunityLeg | undefined = opp.sportsLegs?.find(l => l.platform === 'polymarket')
  const isBmBm = !pmLeg

  // For bm-bm: left=dexsport, right=other bm. For pm-bm: left=polymarket, right=bookmaker.
  const leftLeg: SportsOpportunityLeg | undefined = isBmBm
    ? opp.sportsLegs?.find(l => l.platform === 'dexsport')
    : pmLeg
  const rightLeg: SportsOpportunityLeg | undefined = isBmBm
    ? opp.sportsLegs?.find(l => l.platform !== 'dexsport')
    : opp.sportsLegs?.find(l => l.platform !== 'polymarket')
  const dexLeg = rightLeg

  const totalCost = opp.totalCost
  const profitPct = opp.profitPercentage
  const isNegative = profitPct <= 0

  // Perfect amounts (proportional to leg probability)
  const pmPerfect = leftLeg ? perfectAmount * (leftLeg.probability / totalCost) : 0
  const dexPerfect = rightLeg ? perfectAmount * (rightLeg.probability / totalCost) : 0

  // Real amounts (limited by PM best ask qty; bm-bm has no order book)
  const pmQty = isBmBm ? 0 : (pmLeg?.pmBestAskQty ?? 0)
  const pmReal = pmLeg ? pmQty * pmLeg.probability : 0
  const dexReal = rightLeg ? pmQty * rightLeg.probability : 0
  const realTotal = pmQty * totalCost
  const effectiveTotal = realTotal > 0 ? Math.min(realTotal, perfectAmount) : 0
  const profitUsd = isBmBm
    ? perfectAmount * (profitPct / 100)
    : effectiveTotal > 0 ? effectiveTotal * (profitPct / 100) : 0

  // Effective amounts for calculator (same min logic as profitUsd)
  const useRealForCalc = realTotal > 0 && realTotal <= perfectAmount
  const pmCalcAmount = useRealForCalc ? pmReal : pmPerfect
  const dexCalcAmount = useRealForCalc ? dexReal : dexPerfect

  const SPORT_DISPLAY: Record<string, string> = { csgo: 'CS2' }
  const sportKey = opp.sportKey ?? ''
  const sportLabel = SPORT_DISPLAY[sportKey] ?? sportKey.toUpperCase()
  const secsAgo = Math.floor((Date.now() - new Date(opp.lastValidatedAt).getTime()) / 1000)
  const displayMarketType = opp.dexMarketName || formatMarketType(opp.marketType)

  const openTab = (url: string) => {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.click()
  }

  const handleOpenAll = () => {
    void openCalcWindow({
      pmOutcome: leftLeg?.outcomeName ?? '',
      dexOutcome: rightLeg?.outcomeName ?? '',
      pmPrice: leftLeg ? (leftLeg.probability * 100).toFixed(0) : '50',
      dexOdds: rightLeg ? rightLeg.decimalOdds.toFixed(2) : '2.00',
      pmAmount: pmCalcAmount.toFixed(2),
      dexAmount: dexCalcAmount.toFixed(2),
      dexPlatform: rightLeg?.platform,
      marketType: displayMarketType,
      eventName: opp.matchTitle,
      sport: sportLabel,
      ...(isBmBm && leftLeg ? { leftOdds: leftLeg.decimalOdds.toFixed(2), leftPlatform: leftLeg.platform } : {}),
    })
    if (leftLeg?.url) openTab(leftLeg.url)
    if (rightLeg?.url) openTab(rightLeg.url)
  }

  let cardClass = 'opportunity-card sports-card'
  if (isPinned && !isStale) cardClass += ' sports-card--pinned'
  else if (isPinned && isStale) cardClass += ' sports-card--pinned-stale'
  else if (isStale) cardClass += ' sports-card--stale'

  return (
    <div
      className={cardClass}
      style={{ animationDelay: `${index * 0.05}s`, cursor: 'pointer' }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onClick={handleOpenAll}
    >
      {/* Main row */}
      <div className="sports-card-main">

        {/* Left: event info */}
        <div className="sports-card-info">
          <div className="sports-event-title">
            {opp.matchTitle}{opp.tournamentName ? ` — ${opp.tournamentName}` : ''}
          </div>
          {opp.startTime != null && (
            <div className="sports-start-time">
              {new Date(opp.startTime).toLocaleString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
                timeZone: 'UTC', hour12: false,
              })} (UTC)
            </div>
          )}
          <div className="sports-badges">
            {sportLabel && <span className="sports-sport-badge">{sportLabel}</span>}
            {effectiveIsLive(opp) ? (
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
          {/* Left platform box (Polymarket for pm-bm, DexSport for bm-bm) */}
          <div className="sports-platform-box">
            <div className={`sports-platform-label ${isBmBm ? 'sports-platform-label--dex' : 'sports-platform-label--pm'}`}>
              {isBmBm ? 'DEXSPORT' : 'POLYMARKET'}
            </div>
            <div className="sports-outcome-name">{leftLeg?.outcomeName ?? '—'}</div>
            <div className="sports-amounts-inline">
              <span className="sports-amount-key">B:</span>
              <span className="sports-amount-val">${pmPerfect.toFixed(0)}</span>
              {!isBmBm && (
                <>
                  <span className="sports-amounts-sep">|</span>
                  <span className="sports-amount-key">L:</span>
                  <span className="sports-amount-val">${pmReal.toFixed(0)}</span>
                </>
              )}
            </div>
            <div className="sports-price-row">
              {leftLeg ? (
                <>
                  {!isBmBm && (
                    <span className={`sports-cents ${pmDisplayMode === 'odds' ? 'sports-cents--muted' : ''}`}>
                      {(leftLeg.probability * 100).toFixed(0)}¢
                    </span>
                  )}
                  <span className={`sports-odds ${!isBmBm && pmDisplayMode === 'shares' ? 'sports-odds--muted' : ''}`}>
                    {leftLeg.decimalOdds.toFixed(2)}x
                  </span>
                </>
              ) : <span className="sports-cents">—</span>}
            </div>
          </div>

          {/* Right platform box (bookmaker) */}
          <div className="sports-platform-box">
            <div className={`sports-platform-label sports-platform-label--${dexLeg?.platform === 'pinnacle' ? 'pinnacle' : dexLeg?.platform === 'stake' ? 'stake' : dexLeg?.platform === 'cloudbet' ? 'cloudbet' : 'dex'}`}>
              {dexLeg?.platform === 'pinnacle' ? 'PINNACLE' : dexLeg?.platform === 'stake' ? 'STAKE' : dexLeg?.platform === 'cloudbet' ? 'CLOUDBET' : 'DEXSPORT'}
            </div>
            <div className="sports-outcome-name">{dexLeg?.outcomeName ?? '—'}</div>
            <div className="sports-amounts-inline">
              <span className="sports-amount-key">B:</span>
              <span className="sports-amount-val">${dexPerfect.toFixed(0)}</span>
              {!isBmBm && (
                <>
                  <span className="sports-amounts-sep">|</span>
                  <span className="sports-amount-key">L:</span>
                  <span className="sports-amount-val">${dexReal.toFixed(0)}</span>
                </>
              )}
            </div>
            <div className="sports-price-row">
              {dexLeg ? (
                <>
                  {!isBmBm && <span className="sports-cents sports-cents--muted">{(dexLeg.probability * 100).toFixed(0)}¢</span>}
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
          <Pin size={28} />
        </button>
        <button
          className="sports-action-btn sports-action-btn--calc"
          onClick={(e) => {
            e.stopPropagation()
            void openCalcWindow({
              pmOutcome: leftLeg?.outcomeName ?? '',
              dexOutcome: rightLeg?.outcomeName ?? '',
              pmPrice: leftLeg ? (leftLeg.probability * 100).toFixed(0) : '50',
              dexOdds: rightLeg ? rightLeg.decimalOdds.toFixed(2) : '2.00',
              pmAmount: pmCalcAmount.toFixed(2),
              dexAmount: dexCalcAmount.toFixed(2),
              dexPlatform: rightLeg?.platform,
              marketType: displayMarketType,
              eventName: opp.matchTitle,
              sport: sportLabel,
              ...(isBmBm && leftLeg ? { leftOdds: leftLeg.decimalOdds.toFixed(2), leftPlatform: leftLeg.platform } : {}),
            })
          }}
        >
          <Calculator size={28} />
        </button>
        <button
          className="sports-action-btn sports-action-btn--open"
          onClick={(e) => {
            e.stopPropagation()
            handleOpenAll()
          }}
        >
          <ExternalLink size={28} />
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
  const [arbMode, setArbMode] = useLocalStorage<ArbMode>('scanner:arbMode', 'pm-bm')
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
  const [minRoi, setMinRoi] = useLocalStorage('scanner:minRoi', 0)
  const [selectedPlatforms, setSelectedPlatforms] = useState<Record<string, boolean>>({})
  const [typeFilter] = useState<TypeFilter>('all')
  const [liveFilter, setLiveFilter] = useLocalStorage<LiveFilter>('scanner:liveFilter', 'all')
  const [sportFilter, setSportFilter] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('scanner:sportFilter')
      return stored ? new Set<string>(JSON.parse(stored) as string[]) : new Set()
    } catch { return new Set() }
  })
  const [platformsOpen, setPlatformsOpen] = useState(false)
  const [sportsOpen, setSportsOpen] = useState(false)
  const [pairsOpen, setPairsOpen] = useState(false)
  const [platformPairFilter, setPlatformPairFilter] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('scanner:platformPairFilter')
      return stored ? new Set<string>(JSON.parse(stored) as string[]) : new Set()
    } catch { return new Set() }
  })
  const [sortMode, setSortMode] = useLocalStorage<SortMode>('scanner:sortMode', 'profit')
  const [showPolymarketMin50c, setShowPolymarketMin50c] = useLocalStorage('scanner:showPolymarketMin50c', true)
  const [soundEnabledPmPm, setSoundEnabledPmPm] = useLocalStorage('scanner:soundEnabledPmPm', true)
  const [soundEnabledPmBm, setSoundEnabledPmBm] = useLocalStorage('scanner:soundEnabledPmBm', true)
  const soundEnabled = arbMode === 'pm-bm' ? soundEnabledPmBm : soundEnabledPmPm
  const setSoundEnabled = arbMode === 'pm-bm' ? setSoundEnabledPmBm : setSoundEnabledPmPm
  const [volume, setVolume] = useLocalStorage('scanner:volume', 0.3)
  const [volumeHover, setVolumeHover] = useState(false)
  const [volumeVisible, setVolumeVisible] = useState(false)
  const volumeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const [editingNick, setEditingNick] = useState(false)
  const [nickInput, setNickInput] = useState('')
  const { data: profileData } = useDashboardProfile()
  const updateNickname = useUpdateDashboardNickname()
  const scannerNickname = profileData?.profile?.nickname

  // PM-BM settings
  const [pmDisplayMode, setPmDisplayMode] = useLocalStorage<'shares' | 'odds'>('scanner:pmDisplayMode', 'shares')
  const [perfectAmountInput, setPerfectAmountInput] = useLocalStorage('scanner:perfectAmountInput', '100')
  const [realMinAmountInput, setRealMinAmountInput] = useLocalStorage('scanner:realMinAmountInput', '0')
  const [maxDaysInput, setMaxDaysInput] = useLocalStorage('scanner:maxDaysInput', '')
  useEffect(() => {
    try { localStorage.setItem('scanner:sportFilter', JSON.stringify([...sportFilter])) } catch { /* ignore */ }
  }, [sportFilter])
  useEffect(() => {
    try { localStorage.setItem('scanner:platformPairFilter', JSON.stringify([...platformPairFilter])) } catch { /* ignore */ }
  }, [platformPairFilter])

  const perfectAmount = perfectAmountInput === '' ? 0 : Math.max(0, Number(perfectAmountInput) || 0)
  const realMinAmount = realMinAmountInput === '' ? 0 : Math.max(0, Number(realMinAmountInput) || 0)
  const maxDaysUntilStart = maxDaysInput === '' ? null : Math.max(0, Number(maxDaysInput) || 0)
  const [pinnedOpps, setPinnedOpps] = useState<Map<string, SportsOpportunity>>(new Map())


  // Subscription gate: check before loading arbitrage data
  useWhoami()
  const { data: subStatus, isLoading: isSubLoading } = useSubscriptionStatus()
  const hasSubscription = subStatus?.active === true
  const noApiKey = !localStorage.getItem('apiKey')
  const { data: activeSub } = useActiveSubscription()

  // Live countdown for profile panel (updates every second)
  const calcSubInfo = useCallback(() => {
    if (!activeSub) return null
    if (!activeSub.expiresAt) return { label: null, pct: 100 }
    const now = Date.now()
    const expires = new Date(activeSub.expiresAt).getTime()
    const starts = new Date(activeSub.startsAt).getTime()
    const totalMs = expires - starts
    const remainingMs = Math.max(0, expires - now)
    const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0

    const totalMins = Math.floor(remainingMs / 60_000)
    const days = Math.floor(totalMins / 1440)
    const hours = Math.floor((totalMins % 1440) / 60)
    const mins = totalMins % 60

    const parts: string[] = []
    if (days > 0) parts.push(`${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`)
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'час' : hours < 5 ? 'часа' : 'часов'}`)
    if (mins > 0 || parts.length === 0) parts.push(`${mins} ${mins === 1 ? 'минута' : mins < 5 ? 'минуты' : 'минут'}`)

    return { label: parts.join(', '), pct }
  }, [activeSub])

  const [subDaysInfo, setSubDaysInfo] = useState(() => calcSubInfo())
  useEffect(() => {
    setSubDaysInfo(calcSubInfo())
    if (!activeSub?.expiresAt) return
    const id = setInterval(() => setSubDaysInfo(calcSubInfo()), 60_000)
    return () => clearInterval(id)
  }, [activeSub, calcSubInfo])

  // Data — only fetch when subscription is confirmed active
  const pmpmQuery = useOpportunities()
  const pmbmQuery = useSportsOpportunities()


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

      // Две ноты до → до (октава выше), каждая с обертонами как у пианино
      const keys: Array<{ baseFreq: number; offset: number }> = [
        { baseFreq: 523.25,  offset: 0 },
        { baseFreq: 1046.50, offset: 0.08 },
      ]

      // Обертоны: [множитель частоты, относительная громкость, длительность затухания]
      const harmonics: Array<[number, number, number]> = [
        [1, 1.0,  0.8],  // фундаментал
        [2, 0.5,  0.5],  // 2-я гармоника
        [3, 0.25, 0.3],  // 3-я гармоника
        [4, 0.1,  0.2],  // 4-я гармоника
      ]

      const filter = audioCtx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(300, now)
      filter.Q.setValueAtTime(0.5, now)
      filter.connect(audioCtx.destination)

      keys.forEach(({ baseFreq, offset }) => {
        harmonics.forEach(([mult, gainScale, decay]) => {
          const oscillator = audioCtx.createOscillator()
          const gainNode = audioCtx.createGain()

          oscillator.type = 'sine'
          oscillator.frequency.setValueAtTime(baseFreq * mult, now + offset)

          gainNode.gain.setValueAtTime(0.0001, now + offset)
          gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * gainScale), now + offset + 0.08)
          gainNode.gain.exponentialRampToValueAtTime(0.0001, now + offset + decay)

          oscillator.connect(gainNode)
          gainNode.connect(filter)

          oscillator.start(now + offset)
          oscillator.stop(now + offset + decay)
        })
      })
    } catch {
      // Ignore if audio playback is blocked by browser policy.
    }
  }, [volume])

  const playBmSound = useCallback(() => {
    try {
      const audio = new Audio('/sounds/dragon-studio-new-notification-3-398649 (1).mp3')
      audio.volume = volume
      void audio.play()
    } catch {
      // Ignore if audio playback is blocked by browser policy.
    }
  }, [volume])

  const handleNewOpportunity = useCallback((data: NewOpportunityEvent) => {
    if (soundEnabledPmPm && data.profitPercentage >= minRoi) {
      playOpportunitySound()
    }
  }, [playOpportunitySound, minRoi, soundEnabledPmPm])

  const { isConnected, authError: wsAuthError } = useArbitrageSocket({
    onNewOpportunity: handleNewOpportunity,
    paused: isPaused,
  })

  // PM-BM real-time WebSocket
  const handleNewSportsOpportunity = useCallback((_opp: SportsOpportunity) => {
    // Sound is handled via useEffect watching filteredOpportunities
  }, [])

  const { authError: sportsWsAuthError } = useSportsArbSocket({
    onNewOpportunity: handleNewSportsOpportunity,
    paused: isPaused,
  })

  const effectiveBlockedReason = blockedReason ?? wsAuthError ?? sportsWsAuthError

  // Initialize platform toggles from API data
  const STATIC_PLATFORM_SLUGS = ['polymarket', 'kalshi', 'opinion', 'probable', 'predict.fun']

  // Effective selected platforms — default to all enabled
  const effectivePlatforms = useMemo(() => {
    if (Object.keys(selectedPlatforms).length === 0) {
      return Object.fromEntries(STATIC_PLATFORM_SLUGS.map(s => [s, true]))
    }
    return selectedPlatforms
  }, [selectedPlatforms])


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
      // pm-bm: never show non-profitable arbs in main list (negative/zero arbs are only for pinned cards)
      if (arbMode === 'pm-bm' && effectiveRoi <= 0) return false
      if (effectiveRoi < minRoi) {
        return false
      }

      // Type filter (pm-pm only)
      if (arbMode === 'pm-pm' && typeFilter !== 'all' && opp.type !== typeFilter) {
        return false
      }

      // Live/pre filter (pm-bm only)
      if (arbMode === 'pm-bm') {
        const live = effectiveIsLive(opp as SportsOpportunity)
        if (liveFilter === 'live' && !live) return false
        if (liveFilter === 'pre' && live) return false
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

      // Polymarket pre-filter — hide high-priced legs (>= $0.50) when enabled (pm-bm pre-match only)
      if (arbMode === 'pm-bm' && showPolymarketMin50c && !effectiveIsLive(opp as SportsOpportunity)) {
        const hasLowPolymarketLeg = opp.legs.some((leg) => {
          const slug = leg.platformSlug.toLowerCase()
          const name = leg.platformName.toLowerCase()
          const isPolymarket = slug === 'polymarket' || name.includes('polymarket')
          return isPolymarket && leg.price >= POLYMARKET_MIN_PRICE
        })

        if (hasLowPolymarketLeg) {
          return false
        }
      }

      // Platform pair filter
      if (arbMode === 'pm-bm' && platformPairFilter.size > 0) {
        const sOpp = opp as SportsOpportunity
        const hasPmLeg = sOpp.sportsLegs?.some(l => l.platform === 'polymarket')
        if (hasPmLeg) {
          // pm-bm: filter by bookmaker platform
          const bmLeg = sOpp.sportsLegs?.find(l => l.platform !== 'polymarket')
          if (!bmLeg || !platformPairFilter.has(bmLeg.platform)) return false
        } else {
          // bm-bm: filter by compound key dexsport-<bmPlatform>
          const bmLeg = sOpp.sportsLegs?.find(l => l.platform !== 'dexsport')
          const pairKey = bmLeg ? `dexsport-${bmLeg.platform}` : null
          if (!pairKey || !platformPairFilter.has(pairKey)) return false
        }
      }

      // Sport filter
      if (arbMode === 'pm-bm' && sportFilter.size > 0) {
        const sOpp = opp as SportsOpportunity
        if (!sportFilter.has(sOpp.sportKey)) return false
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

      // DAYS UNTIL START filter — hide pre-match events starting too far in the future
      if (arbMode === 'pm-bm' && maxDaysUntilStart !== null) {
        const sOpp = opp as SportsOpportunity
        if (sOpp.startTime != null) {
          const daysUntil = (sOpp.startTime - Date.now()) / (1000 * 60 * 60 * 24)
          if (daysUntil > maxDaysUntilStart) return false
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
            if (!pmLeg) {
              // bm-bm: profit is based on perfectAmount (bank)
              return perfectAmount * (Number(o.profitPercentage) || 0) / 100
            }
            const pmQty = pmLeg.pmBestAskQty ?? 0
            const realTotal = pmQty * o.totalCost
            const effectiveTotal = realTotal > 0 ? Math.min(realTotal, perfectAmount) : 0
            return effectiveTotal * (Number(o.profitPercentage) || 0) / 100
          }
          return Number(o.totalGrossProfit) || 0
        }
        return getRealProfit(b) - getRealProfit(a)
      }
      // newest
      return new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime()
    })

    return result
  }, [pmpmQuery.data, pmbmQuery.data, searchQuery, minRoi, typeFilter, liveFilter, effectivePlatforms, sortMode, showPolymarketMin50c, arbMode, realMinAmount, sportFilter, maxDaysUntilStart, platformPairFilter])

  // PM-BM display list: pinned cards first, then non-pinned filtered cards
  const displayPmBmOpps = useMemo(() => {
    if (arbMode !== 'pm-bm') return []
    const filteredSports = filteredOpportunities.map(o => o as SportsOpportunity)
    const filteredIds = new Set(filteredSports.map(o => o.id))
    // Full unfiltered list — used for pinned cards so they always get fresh prices
    // even when the opp is filtered out by minRoi or other frontend filters
    const allSports = (pmbmQuery.data?.items ?? []) as SportsOpportunity[]

    const pinnedList: Array<{ opp: SportsOpportunity; isStale: boolean }> =
      Array.from(pinnedOpps.entries()).map(([id, saved]) => {
        const latest = allSports.find(o => o.id === id)
        return { opp: latest ?? saved, isStale: !filteredIds.has(id) }
      })

    const nonPinned = filteredSports
      .filter(o => !pinnedOpps.has(o.id))
      .map(o => ({ opp: o, isStale: false }))

    return [...pinnedList, ...nonPinned]
  }, [arbMode, filteredOpportunities, pinnedOpps, pmbmQuery.data])


  // Play sound when a pm-bm card has been visible for at least 1 second
  const visiblePmBmIdsRef = useRef<Set<string>>(new Set())
  const pendingBmSoundTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Clear all timers on unmount
  useEffect(() => {
    return () => {
      pendingBmSoundTimers.current.forEach(timer => clearTimeout(timer))
      pendingBmSoundTimers.current.clear()
    }
  }, [])

  useEffect(() => {
    if (arbMode !== 'pm-bm' || !soundEnabledPmBm || isPaused) {
      pendingBmSoundTimers.current.forEach(timer => clearTimeout(timer))
      pendingBmSoundTimers.current.clear()
      // Don't reset visiblePmBmIdsRef so cards already seen aren't treated as new on unpause
      return
    }

    const currentIds = new Set(filteredOpportunities.map(o => o.id))

    // Cancel pending timers for cards that disappeared
    for (const [id, timer] of pendingBmSoundTimers.current) {
      if (!currentIds.has(id)) {
        clearTimeout(timer)
        pendingBmSoundTimers.current.delete(id)
      }
    }

    // Schedule 1-second delayed sound for newly appeared cards
    const newIds = [...currentIds].filter(id => !visiblePmBmIdsRef.current.has(id))
    for (const id of newIds) {
      if (!pendingBmSoundTimers.current.has(id)) {
        const timer = setTimeout(() => {
          pendingBmSoundTimers.current.delete(id)
          if (visiblePmBmIdsRef.current.has(id)) playBmSound()
        }, 1000)
        pendingBmSoundTimers.current.set(id, timer)
      }
    }

    visiblePmBmIdsRef.current = currentIds
  }, [filteredOpportunities, arbMode, soundEnabledPmBm, isPaused, playBmSound])

  const locale = i18n.language === 'ru' ? 'ru' : 'en'

  return (
    <div className="scanner-page">
      {/* Header */}
      <div className="scanner-header">
        <div className="scanner-header-left">
          <h1 className="scanner-title scanner-title--link" data-text={t('scanner.title')} onClick={() => navigate('/')}>{t('scanner.title')}</h1>
          <div className="scanner-status">
            <span className="status-label">{t('scanner.systemLabel')}</span>
            <span className="status-value">
              {isPaused ? t('scanner.paused') : isConnected ? t('scanner.scanning') : t('scanner.wsReconnecting')}
            </span>
            <span className={`status-pulse ${isPaused ? 'status-pulse--paused' : isConnected ? '' : 'status-pulse--offline'}`}></span>
          </div>
        </div>
        <div className="scanner-header-right">
          <div className="settings-toolbar">
            <div
              className="volume-control"
              onMouseEnter={() => {
                if (volumeHideTimer.current) clearTimeout(volumeHideTimer.current)
                setVolumeVisible(true)
                setVolumeHover(true)
              }}
              onMouseLeave={() => {
                setVolumeHover(false)
                volumeHideTimer.current = setTimeout(() => setVolumeVisible(false), 350)
              }}
            >
              <button
                type="button"
                className={`settings-icon-button ${soundEnabled ? 'active' : ''}`}
                onClick={() => {
                  if (!soundEnabled) arbMode === 'pm-bm' ? playBmSound() : playOpportunitySound()
                  setSoundEnabled((prev) => !prev)
                }}
                aria-label={soundEnabled ? t('scanner.soundOn') : t('scanner.soundOff')}
              >
                <span className="settings-icon-content" aria-hidden="true">
                  {soundEnabled
                    ? <Volume2 size={16} color="#1BBDE8" style={{ stroke: '#1BBDE8' }} />
                    : <VolumeX size={16} color="#fff" style={{ stroke: '#fff' }} />
                  }
                </span>
              </button>
              {volumeVisible && (
                <div className="volume-slider-popup">
                  <div className={`volume-slider-popup-inner ${volumeHover ? '' : 'volume-slider-popup-inner--hiding'}`}>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      className="volume-slider"
                      style={{
                        background: `linear-gradient(to right, #3ED6FF 0%, #F472B6 ${volume * 100}%, rgba(255,255,255,0.15) ${volume * 100}%)`,
                      }}
                    />
                    <span className="volume-label">{Math.round(volume * 100)}%</span>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`settings-icon-button settings-icon-button--pause ${isPaused ? 'active' : ''}`}
              onClick={() => setIsPaused((prev) => !prev)}
              aria-label={isPaused ? t('scanner.resumeScanner') : t('scanner.pauseScanner')}
              title={isPaused ? t('scanner.resumeScanner') : t('scanner.pauseScanner')}
            >
              <span className="settings-icon-content" aria-hidden="true">
                {isPaused
                  ? <Play size={16} color="#D9569E" style={{ stroke: '#D9569E' }} />
                  : <Pause size={16} color="#fff" style={{ stroke: '#fff' }} />
                }
              </span>
            </button>
          </div>
          <LanguageSwitcher />
          <button
            type="button"
            className="gradient-profile-btn"
            onClick={() => setIsProfileOpen(true)}
          >
            {t('andexDashboard.tabProfile') || 'Profile'}
          </button>
        </div>
      </div>

      {/* Access Wall */}
      {effectiveBlockedReason && (
        <div className="access-wall">
          <div className="access-wall-content">
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
                className={`sidebar-mode-button ${arbMode === 'pm-bm' ? 'active' : ''}`}
                onClick={() => handleModeSwitch('pm-bm')}
              >
                PM — BK
              </button>
              <button
                className={`sidebar-mode-button ${arbMode === 'pm-pm' ? 'active' : ''}`}
                onClick={() => handleModeSwitch('pm-pm')}
              >
                PM — PM
              </button>
            </div>
          </div>

          {/* Settings — always visible */}
          <div className="sidebar-section">
            <div className="settings-panel">

              {arbMode === 'pm-bm' && (
                <div className="settings-sliders">
                  <div className="settings-slider-row">
                    <div className="settings-slider-head">
                      <span className="settings-slider-label">BANK ($)</span>
                      <span className="settings-slider-value">${perfectAmount}</span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={perfectAmountInput}
                      onChange={(e) => setPerfectAmountInput(e.target.value)}
                      className="settings-number-input"
                    />
                  </div>
                  <div className="settings-slider-row">
                    <div className="settings-slider-head">
                      <span className="settings-slider-label">LIQUIDITY ($)</span>
                      <span className="settings-slider-value">${realMinAmount}</span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={realMinAmountInput}
                      onChange={(e) => setRealMinAmountInput(e.target.value)}
                      className="settings-number-input"
                    />
                  </div>
                </div>
              )}

              {arbMode === 'pm-bm' && (
                <div className="settings-sliders">
                  <div className="settings-slider-row">
                    <div className="settings-slider-head">
                      <span className="settings-slider-label">MAX DAYS</span>
                      <span className="settings-slider-value">
                        {maxDaysUntilStart === null ? '∞' : `${maxDaysUntilStart}d`}
                      </span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="∞"
                      value={maxDaysInput}
                      onChange={(e) => setMaxDaysInput(e.target.value)}
                      className="settings-number-input"
                    />
                  </div>
                </div>
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
                    style={{ '--fill': `${(minRoi / 20) * 100}%` } as React.CSSProperties}
                  />
                </div>
              </div>

              {arbMode === 'pm-pm' && (
                <>
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
                  <div className="filter-group">
                    <button className="collapsible-label" onClick={() => setPlatformsOpen(p => !p)}>
                      <span>{t('scanner.platforms')}</span>
                      <span className={`collapsible-arrow ${platformsOpen ? 'open' : ''}`}>▾</span>
                    </button>
                    <div className={`collapsible-body ${platformsOpen ? 'collapsible-body--open' : ''}`}>
                      <div className="platform-buttons">
                        {([
                          { slug: 'polymarket', label: 'Polymarket' },
                          { slug: 'kalshi', label: 'Kalshi' },
                          { slug: 'opinion', label: 'Opinion' },
                          { slug: 'probable', label: 'Probable' },
                          { slug: 'predict.fun', label: 'Predict.Fun' },
                        ] as { slug: string; label: string }[]).map(({ slug, label }) => {
                          const isActive = effectivePlatforms[slug] !== false
                          return (
                            <button
                              key={slug}
                              className={`sidebar-mode-button ${isActive ? 'active' : ''}`}
                              onClick={() => setSelectedPlatforms((prev) => {
                                const base = Object.keys(prev).length === 0
                                  ? { polymarket: true, kalshi: true, opinion: true, probable: true, 'predict.fun': true }
                                  : { ...prev }
                                return { ...base, [slug]: !isActive }
                              })}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}
              {arbMode === 'pm-bm' && (
                <>
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
                  <div
                    className="pm-display-toggle"
                    onClick={() => setPmDisplayMode(prev => prev === 'shares' ? 'odds' : 'shares')}
                  >
                    <div className={`pm-display-toggle__indicator ${pmDisplayMode === 'odds' ? 'pm-display-toggle__indicator--right' : ''}`} />
                    <span className={`pm-display-toggle__label ${pmDisplayMode === 'shares' ? 'pm-display-toggle__label--active' : ''}`}>SHARES</span>
                    <span className={`pm-display-toggle__label ${pmDisplayMode === 'odds' ? 'pm-display-toggle__label--active' : ''}`}>ODDS</span>
                  </div>
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
                  <div className="filter-group">
                    <button className="collapsible-label" onClick={() => setPairsOpen(p => !p)}>
                      <span>Pairs</span>
                      <span className={`collapsible-arrow ${pairsOpen ? 'open' : ''}`}>▾</span>
                    </button>
                    <div className={`collapsible-body ${pairsOpen ? 'collapsible-body--open' : ''}`}>
                      <div className="platform-buttons">
                        {([
                          { key: 'dexsport',          label: 'Polymarket → Dexsport'  },
                          { key: 'pinnacle',          label: 'Polymarket → Pinnacle'  },
                          { key: 'stake',             label: 'Polymarket → Stake'     },
                          { key: 'cloudbet',          label: 'Polymarket → Cloudbet'  },
                          { key: 'dexsport-pinnacle', label: 'Dexsport → Pinnacle'    },
                          { key: 'dexsport-stake',    label: 'Dexsport → Stake'       },
                          { key: 'dexsport-cloudbet', label: 'Dexsport → Cloudbet'    },
                        ]).map(({ key, label }) => {
                          const isActive = platformPairFilter.size === 0 || platformPairFilter.has(key)
                          return (
                            <button
                              key={key}
                              className={`sidebar-mode-button ${isActive ? 'active' : ''}`}
                              onClick={() => setPlatformPairFilter((prev) => {
                                const all = ['dexsport', 'pinnacle', 'stake', 'cloudbet', 'dexsport-pinnacle', 'dexsport-stake', 'dexsport-cloudbet']
                                const next = new Set(prev.size === 0 ? all : prev)
                                if (next.has(key)) next.delete(key); else next.add(key)
                                if (next.size === all.length) return new Set()
                                return next
                              })}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="filter-group">
                    <button className="collapsible-label" onClick={() => setSportsOpen(p => !p)}>
                      <span>{t('scanner.sports')}</span>
                      <span className={`collapsible-arrow ${sportsOpen ? 'open' : ''}`}>▾</span>
                    </button>
                    <div className={`collapsible-body ${sportsOpen ? 'collapsible-body--open' : ''}`}>
                      <div className="platform-buttons">
                        {([
                          { key: 'basketball', label: 'Basketball' },
                          { key: 'baseball',   label: 'Baseball' },
                          { key: 'tennis',     label: 'Tennis' },
                          { key: 'hockey',     label: 'Hockey' },
                          { key: 'boxing',     label: 'Boxing' },
                          { key: 'csgo',       label: 'CS2' },
                          { key: 'valorant',   label: 'Valorant' },
                          { key: 'dota2',      label: 'Dota 2' },
                          { key: 'lol',        label: 'League of Legends' },
                          { key: 'cod',        label: 'Call of Duty' },
                        ]).map(({ key, label }) => {
                          const isActive = sportFilter.size === 0 || sportFilter.has(key)
                          return (
                            <button
                              key={key}
                              className={`sidebar-mode-button ${isActive ? 'active' : ''}`}
                              onClick={() => setSportFilter((prev) => {
                                const next = new Set(prev.size === 0
                                  ? ['basketball','tennis','hockey','csgo','boxing','dota2','cod','baseball','lol','valorant']
                                  : prev)
                                if (next.has(key)) next.delete(key); else next.add(key)
                                if (next.size === 10) return new Set()
                                return next
                              })}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}

            </div>
          </div>

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
              <div className={`empty-state${arbMode === 'pm-bm' ? ' empty-state--sports' : ''}`}>
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
                    pmDisplayMode={pmDisplayMode}
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

      {/* Profile panel overlay */}
      <div
        className={`profile-overlay ${isProfileOpen ? 'profile-overlay--open' : ''}`}
        onClick={() => setIsProfileOpen(false)}
      />

      {/* Profile sliding panel */}
      <div className={`profile-panel ${isProfileOpen ? 'profile-panel--open' : ''}`}>
        <SmokeCanvas />
        <div className="profile-panel-inner">
          <div className="profile-panel-header">
            <div className="profile-panel-avatar">
              <User size={32} />
            </div>
            {scannerNickname && (
              <div className="profile-panel-nick-wrap">
                {editingNick ? (
                  <input
                    className="profile-nick-input"
                    value={nickInput}
                    autoFocus
                    onChange={e => setNickInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        updateNickname.mutate(nickInput, { onSuccess: () => setEditingNick(false) })
                      }
                      if (e.key === 'Escape') setEditingNick(false)
                    }}
                  />
                ) : (
                  <span className="profile-panel-nickname">{scannerNickname}</span>
                )}
                <button
                  className="db-icon-btn db-edit-nick-btn"
                  onClick={() => { setNickInput(scannerNickname); setEditingNick(true) }}
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </div>

          {/* Subscription info */}
          <div className="profile-panel-section">
            <div className="profile-panel-label">{t('scanner.currentPlan') || 'Подписка'}</div>
            {subDaysInfo ? (
              <>
                <div className="profile-sub-days">
                  {subDaysInfo.label === null
                    ? (t('scanner.lifetimeSub') || 'Навсегда')
                    : subDaysInfo.label}
                </div>
                <div className="profile-hp-bar">
                  <div
                    className="profile-hp-fill"
                    style={{ width: `${subDaysInfo.pct}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="profile-sub-days profile-sub-days--none">
                {t('scanner.noActiveSub') || 'Нет подписки'}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="profile-panel-actions">
            <button
              className="profile-action-btn"
              onClick={() => { setIsProfileOpen(false); navigate('/dashboard') }}
            >
              PNL Tracker
            </button>
            <a
              href={`https://docs.subline.space?key=${localStorage.getItem('apiKey') ?? ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.learnGuide')}
            </a>
            <a
              href={import.meta.env.VITE_TELEGRAM_BOT_URL as string}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.renewSub')}
            </a>
            <a
              href={import.meta.env.VITE_TELEGRAM_SUPPORT_URL as string}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.askQuestion')}
            </a>
            <button
              className="profile-action-btn profile-action-btn--logout"
              onClick={() => {
                localStorage.removeItem('apiKey')
                localStorage.removeItem('sessionToken')
                clearAuthCookies()
                queryClient.clear()
                navigate('/')
              }}
            >
              {t('scanner.logout')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
