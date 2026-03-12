import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useWhoami } from '../api'
import { ApiKeyModal } from '../components/ApiKeyModal'
import { formatUsd } from '../utils/formatPrice'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { SmokeCanvas } from '../components/SmokeCanvas'

export function Landing() {
  const { t } = useTranslation()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
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
              <a href="#pricing" className="nav-link" data-text={t('header.pricing')}>{t('header.pricing')}</a>
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
        <div className="hero-container">
          <div className="hero-content">
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
              {/* <button className="secondary-button" onClick={() => window.open('https://t.me/oddsnexus', '_blank')}>
                {t('hero.telegram')}
              </button> */}
            </div>
          </div>
          <div className="hero-visual">
            <div className="widget-header">
              <span className="widget-title">{t('hero.widgetTitle')}</span>
              <div className="live-indicator">
                <span className="live-dot"></span>
                <span className="live-text">{t('hero.live')}</span>
              </div>
            </div>
            
            <div className="event-card">
              <div className="event-name">🇺🇸 {t('hero.eventName')}</div>
              
              <div className="odds-container">
                <div className="odds-block polymarket">
                  <div className="platform-name">POLYMARKET</div>
                  <div className="odds-value">YES: 35¢</div>
                </div>
                
                <div className="odds-separator">|</div>
                
                <div className="odds-block kalshi">
                  <div className="platform-name">OPINION</div>
                  <div className="odds-value">NO: 55¢</div>
                </div>
              </div>
              
              <button className="arb-result-button">
                <span>{t('hero.arbDetected')}</span>
              </button>
            </div>
          </div>
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
              { id: 'basic', name: 'Basic', description: t('pricing.basicDesc'), price: '19.9', durationDays: 7 },
              { id: 'medium', name: 'Medium', description: t('pricing.mediumDesc'), price: '99.9', durationDays: 30 },
              { id: 'pro', name: 'Pro', description: t('pricing.proDesc'), price: '199.9', durationDays: 30 },
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
                  onClick={() => window.open(import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/your_bot', '_blank')}
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
                  <li><a href="#pricing">{t('header.pricing')}</a></li>
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
