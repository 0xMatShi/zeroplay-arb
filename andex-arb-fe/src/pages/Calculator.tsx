import { useState, useEffect, useRef } from 'react'
import { Copy, Check } from 'lucide-react'
import './Calculator.css'

export function Calculator() {
  const params = new URLSearchParams(window.location.search)
  const initPmOutcome = params.get('pmOutcome') ?? '—'
  const initDexOutcome = params.get('dexOutcome') ?? '—'
  const initPmPrice = params.get('pmPrice') ?? '50'
  const initDexOdds = params.get('dexOdds') ?? '2.00'
  const initPmAmount = params.get('pmAmount') ?? ''
  const initDexAmount = (() => {
    const v = params.get('dexAmount')
    if (!v) return ''
    const n = parseFloat(v)
    return isNaN(n) ? '' : String(Math.round(n))
  })()

  const [pmPrice, setPmPrice] = useState(initPmPrice)
  const [dexOddsVal, setDexOddsVal] = useState(initDexOdds)
  const [pmAmount, setPmAmount] = useState(initPmAmount)
  const [dexAmount, setDexAmount] = useState(initDexAmount)
  const [lastEdited, setLastEdited] = useState<'pm' | 'dex' | null>(null)

  const pmProb = parseFloat(pmPrice) / 100
  const dexO = parseFloat(dexOddsVal)

  // Equal-payout formula: S_pm / P_pm = S_dex * O_dex
  const calcDexFromPm = (pm: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(pm)
    if (!isNaN(s) && s > 0 && prob > 0 && oddsVal > 0) {
      return String(Math.round(s / (prob * oddsVal)))
    }
    return ''
  }

  const calcPmFromDex = (dex: string, prob = pmProb, oddsVal = dexO) => {
    const s = parseFloat(dex)
    if (!isNaN(s) && s > 0 && prob > 0 && oddsVal > 0) {
      return (s * oddsVal * prob).toFixed(2)
    }
    return ''
  }

  const handlePmAmount = (v: string) => {
    setPmAmount(v)
    setLastEdited('pm')
    setDexAmount(calcDexFromPm(v))
  }

  const handleDexAmount = (v: string) => {
    setDexAmount(v)
    setLastEdited('dex')
    setPmAmount(calcPmFromDex(v))
  }

  const handlePmPrice = (v: string) => {
    setPmPrice(v)
    const newProb = parseFloat(v) / 100
    if (lastEdited === 'dex' && dexAmount) {
      setPmAmount(calcPmFromDex(dexAmount, newProb, dexO))
    } else if (lastEdited === 'pm' && pmAmount) {
      setDexAmount(calcDexFromPm(pmAmount, newProb, dexO))
    }
  }

  const handleDexOdds = (v: string) => {
    setDexOddsVal(v)
    const newDexO = parseFloat(v)
    if (lastEdited === 'dex' && dexAmount) {
      setPmAmount(calcPmFromDex(dexAmount, pmProb, newDexO))
    } else if (lastEdited === 'pm' && pmAmount) {
      setDexAmount(calcDexFromPm(pmAmount, pmProb, newDexO))
    }
  }

  const pmAmt = parseFloat(pmAmount) || 0
  const dexAmt = parseFloat(dexAmount) || 0
  const totalCost = pmAmt + dexAmt
  // Same formula as the card: profitPct = (1 - totalImplied) / totalImplied * 100
  // where totalImplied = pmProb + 1/dexOdds
  const totalImplied = pmProb > 0 && dexO > 0 ? pmProb + 1 / dexO : 0
  const profitPct = totalImplied > 0 ? (1 - totalImplied) / totalImplied * 100 : 0

  // Per-platform profit: payout if that side wins minus total cost
  const pmQty = pmAmt > 0 && pmProb > 0 ? Math.round(pmAmt / pmProb) : 0
  const [qtyCopied, setQtyCopied] = useState(false)

  const handleCopyQty = () => {
    navigator.clipboard.writeText(String(pmQty))
    setQtyCopied(true)
    setTimeout(() => setQtyCopied(false), 1500)
  }

  const pmWinProfit = pmAmt > 0 && pmProb > 0 && totalCost > 0
    ? (pmAmt / pmProb) - totalCost : 0
  const dexWinProfit = dexAmt > 0 && dexO > 0 && totalCost > 0
    ? (dexAmt * dexO) - totalCost : 0

  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const { offsetWidth, offsetHeight } = el
    const extraH = window.outerHeight - window.innerHeight
    const extraW = window.outerWidth - window.innerWidth
    window.resizeTo(offsetWidth + extraW, offsetHeight + extraH)
  })

  return (
    <div className="calc-page" ref={pageRef}>
      <div className="calc-boxes">
        {/* PM box */}
        <div className="calc-box calc-box--pm">
          <div className="calc-box-label calc-box-label--pm">POLYMARKET</div>
          <div className="calc-outcome">{initPmOutcome}</div>
          <div className="calc-field">
            <label className="calc-field-label">Amount ($)</label>
            <input
              className="calc-input"
              type="number"
              min="0"
              placeholder="0.00"
              value={pmAmount}
              onChange={(e) => handlePmAmount(e.target.value)}
            />
          </div>
          <div className="calc-field">
            <label className="calc-field-label">Price (¢)</label>
            <input
              className="calc-input"
              type="number"
              min="1"
              max="99"
              step="1"
              value={pmPrice}
              onChange={(e) => handlePmPrice(e.target.value)}
            />
          </div>
          {pmQty > 0 && (
            <div
              className={`calc-qty${qtyCopied ? ' calc-qty--copied' : ''}`}
              title="Click to copy"
              onClick={handleCopyQty}
            >
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
        </div>

        {/* DEX box */}
        <div className="calc-box calc-box--dex">
          <div className="calc-box-label calc-box-label--dex">DEXSPORT</div>
          <div className="calc-outcome">{initDexOutcome}</div>
          <div className="calc-field">
            <label className="calc-field-label">Amount ($)</label>
            <input
              className="calc-input"
              type="number"
              min="0"
              placeholder="0.00"
              value={dexAmount}
              onChange={(e) => handleDexAmount(e.target.value)}
            />
          </div>
          <div className="calc-field">
            <label className="calc-field-label">Odds</label>
            <input
              className="calc-input"
              type="number"
              min="1"
              step="0.01"
              value={dexOddsVal}
              onChange={(e) => handleDexOdds(e.target.value)}
            />
          </div>
        </div>
      </div>

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
    </div>
  )
}
