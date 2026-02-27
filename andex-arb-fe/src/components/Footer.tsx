import { useTranslation } from 'react-i18next'

const APP_VERSION = 'v2.4.1'

export function Footer() {
  const { t } = useTranslation()
  const year = new Date().getFullYear()

  return (
    <footer className="app-footer">
      <div className="app-footer-content">
        <div className="app-footer-grid">
          {/* Brand & Copyright */}
          <div className="app-footer-brand">
            <div className="app-footer-logo">
              <span className="app-footer-logo-symbol">ZP</span>
              <span>ZeroPlay</span>
            </div>
            <p className="app-footer-copyright">
              © {year}. {t('appFooter.allRights')}
            </p>
          </div>

          {/* Links */}
          <div className="app-footer-links">
            <div className="app-footer-col">
              <h4 className="app-footer-col-title">{t('appFooter.support')}</h4>
              <ul className="app-footer-nav">
                <li><a href="https://t.me/oddsnexus" target="_blank" rel="noopener noreferrer">Telegram</a></li>
                <li><a href="https://discord.gg/oddsnexus" target="_blank" rel="noopener noreferrer">Discord</a></li>
                <li><a href="mailto:support@oddsnexus.com">{t('appFooter.contact')}</a></li>
              </ul>
            </div>
            <div className="app-footer-col">
              <h4 className="app-footer-col-title">{t('appFooter.legal')}</h4>
              <ul className="app-footer-nav">
                <li><a href="/terms">{t('appFooter.terms')}</a></li>
                <li><a href="/privacy">{t('appFooter.privacy')}</a></li>
              </ul>
            </div>
          </div>

          {/* System Status */}
          <div className="app-footer-system">
            <div className="app-footer-status">
              <span className="app-footer-status-dot" />
              <span className="app-footer-status-text">{t('appFooter.systemOnline')}</span>
            </div>
            <div className="app-footer-build">
              {t('appFooter.build')}: {APP_VERSION}
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
