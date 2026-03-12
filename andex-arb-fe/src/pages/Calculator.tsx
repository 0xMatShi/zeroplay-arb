import { useRef, useEffect } from 'react'
import { CalculatorContent } from '../components/CalculatorContent'

export function Calculator() {
  const params = new URLSearchParams(window.location.search)
  const initDexAmount = (() => {
    const v = params.get('dexAmount')
    if (!v) return ''
    const n = parseFloat(v)
    return isNaN(n) ? '' : String(Math.round(n))
  })()

  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const { offsetWidth, offsetHeight } = el
    const extraH = window.outerHeight - window.innerHeight
    const extraW = window.outerWidth - window.innerWidth
    window.resizeTo(offsetWidth + extraW, offsetHeight + extraH)
    window.moveTo(0, 0)
  })

  return (
    <div ref={pageRef} style={{ display: 'inline-block' }}>
      <CalculatorContent
        pmOutcome={params.get('pmOutcome') ?? '—'}
        dexOutcome={params.get('dexOutcome') ?? '—'}
        pmPrice={params.get('pmPrice') ?? '50'}
        dexOdds={params.get('dexOdds') ?? '2.00'}
        pmAmount={params.get('pmAmount') ?? ''}
        dexAmount={initDexAmount}
        dexPlatform={params.get('dexPlatform') ?? undefined}
        marketType={params.get('marketType') ?? undefined}
      />
    </div>
  )
}
