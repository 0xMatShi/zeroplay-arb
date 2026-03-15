import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useWhoami } from '../api'
import { ApiKeyModal } from '../components/ApiKeyModal'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { SmokeCanvas } from '../components/SmokeCanvas'
import './Pricing.css'

function BlurredText({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const fontSize = 13
    const font = `${fontSize}px Inter, -apple-system, sans-serif`
    ctx.font = font
    const width = Math.ceil(ctx.measureText(text).width) + 10
    canvas.width = width
    canvas.height = fontSize + 6
    ctx.font = font
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
    ctx.fillText(text, 5, fontSize)
  }, [text])

  return <canvas ref={canvasRef} style={{ filter: 'blur(3px)', verticalAlign: 'middle', userSelect: 'none' }} />
}

type Period = 'week' | 'month' | '3month'
type CellValue = 'check' | 'cross' | 'instant'

interface SubRow {
  name: React.ReactNode
  week: CellValue
  base: CellValue
  pro: CellValue
}

interface FeatureRow {
  id: string
  name: string
  expandContent?: React.ReactNode
  subRows?: SubRow[]
  expandFooter?: React.ReactNode
  week: CellValue
  base: CellValue
  pro: CellValue
}

interface Section {
  id: string
  name: string
  description: React.ReactNode
  features: FeatureRow[]
}

type TFunc = (key: string) => string

function getSections(t: TFunc): Section[] {
  const s = (k: string) => t(`pricingPage.sections.${k}`)
  return [
    {
      id: 'odds-scanner',
      name: s('oddsScanner.name'),
      description: <p>{s('oddsScanner.desc')}</p>,
      features: [
        {
          id: 'pm-bookmakers',
          name: s('oddsScanner.pmBookmakers.name'),
          subRows: [
            { name: <>Polymarket {'<>'} <BlurredText text="DexSport" /></>, week: 'check', base: 'check', pro: 'check' },
            { name: <>Polymarket {'<>'} <BlurredText text="Pinnacle" /></>, week: 'check', base: 'check', pro: 'check' },
          ],
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'market-matching',
          name: s('oddsScanner.marketMatching.name'),
          expandContent: <p>{s('oddsScanner.marketMatching.expand')}</p>,
          week: 'instant', base: 'instant', pro: 'instant',
        },
        {
          id: 'markets-bet-types',
          name: s('oddsScanner.marketsBetTypes.name'),
          expandContent: <p>{s('oddsScanner.marketsBetTypes.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'position-calculator',
          name: s('oddsScanner.positionCalculator.name'),
          expandContent: <p>{s('oddsScanner.positionCalculator.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'autobet-setup',
          name: s('oddsScanner.autoBetSetup.name'),
          expandContent: <p>{s('oddsScanner.autoBetSetup.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'liquidity-filter',
          name: s('oddsScanner.liquidityFilter.name'),
          expandContent: <p>{s('oddsScanner.liquidityFilter.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'profit-roi-filter',
          name: s('oddsScanner.profitRoiFilter.name'),
          expandContent: <p>{s('oddsScanner.profitRoiFilter.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'arb-alerts',
          name: s('oddsScanner.arbAlerts.name'),
          expandContent: <p>{s('oddsScanner.arbAlerts.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'cancel-protection',
          name: s('oddsScanner.cancelProtection.name'),
          expandContent: <p>{s('oddsScanner.cancelProtection.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
      ],
    },
    {
      id: 'arbitrage',
      name: s('arbitrage.name'),
      description: <p>{s('arbitrage.desc')}</p>,
      features: [
        {
          id: 'pm-pm',
          name: s('arbitrage.pmPm.name'),
          subRows: [
            { name: 'Polymarket', week: 'check', base: 'check', pro: 'check' },
            { name: 'Kalshi', week: 'check', base: 'check', pro: 'check' },
            { name: 'Opinion', week: 'check', base: 'check', pro: 'check' },
            { name: 'Predict.Fun', week: 'check', base: 'check', pro: 'check' },
            { name: 'Probable.Markets', week: 'check', base: 'check', pro: 'check' },
          ],
          expandFooter: <p>{s('arbitrage.pmPm.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'arb-detection',
          name: s('arbitrage.arbDetection.name'),
          expandContent: <p>{s('arbitrage.arbDetection.expand')}</p>,
          week: 'instant', base: 'instant', pro: 'instant',
        },
        {
          id: 'arb-calculator',
          name: s('arbitrage.arbCalculator.name'),
          expandContent: <p>{s('arbitrage.arbCalculator.expand')}</p>,
          week: 'check', base: 'check', pro: 'check',
        },
        {
          id: 'telegram-alerts',
          name: s('arbitrage.telegramAlerts.name'),
          expandContent: <p>{s('arbitrage.telegramAlerts.expand')}</p>,
          week: 'cross', base: 'cross', pro: 'check',
        },
      ],
    },
    {
      id: 'support',
      name: s('support.name'),
      description: <p>{s('support.desc')}</p>,
      features: [
        {
          id: 'community',
          name: s('support.community.name'),
          expandContent: <p>{s('support.community.expand')}</p>,
          week: 'cross', base: 'cross', pro: 'check',
        },
        {
          id: 'help',
          name: s('support.help.name'),
          expandContent: <p>{s('support.help.expand')}</p>,
          week: 'cross', base: 'cross', pro: 'check',
        },
        {
          id: 'knowledge',
          name: s('support.knowledge.name'),
          expandContent: <p>{s('support.knowledge.expand')}</p>,
          week: 'cross', base: 'cross', pro: 'check',
        },
      ],
    },
  ]
}

const PLANS: Record<Period, { left?: { name: string; price: string; oldPrice?: string }; right?: { name: string; price: string; oldPrice?: string } }> = {
  week: {
    left: { name: 'TEST', price: '$30' },
  },
  month: {
    left: { name: 'MEDIUM', price: '$100' },
    right: { name: 'PRO', price: '$150' },
  },
  '3month': {
    left: { name: 'MEDIUM', price: '$80', oldPrice: '$100' },
    right: { name: 'PRO', price: '$120', oldPrice: '$150' },
  },
}

function CheckIcon() {
  return (
    <svg className="pricing-cell-check" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 10l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg className="pricing-cell-cross" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function Cell({ value, instant }: { value: CellValue; instant: string }) {
  if (value === 'check') return <CheckIcon />
  if (value === 'cross') return <CrossIcon />
  return <span className="pricing-cell-instant">{instant}</span>
}

export function Pricing() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('month')
  const [selectedPlan] = useState<'base' | 'pro'>('pro')
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const { data: user } = useWhoami()
  const navigate = useNavigate()
  const sections = getSections(t as TFunc)

  const plans = PLANS[period]
  const twoColumns = !!plans.right

  const handleLoginClick = () => {
    if (user) {
      navigate('/scanner')
    } else {
      setIsLoginModalOpen(true)
    }
  }

  const handleLoginSuccess = () => {
    setIsLoginModalOpen(false)
    navigate('/scanner')
  }

  const toggleFeature = (id: string) => {
    setExpandedFeature(prev => (prev === id ? null : id))
  }

  const toggleSection = (id: string) => {
    setExpandedSection(prev => (prev === id ? null : id))
  }

  const telegramUrl = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/your_bot'

  return (
    <div className="pricing-page">
      <SmokeCanvas />

      {/* Header */}
      <header className="header">
        <div className="header-content">
          <a href="/" className="logo" data-text="SubLine">
            <span>SubLine</span>
          </a>
          <nav className="header-nav">
            <div className="nav-links">
              <button onClick={() => navigate('/scanner')} className="nav-link nav-link-button" data-text={t('header.scanner')}>{t('header.scanner')}</button>
              <a href="/#alerts" className="nav-link" data-text={t('header.alerts')}>{t('header.alerts')}</a>
              <a href="/pricing" className="nav-link" data-text={t('header.pricing')}>{t('header.pricing')}</a>
            </div>
            <div className="header-actions">
              <LanguageSwitcher />
              <button className="header-button-login" onClick={handleLoginClick}>{t('header.login')}</button>
              <button className="header-button-signup" onClick={() => window.open(telegramUrl, '_blank')}>
                {t('header.getAccess')}
              </button>
            </div>
          </nav>
        </div>
      </header>

      {/* Page Content */}
      <main className="pricing-main">
        <div className="pricing-container">
          <h1 className="pricing-title">{t('pricingPage.title')}</h1>
          <p className="pricing-subtitle">{t('pricingPage.subtitle')}</p>

          {/* Period Tabs */}
          <div className="pricing-tabs">
            {(['week', 'month', '3month'] as Period[]).map(p => (
              <button
                key={p}
                className={`pricing-tab${period === p ? ' pricing-tab-active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {t(`pricingPage.tab.${p}`)}
              </button>
            ))}
          </div>

          {/* Table wrapper — narrow + centered for week, full-width for month/3month */}
          <div className={twoColumns ? 'pricing-table-wrap--full' : 'pricing-table-wrap--narrow'}>
          <div className={`pricing-table pricing-cols ${twoColumns ? 'pricing-cols--two' : 'pricing-cols--one'}`}>

          {/* Table header row: Features + plan cards */}
          <div className="pricing-table-head-features">Features</div>
          {plans.left && (
            <div className={`pricing-plan-cell${!twoColumns || selectedPlan === 'base' ? ' pricing-plan-cell--selected' : ''}`}>
              <div className="pricing-plan-name">{plans.left.name}</div>
              {plans.left.oldPrice && (
                <div className="pricing-plan-old-price">{plans.left.oldPrice}<span className="pricing-plan-period">/{period === 'week' ? 'wk' : 'mo'}</span></div>
              )}
              <div className="pricing-plan-price">{plans.left.price}<span className="pricing-plan-period">/{period === 'week' ? 'wk' : 'mo'}</span></div>
              <button className="pricing-plan-btn pricing-plan-btn--pro" onClick={() => window.open(telegramUrl, '_blank')}>{t('pricingPage.getAccess')}</button>
            </div>
          )}
          {plans.right && (
            <div className={`pricing-plan-cell pricing-plan-cell--pro`}>
              <div className="pricing-plan-name">{plans.right.name}</div>
              {plans.right.oldPrice && (
                <div className="pricing-plan-old-price">{plans.right.oldPrice}<span className="pricing-plan-period">/mo</span></div>
              )}
              <div className="pricing-plan-price">{plans.right.price}<span className="pricing-plan-period">/mo</span></div>
              <button className="pricing-plan-btn pricing-plan-btn--pro" onClick={() => window.open(telegramUrl, '_blank')}>{t('pricingPage.getAccess')}</button>
            </div>
          )}

          {/* Feature Sections — span all columns */}
          {sections.map(section => {
            const colClass = twoColumns ? 'pricing-cols--two' : 'pricing-cols--one'
            const baseSelected = !twoColumns || selectedPlan === 'base'
            const proSelected = selectedPlan === 'pro'
            return (
              <div key={section.id} className="pricing-section" style={{ gridColumn: '1 / -1' }}>
                {/* Section header row */}
                <div className={`pricing-section-header pricing-cols ${colClass}`}>
                  <div className="pricing-section-header-main">
                    <div className="pricing-section-title-row">
                      <span className="pricing-section-name">{section.name}</span>
                      <button
                        className={`pricing-section-info${expandedSection === section.id ? ' pricing-section-info--open' : ''}`}
                        onClick={() => toggleSection(section.id)}
                        aria-label="Show section description"
                      >
                        ?
                      </button>
                    </div>
                    {expandedSection === section.id && (
                      <div className="pricing-section-desc">{section.description}</div>
                    )}
                  </div>
                  <div className="pricing-col-area" style={{ borderLeft: 'none' }} />
                  {twoColumns && (
                    <div className="pricing-col-area" style={{ borderLeft: 'none' }} />
                  )}
                </div>

                {/* Feature rows */}
                {section.features.map(feature => {
                  const isOpen = expandedFeature === feature.id
                  return (
                    <div
                      key={feature.id}
                      className={`pricing-feature-wrap pricing-cols ${colClass}`}
                    >
                      {/* Col 1, Row 1: feature name — clickable */}
                      <div
                        className="pricing-feature-name"
                        style={{ gridColumn: 1, gridRow: 1, cursor: 'pointer' }}
                        onClick={() => toggleFeature(feature.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => e.key === 'Enter' && toggleFeature(feature.id)}
                      >
                        <span className={`pricing-feature-arrow${isOpen ? ' pricing-feature-arrow--open' : ''}`}>›</span>
                        {feature.name}
                      </div>

                      {/* Col 2 & 3: when subRows open — single cell spanning all rows; otherwise normal */}
                      {!(isOpen && feature.subRows) && (
                        <>
                          <div
                            className={`pricing-col-area pricing-col-area--rowspan${baseSelected ? ' pricing-col-area--selected' : ''}`}
                            style={{ gridColumn: 2, gridRow: '1 / 3' }}
                          >
                            <Cell value={twoColumns ? feature.base : feature.week} instant={t('pricingPage.instant')} />
                          </div>
                          {twoColumns && (
                            <div
                              className={`pricing-col-area pricing-col-area--rowspan${proSelected ? ' pricing-col-area--selected' : ''}`}
                              style={{ gridColumn: 3, gridRow: '1 / 3' }}
                            >
                              <Cell value={feature.pro} instant={t('pricingPage.instant')} />
                            </div>
                          )}
                        </>
                      )}

                      {/* Expand: text content (rowspan) */}
                      {isOpen && feature.expandContent && (
                        <div className="pricing-feature-expand-content" style={{ gridColumn: 1, gridRow: 2 }}>
                          {feature.expandContent}
                        </div>
                      )}

                      {/* Expand: sub-rows — names in col 1, ONE checkmark spanning all rows in col 2/3 */}
                      {isOpen && feature.subRows && (
                        <>
                          {feature.subRows.map((sub, i) => (
                            <div key={`sub-name-${i}`} className="pricing-feature-sub-name" style={{ gridColumn: 1, gridRow: i + 2 }}>
                              {sub.name}
                            </div>
                          ))}
                          {feature.expandFooter && (
                            <div className="pricing-feature-expand-content pricing-feature-expand-footer" style={{ gridColumn: 1, gridRow: feature.subRows.length + 2 }}>
                              {feature.expandFooter}
                            </div>
                          )}
                          <div
                            className={`pricing-col-area${baseSelected ? ' pricing-col-area--selected' : ''}`}
                            style={{ gridColumn: 2, gridRow: `1 / ${feature.subRows.length + (feature.expandFooter ? 3 : 2)}`, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <Cell value={twoColumns ? feature.base : feature.week} instant={t('pricingPage.instant')} />
                          </div>
                          {twoColumns && (
                            <div
                              className={`pricing-col-area${proSelected ? ' pricing-col-area--selected' : ''}`}
                              style={{ gridColumn: 3, gridRow: `1 / ${feature.subRows.length + (feature.expandFooter ? 3 : 2)}`, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Cell value={feature.pro} instant={t('pricingPage.instant')} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {/* Empty footer row */}
          <div className={`pricing-table-footer pricing-cols ${twoColumns ? 'pricing-cols--two' : 'pricing-cols--one'}`} style={{ gridColumn: '1 / -1' }}>
            <div className="pricing-table-footer-cell" />
            <div className="pricing-table-footer-cell" />
            {twoColumns && <div className="pricing-table-footer-cell" />}
          </div>

          </div>{/* end pricing-table */}
          </div>{/* end pricing-table-wrap */}
        </div>
      </main>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-content">
          <div className="footer-main">
            <div className="footer-brand">
              <div className="footer-logo"><span>SubLine</span></div>
              <p className="footer-tagline">Real-time prediction market scanner for informed trading decisions.</p>
              <p className="footer-disclaimer">⚠️ Not financial advice. Trading involves risk. Past performance does not guarantee future results.</p>
            </div>
            <div className="footer-links">
              <div className="footer-column">
                <h4 className="footer-column-title">PRODUCT</h4>
                <ul className="footer-nav">
                  <li><a href="/scanner">Scanner</a></li>
                  <li><a href="/#alerts">Alerts</a></li>
                  <li><a href="/pricing">Pricing</a></li>
                </ul>
              </div>
              <div className="footer-column">
                <h4 className="footer-column-title">LEGAL</h4>
                <ul className="footer-nav">
                  <li><a href="#terms" style={{ cursor: 'not-allowed' }}>Terms of Service</a></li>
                  <li><a href="#privacy" style={{ cursor: 'not-allowed' }}>Privacy Policy</a></li>
                  <li><a href="#disclaimer" style={{ cursor: 'not-allowed' }}>Risk Disclaimer</a></li>
                </ul>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <p className="footer-copyright">© {new Date().getFullYear()} SubLine. ALL SYSTEMS OPERATIONAL.</p>
          </div>
        </div>
      </footer>

      <ApiKeyModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  )
}
