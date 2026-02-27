import { useTranslation } from 'react-i18next'

export function LanguageSwitcher() {
  const { i18n } = useTranslation()

  const toggleLanguage = () => {
    const newLang = i18n.language === 'ru' ? 'en' : 'ru'
    i18n.changeLanguage(newLang)
  }

  return (
    <button className="lang-switcher" onClick={toggleLanguage} title="Switch language">
      {i18n.language === 'ru' ? 'EN' : 'RU'}
    </button>
  )
}
