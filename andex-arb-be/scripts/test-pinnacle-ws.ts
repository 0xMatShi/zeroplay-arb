/**
 * Тест Pinnacle WebSocket — проверка структуры UPDATE_ODDS.
 *
 * Цель: выяснить, приходят ли обновления цен через `odds.update` или `odds.leagues`,
 * и корректно ли мы их обрабатываем в адаптере.
 *
 * Запуск: npx ts-node -r dotenv/config scripts/test-pinnacle-ws.ts
 */

import puppeteer from 'puppeteer-core';
import * as WebSocketLib from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

// ── Config ──────────────────────────────────────────────────────

const BASE_URL    = 'https://www.gentleflame47.xyz';
const SPORT_ID    = 12;   // basketball — менять на нужный
const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const USERNAME    = process.env.PINNACLE_USERNAME;
const PASSWORD    = process.env.PINNACLE_PASSWORD;

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
  'Origin': BASE_URL,
};

// ── Helpers ─────────────────────────────────────────────────────

/** Prettified one-liner view of a period's moneyLine */
function fmtMoneyLine(ml: any): string {
  if (!ml) return 'null';
  const parts: string[] = [];
  if (ml.offline)     parts.push('OFFLINE');
  if (ml.unavailable) parts.push('UNAVAILABLE');
  if (ml.homePrice)   parts.push(`home=${ml.homePrice}`);
  if (ml.awayPrice)   parts.push(`away=${ml.awayPrice}`);
  if (ml.drawPrice)   parts.push(`draw=${ml.drawPrice}`);
  if (ml.lineId)      parts.push(`lineId=${ml.lineId}`);
  return parts.join(' ') || JSON.stringify(ml);
}

/** Print the period structure of an event */
function printEventPeriods(event: any, prefix = ''): void {
  if (!event.periods) { console.log(`${prefix}  [no periods]`); return; }
  for (const [pNum, pData] of Object.entries(event.periods as Record<string, any>)) {
    const pKeys = Object.keys(pData).join(', ');
    console.log(`${prefix}  period[${pNum}] keys=[${pKeys}]`);
    if (pData.moneyLine) console.log(`${prefix}    moneyLine: ${fmtMoneyLine(pData.moneyLine)}`);
  }
}

// ── Odds cache for delta tracking ───────────────────────────────

const priceCache = new Map<string, Map<string, number>>();  // eventId → outcomeKey → price

function updateCache(eventId: string | number, periodNum: string | number, side: string, price: string | number): void {
  const key = `${eventId}_p${periodNum}`;
  if (!priceCache.has(key)) priceCache.set(key, new Map());
  const oldPrice = priceCache.get(key)!.get(side) ?? null;
  const newPrice = typeof price === 'string' ? parseFloat(price) : price;
  if (!isFinite(newPrice) || newPrice <= 0) return;
  if (oldPrice !== null && Math.abs(oldPrice - newPrice) > 0.001) {
    const arrow = newPrice > oldPrice ? '↑' : '↓';
    console.log(`  [ΔPRICE] event=${eventId} p${periodNum} ${side}: ${oldPrice.toFixed(3)} → ${newPrice.toFixed(3)} ${arrow}`);
  }
  priceCache.get(key)!.set(side, newPrice);
}

// ── Login via Puppeteer ─────────────────────────────────────────

interface LoginResult {
  wsUrl: string;
  dpJCA: string;
  sessionCookie: string;
  proxyUrl: string | null;
  /** First SUBSCRIBE frames sent by the browser's own WS — for comparison */
  browserFrames: string[];
  closeBrowser: () => Promise<void>;
}

async function login(): Promise<LoginResult> {
  if (!USERNAME || !PASSWORD) throw new Error('PINNACLE_USERNAME / PINNACLE_PASSWORD not set in .env');

  const proxyUrl = process.env.PINNACLE_PROXY_URL;
  let proxyServer: string | undefined;
  let proxyUser: string | undefined;
  let proxyPass: string | undefined;
  if (proxyUrl) {
    const parsed = new URL(proxyUrl);
    proxyUser = parsed.username || undefined;
    proxyPass = parsed.password || undefined;
    parsed.username = '';
    parsed.password = '';
    proxyServer = parsed.toString().replace(/\/$/, '');
    console.log(`[login] Using proxy: ${proxyServer}`);
  }

  console.log(`[login] Launching Chrome (${CHROME_PATH})...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--disable-gpu',
      ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(WS_HEADERS['User-Agent']);
  if (proxyUser && proxyPass) {
    await page.authenticate({ username: proxyUser, password: proxyPass });
  }

  let wsUrl: string | null = null;
  const browserFrames: string[] = [];

  // Intercept WS URL via JS injection — return a FAKE WS object so the browser
  // never actually connects with the token. This keeps the token fresh for our Node.js WS.
  // If the browser opens a real WS, closing it kills the server-side session → Node.js gets nothing.
  await (page as any).evaluateOnNewDocument(`
    (() => {
      const OrigWS = window.WebSocket;
      window.WebSocket = function(url, protocols) {
        if (url.includes('sports-websocket')) {
          console.log('[WS_URL]' + url);
          const fake = Object.create(OrigWS.prototype);
          fake.url = url; fake.readyState = 0;
          fake.send = function() {}; fake.close = function() { fake.readyState = 3; };
          fake.addEventListener = function() {}; fake.removeEventListener = function() {};
          fake.dispatchEvent = function() { return true; };
          return fake;
        }
        return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      };
      window.WebSocket.prototype = OrigWS.prototype;
      window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1;
      window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
    })();
  `);

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[WS_URL]') && !wsUrl) {
      wsUrl = text.slice(8);
      console.log(`[login] WS URL intercepted: ${wsUrl.slice(0, 80)}…`);
    }
  });

  console.log('[login] Navigating to sports page...');
  await page.goto(`${BASE_URL}/en/standard/home`, { waitUntil: 'networkidle2', timeout: 30_000 });

  await page.waitForSelector('#top-header input[name="username"]', { timeout: 10_000 });
  await page.type('#top-header input[name="username"]', USERNAME, { delay: 50 });
  await page.type('#top-header input[name="password"]', PASSWORD, { delay: 50 });
  await page.click('#top-header button[type="submit"]');

  // Screenshot before modal click to verify page state
  await page.screenshot({ path: 'scripts/debug-before-modal.png' });
  console.log('[login] Screenshot saved: scripts/debug-before-modal.png');

  await page.waitForSelector('#modal button[data-test-id="Button"]', { timeout: 10_000 });
  await page.click('#modal button[data-test-id="Button"]');
  console.log('[login] Modal confirmed — waiting for WS URL + browser frames...');

  // Wait for WS URL, then a bit more to capture SUBSCRIBE frames
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (wsUrl && browserFrames.length >= 2) break;
  }
  // Extra 2s to capture remaining frames + cookie settlement
  await new Promise((r) => setTimeout(r, 3_000));

  // Screenshot after login to verify state
  await page.screenshot({ path: 'scripts/debug-after-login.png' });
  console.log('[login] Screenshot saved: scripts/debug-after-login.png');

  const cookies = await page.cookies();
  const cookieMap = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

  // Log ALL cookies
  console.log('[login] ALL cookies:');
  for (const c of cookies) {
    console.log(`  ${c.name}=${c.value.slice(0, 60)}`);
  }

  const dpJCA = cookieMap['dpJCA'] ?? 'h1ft';
  // Send ALL cookies — Pinnacle may require more than just JSESSIONID/custid/u
  const sessionCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  console.log(`[login] dpJCA=${dpJCA}`);
  console.log(`[login] Full cookie header length: ${sessionCookie.length} chars`);
  console.log(`[login] Browser sent ${browserFrames.length} SUBSCRIBE frame(s):`);
  for (const f of browserFrames) {
    try { console.log('  ' + JSON.stringify(JSON.parse(f), null, 2)); }
    catch { console.log('  (raw) ' + f.slice(0, 300)); }
  }

  if (!wsUrl) throw new Error('WS URL not intercepted — login failed');

  return {
    wsUrl,
    dpJCA,
    sessionCookie,
    proxyUrl: proxyUrl ?? null,
    browserFrames,
    closeBrowser: () => browser.close().catch(() => {}),
  };
}

// ── WebSocket test ───────────────────────────────────────────────

async function runTest(wsUrl: string, dpJCA: string, sessionCookie: string, proxyUrl: string | null, _browserFrames: string[]): Promise<void> {
  const sid = String(SPORT_ID);
  let msgCount = 0, updateCount = 0;
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: { ...WS_HEADERS, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    });

    ws.on('open', () => {
      console.log(`[ws] Connected — subscribing to LIVE_EURO_ODDS sportId=${SPORT_ID}\n`);
      // Use updated format matching what the browser actually sends
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE', destination: 'HLE_EURO_ODDS',
        body: { dpJCA, sportId: sid, isHlE: true, isLive: false,
                oddsType: 2, version: 0, eventType: 0, locale: 'en_US', periodNum: '0,8,39,3,4,5,6,7' },
      }));
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE', destination: 'LIVE_EURO_ODDS',
        body: { dpJCA, sportId: sid, isHlE: false, isLive: true,
                oddsType: 2, version: 0, eventType: 0, locale: 'en_US', periodNum: '0,8,39,3,4,5,6,7' },
      }));
    });

    ws.on('message', (raw: any) => {
      msgCount++;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'PING') { ws.send(JSON.stringify({ type: 'PONG', destination: 'ALL' })); return; }

      if (msg.type === 'FULL_ODDS') {
        const odds = msg.odds;
        const totalEvents = (odds.leagues ?? []).reduce((s: number, l: any) => s + (l.events?.length ?? 0), 0);
        console.log(`[FULL_ODDS] dest=${msg.destination} sportId=${odds.sportId} leagues=${(odds.leagues ?? []).length} events=${totalEvents}`);
        // Seed price cache from FULL_ODDS
        for (const league of odds.leagues ?? []) {
          for (const event of league.events ?? []) {
            for (const [pNum, pData] of Object.entries(event.periods as Record<string, any>)) {
              const ml = pData?.moneyLine;
              if (!ml || ml.offline || ml.unavailable) continue;
              if (ml.homePrice) updateCache(event.id, pNum, 'home', ml.homePrice);
              if (ml.awayPrice) updateCache(event.id, pNum, 'away', ml.awayPrice);
              if (ml.drawPrice) updateCache(event.id, pNum, 'draw', ml.drawPrice);
            }
          }
        }
        return;
      }

      if (msg.type === 'UPDATE_ODDS') {
        updateCount++;
        const odds = msg.odds;

        // ── KEY CHECK: what top-level keys does `odds` have? ──
        const oddsKeys = Object.keys(odds ?? {});
        const hasUpdate  = Array.isArray(odds?.update)  && odds.update.length  > 0;
        const hasLeagues = Array.isArray(odds?.leagues) && odds.leagues.length > 0;

        console.log(`\n[UPDATE_ODDS #${updateCount}] dest=${msg.destination} sportId=${odds?.sportId}`);
        console.log(`  odds keys: [${oddsKeys.join(', ')}]  hasUpdate=${hasUpdate}  hasLeagues=${hasLeagues}`);

        // Process whichever field is present
        const leagues: any[] = odds?.update ?? odds?.leagues ?? [];
        if (!leagues.length) {
          console.log('  [!] No leagues/update data found — message dropped!');
          return;
        }

        for (const league of leagues) {
          const leagueKeys = Object.keys(league ?? {});
          for (const event of league.events ?? []) {
            const eventKeys = Object.keys(event ?? {});
            const participants = (event.participants ?? []).map((p: any) => `${p.type}=${p.englishName}`).join(', ');

            console.log(`  [league] id=${league.id} "${league.name ?? '?'}" keys=[${leagueKeys.join(',')}]`);
            console.log(`    event id=${event.id} live=${event.live} keys=[${eventKeys.join(',')}]`);
            if (participants) console.log(`    participants: ${participants}`);
            printEventPeriods(event, '   ');

            // Track price changes
            for (const [pNum, pData] of Object.entries(event.periods as Record<string, any> ?? {})) {
              const ml = (pData as any)?.moneyLine;
              if (!ml || ml.offline || ml.unavailable) continue;
              if (ml.homePrice) updateCache(event.id, pNum, 'home', ml.homePrice);
              if (ml.awayPrice) updateCache(event.id, pNum, 'away', ml.awayPrice);
              if (ml.drawPrice) updateCache(event.id, pNum, 'draw', ml.drawPrice);
            }
          }
        }
        return;
      }

      // Any other message type
      console.log(`[msg #${msgCount}] type=${msg.type} keys=[${Object.keys(msg).join(', ')}]`);
    });

    ws.on('error', (err: any) => { console.error('[ws] error:', err.message); });
    ws.on('close', (code: number) => {
      console.log(`\n[ws] closed code=${code}  msgs=${msgCount}  updates=${updateCount}`);
      resolve();
    });

    // Run for 3 minutes then close
    setTimeout(() => { console.log('\n[timeout] closing'); ws.close(); }, 3 * 60_000);
    process.on('SIGINT', () => ws.close());
  });
}

// ── Entry point ──────────────────────────────────────────────────

(async () => {
  try {
    const { wsUrl, dpJCA, sessionCookie, proxyUrl, browserFrames, closeBrowser } = await login();
    await closeBrowser();
    console.log('[main] Browser closed — connecting Node.js WS...');
    try {
      await runTest(wsUrl, dpJCA, sessionCookie, proxyUrl, browserFrames);
    } finally {
      // nothing
    }
  } catch (err: any) {
    console.error('[fatal]', err.message);
    process.exit(1);
  }
})();
