/**
 * Тест Pinnacle888 REST API — сессионный подход
 * Запуск: npx ts-node scripts/test-pinnacle888.ts
 *
 * Переменные окружения (опционально для шага авторизации):
 *   P888_USER=your_username
 *   P888_PASS=your_password
 *
 * Шаги:
 *   1. Получаем fingerprint cookie (без авторизации)
 *   2. Проверяем публичные endpoints: left-menu, leagues
 *   3. Если P888_USER/P888_PASS заданы — логинимся
 *   4. Запрашиваем odds для E Sports (sportId=12) с polling
 */

import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';

const BASE_URL = 'https://www.pinnacle888.com';
const SPORT_ESPORTS = 12;
const LOCALE = 'en_US';

// ─────────────────────────────────────────────────────────────
// HTTP client
// ─────────────────────────────────────────────────────────────

function makeClient(cookies: Record<string, string> = {}): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 15_000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE_URL}/en/standard/esports/cs2`,
    },
  });
}

// Простое хранилище куки
let sessionCookies: Record<string, string> = {};

function cookieHeader(): string {
  return Object.entries(sessionCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Парсим Set-Cookie заголовки из ответа и сохраняем в sessionCookies */
function saveCookies(setCookieHeader: string | string[] | undefined): void {
  if (!setCookieHeader) return;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const pair = h.split(';')[0].trim();
    const [name, ...valueParts] = pair.split('=');
    if (name) sessionCookies[name.trim()] = valueParts.join('=').trim();
  }
}

function ts(): string {
  return String(Date.now());
}

// ─────────────────────────────────────────────────────────────
// Шаг 1: Fingerprint (сессионная инициализация)
// ─────────────────────────────────────────────────────────────

async function getFingerprint(): Promise<void> {
  console.log('\n[1] Инициализация fingerprint...');
  const client = makeClient();
  const fpId = randomUUID().replace(/-/g, '');

  const res = await client.post(
    `/member-service/v2/finger-print?fpId=${fpId}&locale=${LOCALE}&_=${ts()}&withCredentials=true`,
    {},
    {
      headers: { Cookie: cookieHeader() },
      validateStatus: () => true,
    },
  );

  saveCookies(res.headers['set-cookie']);
  console.log(`    status: ${res.status}`);
  console.log(`    cookies сохранены: ${Object.keys(sessionCookies).join(', ') || 'нет'}`);
}

// ─────────────────────────────────────────────────────────────
// Шаг 2: Публичные endpoints — sports + leagues
// ─────────────────────────────────────────────────────────────

async function fetchPublicData(): Promise<void> {
  console.log('\n[2] Публичные данные (без авторизации)...');
  const client = makeClient();
  const headers = { Cookie: cookieHeader() };

  // Список спортов
  const menuRes = await client.get(
    `/sports-service/sv/euro/left-menu?locale=${LOCALE}&_=${ts()}&withCredentials=true`,
    { headers },
  );
  const sports: any[] = menuRes.data;
  const activeSports = sports.filter((s) => s.totalEvents > 0);
  console.log(`\n  Активных спортов: ${activeSports.length}`);
  for (const s of activeSports) {
    console.log(`    id=${s.id}  "${s.englishName}"  events=${s.totalEvents}  market=${s.primaryMarketType}`);
  }

  // Лиги по E Sports
  const leaguesRes = await client.get(
    `/sports-service/sv/euro/leagues?sportId=${SPORT_ESPORTS}&locale=${LOCALE}&_=${ts()}&withCredentials=true`,
    { headers },
  );
  const leagues: any[] = leaguesRes.data;
  console.log(`\n  E Sports лиги (${leagues.length}):`);
  for (const l of leagues) {
    console.log(`    id=${l.id}  "${l.englishName}"  events=${l.totalEvents}  game=${l.gameCode}`);
  }

  // Сохраним первую CS2 лигу для шага odds
  const cs2League = leagues.find((l) => l.gameCode === 'cs2');
  if (cs2League) {
    console.log(`\n  CS2 лига для теста odds: id=${cs2League.id} "${cs2League.englishName}"`);
  }

  return cs2League;
}

// ─────────────────────────────────────────────────────────────
// Шаг 3: Авторизация (если заданы P888_USER / P888_PASS)
// ─────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  const username = process.env.P888_USER;
  const password = process.env.P888_PASS;

  if (!username || !password) {
    console.log('\n[3] P888_USER/P888_PASS не заданы — пропускаем логин');
    console.log('    Запусти с: P888_USER=xxx P888_PASS=yyy npx ts-node scripts/test-pinnacle888.ts');
    return false;
  }

  console.log(`\n[3] Авторизация (${username})...`);
  const client = makeClient();

  // Пробуем известные пути логина
  const loginPaths = [
    '/member-service/v2/member/login',
    '/member-service/v2/auth/login',
    '/member-service/v2/member/authentication',
    '/member-service/v1/member/login',
  ];

  for (const path of loginPaths) {
    try {
      const res = await client.post(
        path,
        { username, password, locale: LOCALE },
        {
          headers: {
            Cookie: cookieHeader(),
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );

      const isJson = (res.headers['content-type'] || '').includes('json');
      console.log(`    ${path} → ${res.status} ${isJson ? 'JSON' : 'HTML'}`);

      if (res.status < 400 && isJson) {
        saveCookies(res.headers['set-cookie']);
        console.log(`    ✓ Успешный логин через ${path}`);
        console.log(`    Данные: ${JSON.stringify(res.data).substring(0, 300)}`);
        console.log(`    Куки: ${Object.keys(sessionCookies).join(', ')}`);
        return true;
      }

      if (isJson && res.status >= 400) {
        console.log(`      ответ: ${JSON.stringify(res.data).substring(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`    ${path} → ошибка: ${e.message}`);
    }
  }

  console.log('    ✗ Ни один из путей не сработал — нужно найти точный login endpoint');
  return false;
}

// ─────────────────────────────────────────────────────────────
// Шаг 4: Odds polling
// ─────────────────────────────────────────────────────────────

async function fetchOdds(leagueCode?: string, eSportCode?: string): Promise<void> {
  console.log('\n[4] Получаем odds (все E Sports)...');
  const client = makeClient();
  const now = ts();

  const params = new URLSearchParams({
    sportId: String(SPORT_ESPORTS),
    isLive: 'false',
    isHlE: 'false',
    oddsType: '2',       // decimal / euro format
    version: '0',        // 0 = получить всё с нуля
    timeStamp: now,
    language: LOCALE,
    isHomePage: '',
    leagueCode: leagueCode ?? '',
    eventType: '0',
    eSportCode: eSportCode ?? '',
    periodNum: '0,8,39,3,4,5,6,7',
    participant: '',
    locale: LOCALE,
    _: now,
    withCredentials: 'true',
  });

  const res = await client.get(`/sports-service/sv/euro/odds?${params}`, {
    headers: { Cookie: cookieHeader() },
  });

  const data = res.data;
  console.log(`  version=${data.version}  leagues=${data.leagues?.length ?? 0}`);

  if (!data.leagues?.length) {
    console.log('  ⚠ Leagues пустые. Нужна авторизация или неверные параметры.');
    return;
  }

  printOdds(data.leagues);

  // ── Полный raw дамп первого события с максимумом маркетов ──
  const richEvent = data.leagues
    .flatMap((l: any) => (l.events ?? []).map((e: any) => ({ league: l, event: e })))
    .sort((a: any, b: any) => (b.event.moreBet ?? 0) - (a.event.moreBet ?? 0))[0];

  if (richEvent) {
    console.log('\n\n══════════════════════════════════════════════════');
    console.log('RAW ДАМП — событие с наибольшим moreBet:');
    console.log('══════════════════════════════════════════════════');
    console.log(JSON.stringify({ league: richEvent.league, event: richEvent.event }, null, 2));
  }
}

function printOdds(leagues: any[]): void {
  console.log(`\n  Коэффициенты (${leagues.length} лиг):`);
  for (const league of leagues) {
    console.log(`\n  [${league.gameCode?.toUpperCase() ?? 'SPORT'}] ${league.name} (id=${league.id})`);
    for (const ev of league.events ?? []) {
      const home = ev.participants?.find((p: any) => p.type === 'HOME')?.englishName ?? '?';
      const away = ev.participants?.find((p: any) => p.type === 'AWAY')?.englishName ?? '?';
      const live = ev.live ? ' [LIVE]' : '';
      console.log(`    ${home} vs ${away}${live}  (id=${ev.id})`);
      for (const [period, pdata] of Object.entries(ev.periods ?? {}) as [string, any][]) {
        const ml = pdata.moneyLine;
        if (ml && !ml.unavailable && !ml.offline) {
          const draw = ml.drawPrice ? `  draw=${ml.drawPrice}` : '';
          console.log(`      p${period} ML:  home=${ml.homePrice}  away=${ml.awayPrice}${draw}`);
        }
        const hcap = (pdata.handicap ?? []).filter((h: any) => !h.unavailable);
        for (const h of hcap.slice(0, 2)) {
          console.log(`      p${period} HC:  ${h.homeSpread} home=${h.homeOdds}  ${h.awaySpread} away=${h.awayOdds}`);
        }
        const ou = (pdata.overUnder ?? []).filter((o: any) => !o.unavailable);
        for (const o of ou.slice(0, 2)) {
          console.log(`      p${period} O/U ${o.points}:  over=${o.overOdds}  under=${o.underOdds}`);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Pinnacle888 API Test ===');
  console.log(`Base URL: ${BASE_URL}`);

  await getFingerprint();

  const cs2League = await fetchPublicData() as any;

  const loggedIn = await login();
  if (loggedIn) console.log('\n  Авторизованы — пробуем odds с сессией...');

  // Все esports
  await fetchOdds();

  // CS2 отдельно (для проверки фильтрации)
  if (cs2League) {
    console.log('\n--- CS2 отдельно ---');
    await fetchOdds(cs2League.leagueCode, cs2League.gameCode);
  }

  console.log('\n=== Готово ===');
}

main().catch((err) => {
  console.error('\nОшибка:', err.response?.data ?? err.message);
  process.exit(1);
});
