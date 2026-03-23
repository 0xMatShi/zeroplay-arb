import { useState } from 'react'
import { Copy, Check, PenLine } from 'lucide-react'
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
}

function platformLabel(platform: string | undefined): string {
  if (platform === 'pinnacle') return 'Pinnacle'
  if (platform === 'stake') return 'Stake'
  if (platform === 'cloudbet') return 'Cloudbet'
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
}: CalcParams) {
  const isBmBm = !!initLeftOdds

  // ── PM-BM state ──────────────────────────────────────────────
  const [pmPrice, setPmPrice] = useState(initPmPrice)
  const [qtyCopied, setQtyCopied] = useState(false)

  // ── Shared state ─────────────────────────────────────────────
  const [dexOddsVal, setDexOddsVal] = useState(initDexOdds)
  const [pmAmount, setPmAmount] = useState(initPmAmount)
  const [dexAmount, setDexAmount] = useState(initDexAmount)
  const [lastEdited, setLastEdited] = useState<'pm' | 'dex' | null>(null)

  // ── BM-BM state ──────────────────────────────────────────────
  const [leftOddsVal, setLeftOddsVal] = useState(initLeftOdds ?? '')

  // ── PM-BM math ───────────────────────────────────────────────
  const pmProb = parseFloat(pmPrice) / 100
  const dexO = parseFloat(dexOddsVal)

  const calcDexFromPm = (pm: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(pm)
    if (!isNaN(s) && s > 0 && prob > 0 && oddsVal > 0) return String(Math.round(s / (prob * oddsVal)))
    return ''
  }

  const calcPmFromDex = (dex: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(dex)
    if (!isNaN(s) && s > 0 && prob > 0 && oddsVal > 0) return (s * oddsVal * prob).toFixed(2)
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
    setDexAmount(isBmBm ? calcRightFromLeft(v) : calcDexFromPm(v))
  }

  const handleDexAmount = (v: string) => {
    setDexAmount(v)
    setLastEdited('dex')
    setPmAmount(isBmBm ? calcLeftFromRight(v) : calcPmFromDex(v))
  }

  const handlePmPrice = (v: string) => {
    setPmPrice(v)
    const p = parseFloat(v) / 100
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, p, dexO))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, p, dexO))
  }

  const handleDexOdds = (v: string) => {
    setDexOddsVal(v)
    const o = parseFloat(v)
    if (isBmBm) {
      if (lastEdited === 'dex' && dexAmount) setPmAmount(calcLeftFromRight(dexAmount, leftO, o))
      else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcRightFromLeft(pmAmount, leftO, o))
    } else {
      if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, pmProb, o))
      else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, pmProb, o))
    }
  }

  const handleLeftOdds = (v: string) => {
    setLeftOddsVal(v)
    const lo = parseFloat(v)
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcLeftFromRight(dexAmount, lo, rightO))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcRightFromLeft(pmAmount, lo, rightO))
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
    totalImplied = pmProb > 0 && dexO > 0 ? pmProb + 1 / dexO : 0
    profitPct = totalImplied > 0 ? ((1 - totalImplied) / totalImplied) * 100 : 0
    pmWinProfit = pmAmt > 0 && pmProb > 0 && totalCost > 0 ? pmAmt / pmProb - totalCost : 0
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
              <span className="calc-input-prefix">$</span>
              <input className="calc-input calc-input--prefixed" type="number" min="0" placeholder="0.00"
                value={dexAmount} onChange={(e) => handleDexAmount(e.target.value)} />
            </div>
          </div>
          <div className="calc-field">
            <div className="calc-input-wrap">
              <span className="calc-input-prefix">×</span>
              <input className="calc-input calc-input--prefixed" type="number" min="1" step="0.01"
                value={dexOddsVal} onChange={(e) => handleDexOdds(e.target.value)} />
            </div>
          </div>
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
