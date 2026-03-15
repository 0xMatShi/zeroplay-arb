import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
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
          <a href="/" className="logo" data-text="SubLine">
            <span>SubLine</span>
          </a>
          <nav className="header-nav">
            <div className="nav-links">
              <button onClick={() => navigate('/scanner')} className="nav-link nav-link-button" data-text={t('header.scanner')}>{t('header.scanner')}</button>
              <a href="#alerts" className="nav-link" data-text={t('header.alerts')}>{t('header.alerts')}</a>
              <a href="/pricing" className="nav-link" data-text={t('header.pricing')}>{t('header.pricing')}</a>
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
            </div>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-container hero-container--centered">
          <div className="hero-content hero-content--centered">
            <h1 className="hero-title">
              {t('hero.title')}
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
          <h2 className="section-title">{t('preview.title')}</h2>
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

      {/* Problem/Solution Section */}
      <section className="problem-solution-section">
        <div className="container">
          <h2 className="section-title">{t('problemSolution.title')}</h2>
          <div className="comparison-grid">
            <div className="comparison-card problem">
              <h3 className="comparison-title">{t('problemSolution.manualTitle')}</h3>
              <ul className="comparison-list">
                <li className="comparison-item negative">
                  <span className="icon">✕</span>
                  <span>{t('problemSolution.manualItems.tabs')}</span>
                </li>
                <li className="comparison-item negative">
                  <span className="icon">✕</span>
                  <span>{t('problemSolution.manualItems.oddsChange')}</span>
                </li>
                <li className="comparison-item negative">
                  <span className="icon">✕</span>
                  <span>{t('problemSolution.manualItems.timeWasted')}</span>
                </li>
                <li className="comparison-item negative">
                  <span className="icon">✕</span>
                  <span>{t('problemSolution.manualItems.missOpportunities')}</span>
                </li>
              </ul>
            </div>
            <div className="comparison-card solution">
              <h3 className="comparison-title">{t('problemSolution.nexusTitle')}</h3>
              <ul className="comparison-list">
                <li className="comparison-item positive">
                  <span className="icon">✓</span>
                  <span>{t('problemSolution.nexusItems.oneTable')}</span>
                </li>
                <li className="comparison-item positive">
                  <span className="icon">✓</span>
                  <span>{t('problemSolution.nexusItems.highlights')}</span>
                </li>
                <li className="comparison-item positive">
                  <span className="icon">✓</span>
                  <span>{t('problemSolution.nexusItems.telegramAlerts')}</span>
                </li>
                <li className="comparison-item positive">
                  <span className="icon">✓</span>
                  <span>{t('problemSolution.nexusItems.monitoring')}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="scanner" className="how-it-works-section">
        <div className="container">
          <h2 className="section-title">{t('howItWorks.title')}</h2>
          <div className="steps-grid">
            <div className="step-card">
              <div className="step-label">{t('howItWorks.step1Label')}</div>
              <h3 className="step-title">{t('howItWorks.step1Title')}</h3>
              <p className="step-description">{t('howItWorks.step1Desc')}</p>
            </div>
            <div className="step-arrow">→</div>
            <div className="step-card">
              <div className="step-label">{t('howItWorks.step2Label')}</div>
              <h3 className="step-title">{t('howItWorks.step2Title')}</h3>
              <p className="step-description">{t('howItWorks.step2Desc')}</p>
            </div>
            <div className="step-arrow">→</div>
            <div className="step-card">
              <div className="step-label">{t('howItWorks.step3Label')}</div>
              <h3 className="step-title">{t('howItWorks.step3Title')}</h3>
              <p className="step-description">{t('howItWorks.step3Desc')}</p>
            </div>
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
              { id: 'basic', name: 'TEST', description: t('pricing.basicDesc'), price: '30', durationDays: 7 },
              { id: 'medium', name: 'Medium', description: t('pricing.mediumDesc'), price: '100', durationDays: 30 },
              { id: 'pro', name: 'Pro', description: t('pricing.proDesc'), price: '150', durationDays: 30 },
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
                  onClick={() => window.location.href = '/pricing'}
                >
                  {t('pricing.buy')}
                </button>
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
                  <li><a href="#alerts">{t('header.alerts')}</a></li>
                  <li><a href="/pricing">{t('header.pricing')}</a></li>
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
