import React, { useEffect, useState } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

function getCookie(name: string): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

export default function Root({ children }: { children: React.ReactNode }) {
  const { siteConfig } = useDocusaurusContext();
  const mainSiteUrl = (siteConfig.customFields?.mainSiteUrl as string) ?? 'http://localhost:5173';
  const backendUrl = (siteConfig.customFields?.backendUrl as string) ?? 'http://localhost:3000';

  // 'checking' | 'authorized' | 'unauthorized'
  const [authState, setAuthState] = useState<'checking' | 'authorized' | 'unauthorized'>('checking');

  useEffect(() => {
    const apiKey = getCookie('auth_api_key');
    const sessionToken = getCookie('auth_session_token');

    if (!apiKey || !sessionToken) {
      setAuthState('unauthorized');
      return;
    }

    // Верифицируем у бэкенда (защита от просроченных/подделанных кук).
    // Передаём токены в заголовках — credentials: include не нужен.
    fetch(`${backendUrl}/auth/siwe/check`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Session-Token': sessionToken,
      },
    })
      .then((res) => {
        if (res.ok) {
          setAuthState('authorized');
        } else {
          setAuthState('unauthorized');
        }
      })
      .catch(() => {
        // Если бэкенд недоступен — пускаем по кукам (не блокируем)
        setAuthState('authorized');
      });
  }, [backendUrl]);

  useEffect(() => {
    if (authState === 'unauthorized') {
      const redirectUrl = `${mainSiteUrl}/?redirect=docs`;
      window.location.replace(redirectUrl);
    }
  }, [authState, mainSiteUrl]);

  if (authState === 'checking' || authState === 'unauthorized') {
    return null; // Пустой экран пока идёт проверка / происходит редирект
  }

  return <>{children}</>;
}
