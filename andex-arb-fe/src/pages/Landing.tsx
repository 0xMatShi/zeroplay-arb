import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePlans } from '../api'
import { WalletConnectModal } from '../components/WalletConnectModal'
import { useWhoami } from '../api'
import { formatUsd } from '../utils/formatPrice'
import { LanguageSwitcher } from '../components/LanguageSwitcher'

export function Landing() {
  const { t } = useTranslation()
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [openFaqId, setOpenFaqId] = useState<string | null>(null)
  const { data: plans, isLoading } = usePlans()
  const { data: user } = useWhoami()
  const navigate = useNavigate()

  const handlePlanClick = (planId: string) => {
    if (user) {
      navigate('/dashboard', { state: { planId } })
    } else {
      setSelectedPlanId(planId)
      setIsModalOpen(true)
    }
  }

  const handleAuthSuccess = () => {
    setIsModalOpen(false)
    if (selectedPlanId) {
      navigate('/dashboard', { state: { planId: selectedPlanId } })
    } else {
      navigate('/dashboard')
    }
  }

  const handleLoginSuccess = () => {
    setIsLoginModalOpen(false)
    navigate('/dashboard')
  }

  const handleLoginClick = () => {
    if (user) {
      navigate('/dashboard')
    } else {
      setIsLoginModalOpen(true)
    }
  }

  return (
    <div className="landing">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <a href="/" className="logo">
            <span className="logo-symbol">ZP</span>
            <span>ZeroPlay</span>
          </a>
          <nav className="header-nav">
            <div className="nav-links">
              <button onClick={() => navigate('/scanner')} className="nav-link nav-link-button">{t('header.scanner')}</button>
              <a href="#alerts" className="nav-link">{t('header.alerts')}</a>
              <a href="#pricing" className="nav-link">{t('header.pricing')}</a>
              <a href="#faq" className="nav-link">{t('header.faq')}</a>
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
              <span className="hero-title-symbol">•</span> {t('hero.title')}
            </h1>
            <p className="hero-subtitle">
              {t('hero.subtitle')}
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={() => navigate('/scanner')}>
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
                {t('hero.arbDetected')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Data Sources Section */}
      <section className="data-sources">
        <div className="container">
          <h3 className="data-sources-title">{t('dataSources.title')}</h3>
          <div className="sources-grid">
            <div className="source-logo">POLYMARKET</div>
            <div className="source-logo">OPINION</div>
            <div className="source-logo">PROBABLE</div>
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
          
          {isLoading ? (
            <div className="loading">{t('pricing.loading')}</div>
          ) : (
            <div className="plans-grid">
              {plans?.filter(plan => plan.isActive).map((plan) => (
                <div key={plan.id} className="plan-card">
                  <div className="plan-header">
                    <h3 className="plan-name">{plan.name}</h3>
                    {plan.description && (
                      <p className="plan-description">{plan.description}</p>
                    )}
                  </div>
                  
                  <div className="plan-price">
                    <span className="price-amount">{formatUsd(plan.price)}</span>
                    <span className="price-period">{t('pricing.perDays', { days: plan.durationDays })}</span>
                  </div>
                  
                  <button
                    className="plan-button plan-button--primary"
                    onClick={() => handlePlanClick(plan.id)}
                  >
                    {t('pricing.subscribe')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="faq-section">
        <div className="container">
          <h2 className="section-title">{t('faq.title')}</h2>
          <div className="faq-list">
            <div className="faq-item">
              <button 
                className={`faq-question ${openFaqId === 'faq1' ? 'active' : ''}`}
                onClick={() => setOpenFaqId(openFaqId === 'faq1' ? null : 'faq1')}
              >
                <span>{t('faq.q1')}</span>
                <span className="faq-icon">{openFaqId === 'faq1' ? '−' : '+'}</span>
              </button>
              {openFaqId === 'faq1' && (
                <div className="faq-answer">{t('faq.a1')}</div>
              )}
            </div>

            <div className="faq-item">
              <button 
                className={`faq-question ${openFaqId === 'faq2' ? 'active' : ''}`}
                onClick={() => setOpenFaqId(openFaqId === 'faq2' ? null : 'faq2')}
              >
                <span>{t('faq.q2')}</span>
                <span className="faq-icon">{openFaqId === 'faq2' ? '−' : '+'}</span>
              </button>
              {openFaqId === 'faq2' && (
                <div className="faq-answer">{t('faq.a2')}</div>
              )}
            </div>

            <div className="faq-item">
              <button 
                className={`faq-question ${openFaqId === 'faq3' ? 'active' : ''}`}
                onClick={() => setOpenFaqId(openFaqId === 'faq3' ? null : 'faq3')}
              >
                <span>{t('faq.q3')}</span>
                <span className="faq-icon">{openFaqId === 'faq3' ? '−' : '+'}</span>
              </button>
              {openFaqId === 'faq3' && (
                <div className="faq-answer">{t('faq.a3')}</div>
              )}
            </div>

            <div className="faq-item">
              <button 
                className={`faq-question ${openFaqId === 'faq4' ? 'active' : ''}`}
                onClick={() => setOpenFaqId(openFaqId === 'faq4' ? null : 'faq4')}
              >
                <span>{t('faq.q4')}</span>
                <span className="faq-icon">{openFaqId === 'faq4' ? '−' : '+'}</span>
              </button>
              {openFaqId === 'faq4' && (
                <div className="faq-answer">{t('faq.a4')}</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-content">
          <div className="footer-main">
            <div className="footer-brand">
              <div className="footer-logo">
                <span className="logo-symbol">ZP</span>
                <span>ZeroPlay</span>
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
                  <li><a href="#faq">{t('header.faq')}</a></li>
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

      {/* Wallet Connect Modal for Pricing */}
      <WalletConnectModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          setSelectedPlanId(null)
        }}
        onSuccess={handleAuthSuccess}
        planId={selectedPlanId || undefined}
      />

      {/* Wallet Connect Modal for Login */}
      <WalletConnectModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  )
}
