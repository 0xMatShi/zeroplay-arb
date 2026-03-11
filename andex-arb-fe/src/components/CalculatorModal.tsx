import { useState, useRef, useEffect } from 'react'
import { X, Copy, Check } from 'lucide-react'
import '../pages/Calculator.css'

export interface CalcParams {
  pmOutcome: string
  dexOutcome: string
  pmPrice: string
  dexOdds: string
  pmAmount: string
  dexAmount: string
  dexPlatform?: string
}

interface Props {
  params: CalcParams
  onClose: () => void
}

export function CalculatorModal({ params, onClose }: Props) {
  const [pmPrice, setPmPrice] = useState(params.pmPrice)
  const [dexOddsVal, setDexOddsVal] = useState(params.dexOdds)
  const [pmAmount, setPmAmount] = useState(params.pmAmount)
  const [dexAmount, setDexAmount] = useState(params.dexAmount)
  const [lastEdited, setLastEdited] = useState<'pm' | 'dex' | null>(null)
  const [qtyCopied, setQtyCopied] = useState(false)

  const [pos, setPos] = useState({ x: 20, y: 20 })
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })

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
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, newProb, dexO))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, newProb, dexO))
  }

  const handleDexOdds = (v: string) => {
    setDexOddsVal(v)
    const newDexO = parseFloat(v)
    if (lastEdited === 'dex' && dexAmount) setPmAmount(calcPmFromDex(dexAmount, pmProb, newDexO))
    else if (lastEdited === 'pm' && pmAmount) setDexAmount(calcDexFromPm(pmAmount, pmProb, newDexO))
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
    navigator.clipboard.writeText(String(pmQty))
    setQtyCopied(true)
    setTimeout(() => setQtyCopied(false), 1500)
  }

  const handleDragStart = (e: React.MouseEvent) => {
    dragging.current = true
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    }
    const onUp = () => {
      dragging.current = false
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        background: '#191A21',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '16px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
        overflow: 'hidden',
        width: 480,
      }}
    >
      {/* Drag handle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.04)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          cursor: 'grab',
          userSelect: 'none',
        }}
        onMouseDown={handleDragStart}
      >
        <span
          style={{
            fontFamily: 'Inter, monospace',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1,
            color: '#666',
            textTransform: 'uppercase',
          }}
        >
          Calculator
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#666',
            cursor: 'pointer',
            padding: '2px 4px',
            display: 'flex',
            alignItems: 'center',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = '#fff')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = '#666')}
        >
          <X size={15} />
        </button>
      </div>

      {/* Calculator content */}
      <div className="calc-page" style={{ display: 'flex', width: '100%', boxSizing: 'border-box', padding: 10, gap: 8 }}>
        <div className="calc-boxes" style={{ gap: 8 }}>
          {/* PM box */}
          <div className="calc-box calc-box--pm" style={{ padding: '8px 12px', gap: 6, borderRadius: 20 }}>
            <div className="calc-box-label calc-box-label--pm">POLYMARKET</div>
            <div className="calc-outcome" style={{ fontSize: 13 }}>{params.pmOutcome || '—'}</div>
            <div className="calc-field">
              <label className="calc-field-label">Amount ($)</label>
              <input
                className="calc-input"
                style={{ fontSize: 16, padding: '6px 12px' }}
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
                style={{ fontSize: 16, padding: '6px 12px' }}
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
          <div className={`calc-box calc-box--${params.dexPlatform === 'pinnacle' ? 'pinnacle' : 'dex'}`} style={{ padding: '8px 12px', gap: 6, borderRadius: 20 }}>
            <div className={`calc-box-label calc-box-label--${params.dexPlatform === 'pinnacle' ? 'pinnacle' : 'dex'}`}>
              {params.dexPlatform === 'pinnacle' ? 'PINNACLE' : 'DEXSPORT'}
            </div>
            <div className="calc-outcome" style={{ fontSize: 13 }}>{params.dexOutcome || '—'}</div>
            <div className="calc-field">
              <label className="calc-field-label">Amount ($)</label>
              <input
                className="calc-input"
                style={{ fontSize: 16, padding: '6px 12px' }}
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
                style={{ fontSize: 16, padding: '6px 12px' }}
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
        <div className="calc-result" style={{ paddingTop: 0 }}>
          <div className="calc-result-side">
            <span className={`calc-result-val ${pmWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`} style={{ fontSize: 16 }}>
              {pmWinProfit >= 0 ? '+' : ''}${pmWinProfit.toFixed(2)}
            </span>
            <span className={`calc-result-pct ${pmWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`} style={{ fontSize: 13 }}>
              ({profitPct >= 0 ? '+' : ''}
              {profitPct.toFixed(2)}%)
            </span>
          </div>
          <div className="calc-result-divider" />
          <div className="calc-result-side">
            <span className={`calc-result-val ${dexWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`} style={{ fontSize: 16 }}>
              {dexWinProfit >= 0 ? '+' : ''}${dexWinProfit.toFixed(2)}
            </span>
            <span className={`calc-result-pct ${dexWinProfit >= 0 ? 'calc-result-val--pos' : 'calc-result-val--neg'}`} style={{ fontSize: 13 }}>
              ({profitPct >= 0 ? '+' : ''}
              {profitPct.toFixed(2)}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
