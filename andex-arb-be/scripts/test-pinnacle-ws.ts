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
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

// ── Config ──────────────────────────────────────────────────────

const BASE_URL    = 'https://www.gentleflame47.xyz';
const SPORT_ID    = 4;   // basketball — менять на нужный
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

async function login(): Promise<{ wsUrl: string; dpJCA: string }> {
  if (!USERNAME || !PASSWORD) throw new Error('PINNACLE_USERNAME / PINNACLE_PASSWORD not set in .env');

  console.log(`[login] Launching Chrome (${CHROME_PATH})...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
           '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(WS_HEADERS['User-Agent']);

    let wsUrl: string | null = null;
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', (params: any) => {
      if (params.url.includes('sports-websocket') && !wsUrl) {
        wsUrl = params.url;
        console.log(`[login] WS URL intercepted: ${params.url.slice(0, 80)}…`);
      }
    });

    console.log('[login] Navigating to sports page...');
    await page.goto(`${BASE_URL}/en/standard/sports`, { waitUntil: 'networkidle2', timeout: 30_000 });

    await page.waitForSelector('#top-header input[name="username"]', { timeout: 10_000 });
    await page.type('#top-header input[name="username"]', USERNAME, { delay: 50 });
    await page.type('#top-header input[name="password"]', PASSWORD, { delay: 50 });
    await page.click('#top-header button[type="submit"]');

    await page.waitForSelector('#modal button[data-test-id="Button"]', { timeout: 10_000 });
    await page.click('#modal button[data-test-id="Button"]');
    console.log('[login] Modal confirmed — waiting for WS URL...');

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (wsUrl) break;
    }

    const cookies = await page.cookies();
    const dpJCA = Object.fromEntries(cookies.map((c) => [c.name, c.value]))['dpJCA'] ?? 'h1ft';

    if (!wsUrl) throw new Error('WS URL not intercepted — login failed');
    return { wsUrl, dpJCA };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── WebSocket test ───────────────────────────────────────────────

async function runTest(wsUrl: string, dpJCA: string): Promise<void> {
  const sid = String(SPORT_ID);
  let msgCount = 0, updateCount = 0;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: WS_HEADERS });

    ws.on('open', () => {
      console.log(`[ws] Connected — subscribing to LIVE_EURO_ODDS sportId=${SPORT_ID}\n`);
      // Subscribe to both live and pre-match (same as adapter does for regular sports)
      const body = { dpJCA, sportId: sid, oddsType: 2, version: 0, periodNum: 0, locale: 'en_US' };
      ws.send(JSON.stringify({ type: 'SUBSCRIBE', destination: 'MATCHUPS_EURO_ODDS', body }));
      ws.send(JSON.stringify({ type: 'SUBSCRIBE', destination: 'LIVE_EURO_ODDS', body }));
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
    const { wsUrl, dpJCA } = await login();
    await runTest(wsUrl, dpJCA);
  } catch (err: any) {
    console.error('[fatal]', err.message);
    process.exit(1);
  }
})();
