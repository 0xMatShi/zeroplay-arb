import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
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
}: CalcParams) {
  const [pmPrice, setPmPrice] = useState(initPmPrice)
  const [dexOddsVal, setDexOddsVal] = useState(initDexOdds)
  const [pmAmount, setPmAmount] = useState(initPmAmount)
  const [dexAmount, setDexAmount] = useState(initDexAmount)
  const [lastEdited, setLastEdited] = useState<'pm' | 'dex' | null>(null)
  const [qtyCopied, setQtyCopied] = useState(false)

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

  const handlePmAmount = (v: string) => { setPmAmount(v); setLastEdited('pm'); setDexAmount(calcDexFromPm(v)) }
  const handleDexAmount = (v: string) => { setDexAmount(v); setLastEdited('dex'); setPmAmount(calcPmFromDex(v)) }

  const handlePmPrice = (v: string) => {
    setPmPrice(v)
    const p = parseFloat(v) / 100
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, p, dexO))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, p, dexO))
  }

  const handleDexOdds = (v: string) => {
    setDexOddsVal(v)
    const o = parseFloat(v)
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, pmProb, o))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, pmProb, o))
  }

  const pmAmt = parseFloat(pmAmount) || 0
  const dexAmt = parseFloat(dexAmount) || 0
  const totalCost = pmAmt + dexAmt
  const totalImplied = pmProb > 0 && dexO > 0 ? pmProb + 1 / dexO : 0
  const profitPct = totalImplied > 0 ? ((1 - totalImplied) / totalImplied) * 100 : 0
  const pmQty = pmAmt > 0 && pmProb > 0 ? Math.round(pmAmt / pmProb) : 0
  const pmWinProfit = pmAmt > 0 && pmProb > 0 && totalCost > 0 ? pmAmt / pmProb - totalCost : 0
  const dexWinProfit = dexAmt > 0 && dexO > 0 && totalCost > 0 ? dexAmt * dexO - totalCost : 0

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
        {/* PM box */}
        <div className="calc-box calc-box--pm">
          <div className="calc-box-label calc-box-label--pm">POLYMARKET</div>
          <div className="calc-outcome">{pmOutcome || '—'}</div>
          <div className="calc-field">
            <div className="calc-input-wrap">
              <span className="calc-input-prefix">$</span>
              <input className="calc-input calc-input--prefixed" type="number" min="0" placeholder="0.00"
                value={pmAmount} onChange={(e) => handlePmAmount(e.target.value)} />
            </div>
          </div>
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
        </div>

        {/* DEX box */}
        <div className={`calc-box calc-box--${dexPlatform === 'pinnacle' ? 'pinnacle' : dexPlatform === 'stake' ? 'stake' : dexPlatform === 'cloudbet' ? 'cloudbet' : 'dex'}`}>
          <div className={`calc-box-label calc-box-label--${dexPlatform === 'pinnacle' ? 'pinnacle' : dexPlatform === 'stake' ? 'stake' : dexPlatform === 'cloudbet' ? 'cloudbet' : 'dex'}`}>
            {dexPlatform === 'pinnacle' ? 'PINNACLE' : dexPlatform === 'stake' ? 'STAKE' : dexPlatform === 'cloudbet' ? 'CLOUDBET' : 'DEXSPORT'}
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
    </div>
  )
}
