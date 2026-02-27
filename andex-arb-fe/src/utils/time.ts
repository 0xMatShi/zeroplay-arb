const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Форматирует ISO дату в относительное время: "5 мин назад", "2 ч назад" и т.д.
 * Использует Intl.RelativeTimeFormat — без сторонних библиотек.
 */
export function formatRelativeTime(isoDate: string, locale = 'en'): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })

  if (diffSec < MINUTE) {
    return rtf.format(-diffSec, 'second')
  }

  if (diffSec < HOUR) {
    return rtf.format(-Math.floor(diffSec / MINUTE), 'minute')
  }

  if (diffSec < DAY) {
    return rtf.format(-Math.floor(diffSec / HOUR), 'hour')
  }

  return rtf.format(-Math.floor(diffSec / DAY), 'day')
}
