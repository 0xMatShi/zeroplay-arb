const COOKIE_DOMAIN = import.meta.env.VITE_COOKIE_DOMAIN || ''
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

function buildCookieString(name: string, value: string, maxAge: number): string {
  let cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`
  if (COOKIE_DOMAIN) cookie += `; domain=${COOKIE_DOMAIN}`
  if (window.location.protocol === 'https:') cookie += '; Secure'
  return cookie
}

export function setAuthCookies(apiKey: string, sessionToken: string): void {
  document.cookie = buildCookieString('auth_api_key', apiKey, COOKIE_MAX_AGE)
  document.cookie = buildCookieString('auth_session_token', sessionToken, COOKIE_MAX_AGE)
}

export function clearAuthCookies(): void {
  document.cookie = buildCookieString('auth_api_key', '', 0)
  document.cookie = buildCookieString('auth_session_token', '', 0)
}
