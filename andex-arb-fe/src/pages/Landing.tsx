import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useWhoami } from '../api'
import { ApiKeyModal } from '../components/ApiKeyModal'
import { formatUsd } from '../utils/formatPrice'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { SmokeCanvas } from '../components/SmokeCanvas'

function BlurredText({ text, color = 'rgba(255,255,255,0.9)', fontSize = 13 }: { text: string; color?: string; fontSize?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const font = `700 ${fontSize}px Inter, -apple-system, sans-serif`
    ctx.font = font
    const width = Math.ceil(ctx.measureText(text).width) + 10
    canvas.width = width
    canvas.height = fontSize + 6
    ctx.font = font
    ctx.fillStyle = color
    ctx.fillText(text, 5, fontSize)
  }, [text, color, fontSize])
  return <canvas ref={canvasRef} style={{ filter: 'blur(3px)', verticalAlign: 'middle', userSelect: 'none' }} />
}

export function Landing() {
  const { t } = useTranslation()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [previewMode, setPreviewMode] = useState<'bk' | 'pm'>('bk')
  const [howItWorksTab, setHowItWorksTab] = useState<'mechanism' | 'example'>('mechanism')
  const [faqOpen, setFaqOpen] = useState<number | null>(null)
  const { data: user } = useWhoami()
  const navigate = useNavigate()

  const handleLoginSuccess = () => {
    setIsLoginModalOpen(false)
    navigate('/scanner')
  }

  const handleLoginClick = () => {
    if (user) {
      navigate('/scanner')
    } else {
      setIsLoginModalOpen(true)
    }
  }

  return (
    <div className="landing">
      <SmokeCanvas />
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <Link to="/" className="logo" data-text="SubLine">
            <span>SubLine</span>
          </Link>
          <nav className="header-nav">
            <div className="nav-links">
              {/* <button onClick={() => navigate('/dashboard')} className="nav-link nav-link-button" data-text={t('header.leaderboard')}>{t('header.leaderboard')}</button> */}
              <button onClick={() => navigate('/scanner')} className="nav-link nav-link-button" data-text={t('header.scanner')}>{t('header.scanner')}</button>
              <button onClick={() => navigate('/pricing')} className="nav-link nav-link-button" data-text={t('header.pricing')}>{t('header.pricing')}</button>
            </div>
            <div className="header-actions">
              <LanguageSwitcher />
              <button className="header-button-login" onClick={handleLoginClick}>
                {t('header.login')}
              </button>
              <button
                className="header-button-signup"
                onClick={() => {
                  const pricingSection = document.getElementById('pricing');
                  if (pricingSection) {
                    pricingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
              >
                {t('header.getAccess')}
              </button>
              <a href="https://t.me/Subline_arb" className="header-social-icon" target="_blank" rel="noopener noreferrer" aria-label="Telegram">
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                </svg>
              </a>
              <a href="https://x.com/Subline_arb" className="header-social-icon" target="_blank" rel="noopener noreferrer" aria-label="X">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
            </div>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-container hero-container--centered">
          <div className="hero-content hero-content--centered">
            <h1 className="hero-title">
              {t('hero.titleLine1')}<br />{t('hero.titleLine2')}
            </h1>
            <p className="hero-subtitle">
              {t('hero.subtitle')}
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={() => {
                const pricingSection = document.getElementById('pricing');
                if (pricingSection) {
                  pricingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}>
                {t('hero.openScanner')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Preview Section */}
      <section className="preview-section">
        <div className="container">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '24px' }}>
            <div className="preview-toggle">
              <button className={`preview-tab${previewMode === 'bk' ? ' preview-tab--active' : ''}`} onClick={() => setPreviewMode('bk')}>PM - BK</button>
              <button className={`preview-tab${previewMode === 'pm' ? ' preview-tab--active' : ''}`} onClick={() => setPreviewMode('pm')}>PM - PM</button>
            </div>
          </div>

          {/* PM-BK card — same structure as SportsOpportunityCard */}
          {previewMode === 'bk' && (
            <div className="opportunity-card sports-card" style={{ animation: 'none', opacity: 1, background: 'rgba(25, 26, 33, 0.45)', backdropFilter: 'blur(12px)' }}>
              <div className="sports-card-main">
                <div className="sports-card-info">
                  <div className="sports-event-title">BESTIA vs Gaimin Gladiators — Counter-Strike. Roman Imperium Cup</div>
                  <div className="sports-start-time">13 Mar 2026, 13:45 (UTC)</div>
                  <div className="sports-badges">
                    <span className="sports-sport-badge">CS2</span>
                    <span className="sports-live-badge sports-live-badge--live">
                      <span className="sports-live-dot" />
                      LIVE
                    </span>
                    <span className="sports-validated">7s</span>
                  </div>
                  <div className="sports-market-type">Match Winner</div>
                </div>
                <div className="sports-card-platforms">
                  <div className="sports-platform-box" style={{ background: 'rgba(25, 26, 33, 0.45)', backdropFilter: 'blur(12px)' }}>
                    <div className="sports-platform-label sports-platform-label--pm">POLYMARKET</div>
                    <div className="sports-outcome-name">Gaimin Gladiators</div>
                    <div className="sports-amounts-inline">
                      <span className="sports-amount-key">B:</span>
                      <span className="sports-amount-val">$380</span>
                      <span className="sports-amounts-sep">|</span>
                      <span className="sports-amount-key">L:</span>
                      <span className="sports-amount-val">$100</span>
                    </div>
                    <div className="sports-price-row">
                      <span className="sports-cents">36¢</span>
                      <span className="sports-odds">2.78x</span>
                    </div>
                  </div>
                  <div className="sports-platform-box" style={{ background: 'rgba(25, 26, 33, 0.45)', backdropFilter: 'blur(12px)' }}>
                    <div className="sports-platform-label sports-platform-label--dex">
                      <BlurredText text="DEXSPORT" color="#a78bfa" fontSize={13} />
                    </div>
                    <div className="sports-outcome-name">BESTIA</div>
                    <div className="sports-amounts-inline">
                      <span className="sports-amount-key">B:</span>
                      <span className="sports-amount-val">$620</span>
                      <span className="sports-amounts-sep">|</span>
                      <span className="sports-amount-key">L:</span>
                      <span className="sports-amount-val">$160</span>
                    </div>
                    <div className="sports-price-row">
                      <span className="sports-cents sports-cents--muted">60¢</span>
                      <span className="sports-odds">1.67x</span>
                    </div>
                  </div>
                </div>
                <div className="sports-card-metrics">
                  <div className="sports-metric-box">
                    <div className="sports-metric-value sports-metric-value--pos">+4.30%</div>
                  </div>
                  <div className="sports-metric-box">
                    <div className="sports-metric-value sports-metric-value--pos">+$11.10</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PM-PM card — same structure as OpportunityCard */}
          {previewMode === 'pm' && (
            <div className="opportunity-card" style={{ animation: 'none', opacity: 1, background: 'rgba(25, 26, 33, 0.45)', backdropFilter: 'blur(12px)' }}>
              <div className="opp-header">
                <div className="opp-header-left">
                  <h3 className="opp-match-title">
                    <span className="opp-match-title__platform">(Polymarket)</span>
                    {' '}US recession by end of 2026?
                    <span className="opp-match-title__sep"> / </span>
                    <span className="opp-match-title__platform">(Opinion)</span>
                    {' '}US recession by end of 2026?
                  </h3>
                </div>
                <div className="opp-header-right">
                  <span className="opp-profit">+4.82% | +$54.40</span>
                </div>
              </div>
              <div className="opp-legs">
                <div className="arb-leg" style={{ background: 'rgba(25, 26, 33, 0.45)', backdropFilter: 'blur(12px)' }}>
                  <div className="leg-platform">POLYMARKET</div>
                  <div className="leg-outcome">
                    <span className="leg-outcome-label">Buy:</span>
                    <span className="leg-outcome-name">No</span>
                  </div>
                  <div className="leg-price">67¢<span className="leg-investment"> | $793.00</span></div>
                  <span className="leg-open-link">OPEN</span>
                </div>
                <div className="arb-leg">
                  <div className="leg-platform">OPINION</div>
                  <div className="leg-outcome">
                    <span className="leg-outcome-label">Buy:</span>
                    <span className="leg-outcome-name">YES</span>
                  </div>
                  <div className="leg-price">28¢<span className="leg-investment"> | $336.10</span></div>
                  <span className="leg-open-link">OPEN</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Why SubLine Section */}
      <section className="problem-solution-section">
        <div className="container">
          <h2 className="section-title">{t('whySubline.title')}</h2>
          <div className="why-subline-card">
            {([1,2,3,4,5] as const).map((n) => (
              <div key={n} className="why-subline-item">
                <div className="why-subline-item-title">{t(`whySubline.item${n}Title`)}</div>
                <p className="why-subline-item-desc">{t(`whySubline.item${n}Desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="scanner" className="how-it-works-section">
        <div className="container">
          <h2 className="section-title">{t('howItWorks.title')}</h2>
          <p className="section-subtitle">{t('howItWorks.subtitle')}</p>
          <div className="hiw-tabs">
            <div className="hiw-toggle">
              <button
                className={`hiw-tab${howItWorksTab === 'mechanism' ? ' hiw-tab--active' : ''}`}
                onClick={() => setHowItWorksTab('mechanism')}
              >
                {t('howItWorks.tabMechanism')}
              </button>
              <button
                className={`hiw-tab${howItWorksTab === 'example' ? ' hiw-tab--active' : ''}`}
                onClick={() => setHowItWorksTab('example')}
              >
                {t('howItWorks.tabExample')}
              </button>
            </div>
          </div>
          <div key={howItWorksTab} className="hiw-content">
            {howItWorksTab === 'mechanism' ? (
              <div className="steps-grid">
                <div className="step-card">
                  <h3 className="step-title">{t('howItWorks.step1Title')}</h3>
                  <p className="step-description">{t('howItWorks.step1Desc')}</p>
                </div>
                <div className="step-arrow">→</div>
                <div className="step-card">
                  <h3 className="step-title">{t('howItWorks.step2Title')}</h3>
                  <p className="step-description">{t('howItWorks.step2Desc')}</p>
                </div>
                <div className="step-arrow">→</div>
                <div className="step-card">
                  <h3 className="step-title">{t('howItWorks.step3Title')}</h3>
                  <p className="step-description">{t('howItWorks.step3Desc')}</p>
                </div>
              </div>
            ) : (
              <div className="hiw-example">
                <h3 className="hiw-example-title">{t('howItWorks.exampleTitle')}</h3>
                <p className="hiw-example-subtitle">{t('howItWorks.exampleSubtitle')}</p>
                <div className="hiw-example-bets">
                  <div className="hiw-example-bet hiw-example-bet--1">
                    <div className="hiw-example-bet-left">
                      <div className="hiw-example-bet-label">
                        <span className="hiw-bet-number hiw-bet-number--1">{t('howItWorks.exampleBet1Number')}</span>{t('howItWorks.exampleBet1Title')}
                      </div>
                      <div className="hiw-example-bet-platform">{t('howItWorks.exampleBet1Platform')}</div>
                    </div>
                    <div className="hiw-example-bet-right">
                      <span className="hiw-bet-amount">{t('howItWorks.exampleBet1Amount')}</span>
                      <span className="hiw-bet-sep">×</span>
                      <span className="hiw-bet-odds">{t('howItWorks.exampleBet1Odds')}</span>
                      <span className="hiw-bet-sep">=</span>
                      <span className="hiw-bet-result">{t('howItWorks.exampleBet1Result')}</span>
                    </div>
                  </div>
                  <div className="hiw-example-bet hiw-example-bet--2">
                    <div className="hiw-example-bet-left">
                      <div className="hiw-example-bet-label">
                        <span className="hiw-bet-number hiw-bet-number--2">{t('howItWorks.exampleBet2Number')}</span>{t('howItWorks.exampleBet2Title')}
                      </div>
                      <div className="hiw-example-bet-platform">{t('howItWorks.exampleBet2Platform')}</div>
                    </div>
                    <div className="hiw-example-bet-right">
                      <span className="hiw-bet-amount">{t('howItWorks.exampleBet2Amount')}</span>
                      <span className="hiw-bet-sep">×</span>
                      <span className="hiw-bet-odds">{t('howItWorks.exampleBet2Odds')}</span>
                      <span className="hiw-bet-sep">=</span>
                      <span className="hiw-bet-result">{t('howItWorks.exampleBet2Result')}</span>
                    </div>
                  </div>
                </div>
                <p className="hiw-example-conclusion">{t('howItWorks.exampleConclusion')}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="alerts" className="features-section">
        <div className="container">
          <h2 className="section-title">{t('features.title')}</h2>
          <div className="features-grid">
            <div className="feature-card">
              <h3>{t('features.oddsTitle')}</h3>
              <p>{t('features.oddsDesc')}</p>
            </div>
            <div className="feature-card">
              <h3>{t('features.feedTitle')}</h3>
              <p>{t('features.feedDesc')}</p>
            </div>
            <div className="feature-card">
              <h3>{t('features.calcTitle')}</h3>
              <p>{t('features.calcDesc')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Plans Section */}
      <section id="pricing" className="plans-section">
        <div className="container">
          <h2 className="section-title">{t('pricing.title')}</h2>
          <p className="section-subtitle">{t('pricing.subtitle')}</p>
          
          <div className="plans-grid">
            {[
              { id: 'basic', name: 'LITE', description: t('pricing.basicDesc'), price: '35', durationDays: 7 },
              { id: 'medium', name: 'PRO', description: t('pricing.mediumDesc'), price: '149', durationDays: 30 },
              { id: 'pro', name: 'MAX', description: t('pricing.proDesc'), price: '359', durationDays: 90 },
            ].map((plan) => (
              <div key={plan.id} className="plan-card">
                <div className="plan-header">
                  <h3 className="plan-name">{plan.name}</h3>
                  <p className="plan-description">{plan.description}</p>
                </div>

                <div className="plan-price">
                  <span className="price-amount">{formatUsd(plan.price)}</span>
                  <span className="price-period">{t('pricing.perDays', { days: plan.durationDays })}</span>
                </div>

                <button
                  className="plan-button plan-button--primary"
                  onClick={() => navigate('/pricing')}
                >
                  {t('pricing.buy')}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="faq-section">
        <div className="container">
          <h2 className="section-title">{t('faq.title')}</h2>
          <div className="faq-list">
            {([1,2,3,4,5,6,7,8] as const).map((n) => (
              <div
                key={n}
                className={`faq-item${faqOpen === n ? ' faq-item--open' : ''}`}
                onClick={() => setFaqOpen(faqOpen === n ? null : n)}
              >
                <div className="faq-question">
                  <span data-text={t(`faq.q${n}`)}>{t(`faq.q${n}`)}</span>
                  <span className="faq-icon" data-icon={faqOpen === n ? '−' : '+'}>{faqOpen === n ? '−' : '+'}</span>
                </div>
                <div className={`faq-answer${faqOpen === n ? ' faq-answer--open' : ''}`}>{t(`faq.a${n}`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-content">
          <div className="footer-main">
            <div className="footer-brand">
              <div className="footer-logo">
                <span>SubLine</span>
              </div>
              <p className="footer-tagline">{t('footer.tagline')}</p>
              <p className="footer-disclaimer">⚠️ {t('footer.disclaimer')}</p>
            </div>
            <div className="footer-links">
              <div className="footer-column">
                <h4 className="footer-column-title">{t('footer.product')}</h4>
                <ul className="footer-nav">
                  <li><a href="#scanner">{t('header.scanner')}</a></li>
                  <li><Link to="/pricing">{t('header.pricing')}</Link></li>
                </ul>
              </div>
              <div className="footer-column">
                <h4 className="footer-column-title">{t('footer.legal')}</h4>
                <ul className="footer-nav">
                  <li><a href="#terms" style={{ cursor: 'not-allowed' }}>{t('footer.terms')}</a></li>
                  <li><a href="#privacy" style={{ cursor: 'not-allowed' }}>{t('footer.privacy')}</a></li>
                  <li><a href="#disclaimer" style={{ cursor: 'not-allowed' }}>{t('footer.riskDisclaimer')}</a></li>
                </ul>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <p className="footer-copyright">{t('footer.copyright', { year: new Date().getFullYear() })}</p>
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
