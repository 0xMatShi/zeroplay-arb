import { useState, useEffect } from 'react'
import { Copy, Check, PenLine } from 'lucide-react'
import { sportsArbApi } from '../api/client'
import '../pages/Calculator.css'

export interface CalcParams {
  pmOutcome: string
  dexOutcome: string
  pmPrice: string
  dexOdds: string
  pmAmount: string
  dexAmount: string
  dexPlatform?: string
  marketType?: string
  /** When provided, calculator switches to bm-bm mode (both sides are bookmakers) */
  leftOdds?: string
  leftPlatform?: string
  /** Event/match title for dashboard */
  eventName?: string
  /** Sport key for dashboard */
  sport?: string
  /** Controls whether Polymarket side shows cents or decimal odds */
  pmDisplayMode?: 'shares' | 'odds'
}

function platformLabel(platform: string | undefined): string {
  if (platform === 'pinnacle') return 'Pinnacle'
  if (platform === 'stake') return 'Stake'
  if (platform === 'cloudbet') return 'Cloudbet'
  if (platform === 'pari') return 'Pari'
  if (platform === 'fonbet') return 'Fonbet'
  if (platform === 'dexsport') return 'DexSport'
  if (platform === 'betboom') return 'Betboom'
  if (platform === 'kalshi') return 'Kalshi'
  if (platform === 'polymarket') return 'Polymarket'
  return 'DexSport'
}

function platformClass(platform: string | undefined): string {
  if (platform === 'pinnacle') return 'pinnacle'
  if (platform === 'stake') return 'stake'
  if (platform === 'cloudbet') return 'cloudbet'
  if (platform === 'pari') return 'pari'
  if (platform === 'fonbet') return 'fonbet'
  return 'dex'
}

export function CalculatorContent({
  pmOutcome,
  dexOutcome,
  pmPrice: initPmPrice,
  dexOdds: initDexOdds,
  pmAmount: initPmAmount,
  dexAmount: initDexAmount,
  dexPlatform,
  marketType,
  leftOdds: initLeftOdds,
  leftPlatform,
  eventName,
  sport,
  pmDisplayMode = 'shares',
}: CalcParams) {
  const isBmBm = !!initLeftOdds
  const isRussianBM = dexPlatform === 'pari' || dexPlatform === 'fonbet'

  // ── Bybit P2P rate (for Pari and Fonbet — RUB-based bookmakers) ──────────
  const [bybitRate, setBybitRate] = useState<number | null>(null)
  useEffect(() => {
    if (!isRussianBM) return
    sportsArbApi.getBybitRate().then(r => setBybitRate(r.rate)).catch(() => {})
  }, [isRussianBM])

  // ── PM-BM state ──────────────────────────────────────────────
  const [pmPrice, setPmPrice] = useState(initPmPrice)
  const [qtyCopied, setQtyCopied] = useState(false)

  // ── Shared state ─────────────────────────────────────────────
  const [dexOddsVal, setDexOddsVal] = useState(initDexOdds)
  const [pmAmount, setPmAmount] = useState(initPmAmount)
  const [dexAmount, setDexAmount] = useState(initDexAmount)
  const [lastEdited, setLastEdited] = useState<'pm' | 'dex' | null>(null)

  // ── Ruble input (Pari only) ───────────────────────────────────
  // rubInput is what the user sees/types; dexAmount stays in USD for all calculations
  const [rubInput, setRubInput] = useState('')
  useEffect(() => {
    if (!isRussianBM || !bybitRate) return
    const usd = parseFloat(dexAmount)
    if (!isNaN(usd) && usd > 0) setRubInput(Math.round(usd * bybitRate).toString())
  }, [bybitRate]) // only init once when rate loads

  const toRub = (usdStr: string) => {
    if (!bybitRate) return
    const usd = parseFloat(usdStr)
    setRubInput(isNaN(usd) || usd <= 0 ? '' : Math.round(usd * bybitRate).toString())
  }

  // ── BM-BM state ──────────────────────────────────────────────
  const [leftOddsVal, setLeftOddsVal] = useState(initLeftOdds ?? '')

  // ── PM-BM math ───────────────────────────────────────────────
  const pmProb = parseFloat(pmPrice) / 100
  const dexO = parseFloat(dexOddsVal)

  // Effective PM cost per $1 of guaranteed payout, accounting for 3% fee on winnings.
  // Matches backend formula: p * (1 + 0.03 * (1 - p))
  const pmEffectiveCost = (p: number) => p * (1 + 0.03 * (1 - p))

  const calcDexFromPm = (pm: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(pm)
    const eff = pmEffectiveCost(prob)
    if (!isNaN(s) && s > 0 && eff > 0 && oddsVal > 0) return String(Math.round(s / (eff * oddsVal)))
    return ''
  }

  const calcPmFromDex = (dex: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(dex)
    const eff = pmEffectiveCost(prob)
    if (!isNaN(s) && s > 0 && eff > 0 && oddsVal > 0) return (s * oddsVal * eff).toFixed(2)
    return ''
  }

  // ── BM-BM math ───────────────────────────────────────────────
  const leftO = parseFloat(leftOddsVal)
  const rightO = parseFloat(dexOddsVal)

  const calcRightFromLeft = (left: string, lo = leftO, ro = rightO) => {
    const s = parseFloat(left)
    if (!isNaN(s) && s > 0 && lo > 0 && ro > 0) return (s * lo / ro).toFixed(2)
    return ''
  }

  const calcLeftFromRight = (right: string, lo = leftO, ro = rightO) => {
    const s = parseFloat(right)
    if (!isNaN(s) && s > 0 && lo > 0 && ro > 0) return (s * ro / lo).toFixed(2)
    return ''
  }

  // ── Handlers ─────────────────────────────────────────────────
  const handlePmAmount = (v: string) => {
    setPmAmount(v)
    setLastEdited('pm')
    const newDex = isBmBm ? calcRightFromLeft(v) : calcDexFromPm(v)
    setDexAmount(newDex)
    toRub(newDex)
  }

  const handleDexAmount = (v: string) => {
    setDexAmount(v)
    setLastEdited('dex')
    setPmAmount(isBmBm ? calcLeftFromRight(v) : calcPmFromDex(v))
  }

  // Ruble input handler (Pari only): converts rub → usd → triggers normal dex logic
  const handleRubInput = (v: string) => {
    setRubInput(v)
    if (!bybitRate) return
    const usd = parseFloat(v) / bybitRate
    const usdStr = isNaN(usd) || usd <= 0 ? '' : usd.toFixed(2)
    setDexAmount(usdStr)
    setLastEdited('dex')
    setPmAmount(isBmBm ? calcLeftFromRight(usdStr) : calcPmFromDex(usdStr))
  }

  const handlePmPrice = (v: string) => {
    setPmPrice(v)
    const p = parseFloat(v) / 100
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, p, dexO))
    else if (lastEdited === 'pm' && pmAmount) {
      const newDex = calcDexFromPm(pmAmount, p, dexO)
      setDexAmount(newDex)
      toRub(newDex)
    }
  }

  // When in odds mode: convert decimal odds → cents price and delegate to handlePmPrice
  const handlePmOdds = (v: string) => {
    const o = parseFloat(v)
    if (!isNaN(o) && o > 1) {
      handlePmPrice((100 / o).toFixed(2))
    }
  }

  // Displayed value for PM odds input (derived from pmPrice)
  const pmOddsDisplay = (() => {
    const p = parseFloat(pmPrice)
    if (!isNaN(p) && p > 0) return (100 / p).toFixed(2)
    return ''
  })()

  const handleDexOdds = (v: string) => {
    setDexOddsVal(v)
    const o = parseFloat(v)
    if (isBmBm) {
      if (lastEdited === 'dex' && dexAmount) setPmAmount(calcLeftFromRight(dexAmount, leftO, o))
      else if (lastEdited === 'pm' && pmAmount) {
        const newDex = calcRightFromLeft(pmAmount, leftO, o)
        setDexAmount(newDex)
        toRub(newDex)
      }
    } else {
      if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, pmProb, o))
      else if (lastEdited === 'pm' && pmAmount) {
        const newDex = calcDexFromPm(pmAmount, pmProb, o)
        setDexAmount(newDex)
        toRub(newDex)
      }
    }
  }

  const handleLeftOdds = (v: string) => {
    setLeftOddsVal(v)
    const lo = parseFloat(v)
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcLeftFromRight(dexAmount, lo, rightO))
    else if (lastEdited === 'pm' && pmAmount) {
      const newDex = calcRightFromLeft(pmAmount, lo, rightO)
      setDexAmount(newDex)
      toRub(newDex)
    }
  }

  // ── Profit calc ──────────────────────────────────────────────
  const pmAmt = parseFloat(pmAmount) || 0
  const dexAmt = parseFloat(dexAmount) || 0
  const totalCost = pmAmt + dexAmt

  let totalImplied: number
  let profitPct: number
  let pmWinProfit: number
  let dexWinProfit: number

  if (isBmBm) {
    totalImplied = leftO > 0 && rightO > 0 ? 1 / leftO + 1 / rightO : 0
    profitPct = totalImplied > 0 ? ((1 - totalImplied) / totalImplied) * 100 : 0
    pmWinProfit = pmAmt > 0 && leftO > 0 && totalCost > 0 ? pmAmt * leftO - totalCost : 0
    dexWinProfit = dexAmt > 0 && rightO > 0 && totalCost > 0 ? dexAmt * rightO - totalCost : 0
  } else {
    const eff = pmEffectiveCost(pmProb)
    totalImplied = pmProb > 0 && dexO > 0 ? eff + 1 / dexO : 0
    profitPct = totalImplied > 0 ? ((1 - totalImplied) / totalImplied) * 100 : 0
    pmWinProfit = pmAmt > 0 && eff > 0 && totalCost > 0 ? pmAmt / eff - totalCost : 0
    dexWinProfit = dexAmt > 0 && dexO > 0 && totalCost > 0 ? dexAmt * dexO - totalCost : 0
  }

  const pmQty = !isBmBm && pmAmt > 0 && pmProb > 0 ? Math.round(pmAmt / pmProb) : 0

  const handleSendToDashboard = () => {
    // Human-readable platform names
    const bm1Name = isBmBm ? platformLabel(leftPlatform) : 'Polymarket'
    const bm2Name = platformLabel(dexPlatform)

    // For Polymarket side: store price in cents (e.g. "37"), not decimal odds
    // For bookmaker side: store decimal odds
    const odds1 = isBmBm
      ? leftOddsVal
      : pmPrice // cents string, e.g. "37"
    const odds2 = dexOddsVal

    const pending = {
      bookmaker1: bm1Name,
      bookmaker2: bm2Name,
      eventName: eventName || '',
      sport: sport || '',
      outcome1: pmOutcome || undefined,
      outcome2: dexOutcome || undefined,
      odds1,
      odds2,
      stake1: pmAmount,
      stake2: dexAmount,
      profit: totalCost > 0 ? String(Math.min(pmWinProfit, dexWinProfit).toFixed(2)) : '',
      profitPercent: totalCost > 0 ? String(profitPct.toFixed(4)) : '',
    }
    localStorage.setItem('pendingDashboardTrade', JSON.stringify(pending))
    window.open('/dashboard', '_blank')
  }

  const handleCopyQty = () => {
    const text = String(pmQty)
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    } else {
      fallbackCopy(text)
    }
    setQtyCopied(true)
    setTimeout(() => setQtyCopied(false), 1500)
  }

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }

  return (
    <div className="calc-page">
      <div className="calc-boxes">
        {/* Left box */}
        <div className={`calc-box calc-box--${isBmBm ? platformClass(leftPlatform) : 'pm'}`}>
          <div className={`calc-box-label calc-box-label--${isBmBm ? platformClass(leftPlatform) : 'pm'}`}>
            {isBmBm ? platformLabel(leftPlatform) : 'POLYMARKET'}
          </div>
          <div className="calc-outcome">{pmOutcome || '—'}</div>
          <div className="calc-field">
            <div className="calc-input-wrap">
              <span className="calc-input-prefix">$</span>
              <input className="calc-input calc-input--prefixed" type="number" min="0" placeholder="0.00"
                value={pmAmount} onChange={(e) => handlePmAmount(e.target.value)} />
            </div>
          </div>
          {isBmBm ? (
            <div className="calc-field">
              <div className="calc-input-wrap">
                <span className="calc-input-prefix">×</span>
                <input className="calc-input calc-input--prefixed" type="number" min="1" step="0.01"
                  value={leftOddsVal} onChange={(e) => handleLeftOdds(e.target.value)} />
              </div>
            </div>
          ) : pmDisplayMode === 'odds' ? (
            <div className="calc-field">
              <div className="calc-input-wrap">
                <span className="calc-input-prefix">×</span>
                <input className="calc-input calc-input--prefixed" type="number" min="1.01" step="0.01"
                  value={pmOddsDisplay} onChange={(e) => handlePmOdds(e.target.value)} />
              </div>
            </div>
          ) : (
            <>
              <div className="calc-field">
                <div className="calc-input-wrap">
                  <span className="calc-input-prefix">¢</span>
                  <input className="calc-input calc-input--prefixed" type="number" min="1" max="99" step="1"
                    value={pmPrice} onChange={(e) => handlePmPrice(e.target.value)} />
                </div>
              </div>
              {pmQty > 0 && (
                <div className={`calc-qty${qtyCopied ? ' calc-qty--copied' : ''}`} title="Click to copy" onClick={handleCopyQty}>
                  <span className="calc-qty-state" style={{ opacity: qtyCopied ? 0 : 1 }}>
                    <Copy size={13} strokeWidth={2.5} style={{ color: '#00F0FF', flexShrink: 0 }} />
                    <span className="calc-qty-label">QTY</span>
                    <span className="calc-qty-val">{pmQty}</span>
                  </span>
                  <span className="calc-qty-state calc-qty-state--copied" style={{ opacity: qtyCopied ? 1 : 0 }}>
                    <Check size={14} strokeWidth={2.5} style={{ color: '#4ade80', flexShrink: 0 }} />
                    <span className="calc-qty-label calc-qty-label--copied">COPIED</span>
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right box */}
        <div className={`calc-box calc-box--${platformClass(dexPlatform)}`}>
          <div className={`calc-box-label calc-box-label--${platformClass(dexPlatform)}`}>
            {platformLabel(dexPlatform)}
          </div>
          <div className="calc-outcome">{dexOutcome || '—'}</div>
          <div className="calc-field">
            <div className="calc-input-wrap">
              {isRussianBM && bybitRate
                ? <span className="calc-input-prefix">₽</span>
                : <span className="calc-input-prefix">$</span>
              }
              {isRussianBM && bybitRate
                ? <input className="calc-input calc-input--prefixed" type="number" min="0" placeholder="0"
                    value={rubInput} onChange={(e) => handleRubInput(e.target.value)} />
                : <input className="calc-input calc-input--prefixed" type="number" min="0" placeholder="0.00"
                    value={dexAmount} onChange={(e) => handleDexAmount(e.target.value)} />
              }
            </div>
          </div>
          <div className="calc-field">
            <div className="calc-input-wrap">
              <span className="calc-input-prefix">×</span>
              <input className="calc-input calc-input--prefixed" type="number" min="1" step="0.01"
                value={dexOddsVal} onChange={(e) => handleDexOdds(e.target.value)} />
            </div>
          </div>
          {isRussianBM && bybitRate && dexAmount && parseFloat(dexAmount) > 0 && (
            <div className="calc-rub-amount">
              ≈ ${parseFloat(dexAmount).toFixed(2)}
              <span className="calc-rub-rate">{bybitRate} ₽/$</span>
            </div>
          )}
        </div>
      </div>

      {/* Market type */}
      {marketType && (
        <div className="calc-market-type">{marketType}</div>
      )}

      {/* Result row */}
      <div className="calc-result">
        <div className="calc-result-side">
          <span className={`calc-result-val ${pmWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`}>
            {pmWinProfit >= 0 ? '+' : ''}${pmWinProfit.toFixed(2)}
          </span>
          <span className={`calc-result-pct ${pmWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`}>
            ({profitPct >= 0 ? '+' : ''}{profitPct.toFixed(2)}%)
          </span>
        </div>
        <div className="calc-result-divider" />
        <div className="calc-result-side">
          <span className={`calc-result-val ${dexWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`}>
            {dexWinProfit >= 0 ? '+' : ''}${dexWinProfit.toFixed(2)}
          </span>
          <span className={`calc-result-pct ${dexWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`}>
            ({profitPct >= 0 ? '+' : ''}{profitPct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* Send to dashboard */}
      <button className="calc-dashboard-btn" onClick={handleSendToDashboard} title="Добавить в дашборд">
        <PenLine size={14} strokeWidth={2.5} />
      </button>
    </div>
  )
}
