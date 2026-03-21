import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import * as WebSocketLib from 'ws';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import {
  PinnacleLeague,
  PinnacleEvent,
  PinnaclePeriod,
} from './pinnacle.types';

// ── Constants ────────────────────────────────────────────────

const BASE_URL = 'https://www.gentleflame47.xyz';
const DEFAULT_CHROME_PATH = '/usr/bin/google-chrome';

/** Remove event from cache if not seen for this long */
const EVENT_TTL_MS = 2 * 60_000;
/** Keep-alive ping to prevent JSESSIONID expiry */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** How often to evict stale events */
const EVICT_INTERVAL_MS = 60_000;
/** Delay before attempting WS reconnect after close */
const WS_RECONNECT_DELAY_MS = 5_000;

/** Sports to track: sportId → sportKey (for regular sports) */
const REGULAR_SPORTS: Array<{ sportId: number; sportKey: string }> = [
  { sportId: 4,  sportKey: 'basketball' },
  { sportId: 33, sportKey: 'tennis' },
  { sportId: 19, sportKey: 'hockey' },
  { sportId: 3,  sportKey: 'baseball' },
];

/** Esports sportId — gameCode maps to sportKey */
const ESPORTS_SPORT_ID = 12;
const ESPORT_GAME_CODE_TO_SPORT_KEY: Record<string, string> = {
  'cs2':      'csgo',
  'dota-2':   'dota2',
  'valorant': 'valorant',
};

/** All sport IDs we connect to */
const ALL_SPORT_IDS = [...REGULAR_SPORTS.map((s) => s.sportId), ESPORTS_SPORT_ID];

/** Total FULL_ODDS messages expected before declaring ready (2 per sport) */
const EXPECTED_FULL_ODDS = ALL_SPORT_IDS.length * 2;

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Origin': BASE_URL,
};

// ── Adapter ──────────────────────────────────────────────────

@Injectable()
export class PinnacleAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PinnacleAdapter.name);

  /** HTTP client — used only for keep-alive calls */
  private readonly httpClient: AxiosInstance;

  // ── Callbacks (same interface as DexsportAdapter) ────────────
  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;

  /** Market IDs currently in matched pairs — used to filter debug logs */
  trackedMarketIds: Set<string> = new Set();

  // ── WS state ─────────────────────────────────────────────────
  /** sportId → active WebSocket instance */
  private wsConnections: Map<number, any> = new Map();

  /** Intercepted WS URL (contains auth token from Pinnacle session) */
  private wsUrl: string | null = null;

  /** dpJCA cookie value — included in every SUBSCRIBE body */
  private dpJCA: string = 'h1ft';

  /** Session cookie string — used for HTTP keep-alive calls */
  private sessionCookie: string | null = null;

  /** sportId:destination keys that have received FULL_ODDS in the current poll cycle */
  private cycleFullOddsReceived: Set<string> = new Set();

  /** Prevents firing onAllMarketsReady more than once (only first cycle) */
  private initialFetchFired = false;

  // ── Event cache state ─────────────────────────────────────────
  /** Stable in-memory event objects — updated in-place on each WS message */
  private readonly eventCache = new Map<string, DexSportsEvent>();

  /** Last time each event was seen (Unix ms) */
  private readonly eventLastSeen = new Map<string, number>();

  /**
   * league.id → sportKey
   * Populated from FULL_ODDS (which includes gameCode for esports).
   * Used for UPDATE_ODDS events where gameCode may be absent.
   */
  private readonly leagueSportKey = new Map<number, string>();

  // ── Timers ────────────────────────────────────────────────────
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor() {
    const proxyUrl = process.env.PINNACLE_PROXY_URL;
    const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    this.httpClient = axios.create({
      baseURL: BASE_URL,
      timeout: 10_000,
      headers: {
        'User-Agent': WS_HEADERS['User-Agent'],
        Accept: 'application/json, text/plain, */*',
      },
      ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.login();
    this.connectAll();
    this.startTimers();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.stopTimers();
    this.closeAll();
  }

  /** Returns stable event objects updated in-place — references stay fresh for matcher. */
  getEvents(): DexSportsEvent[] {
    return [...this.eventCache.values()];
  }

  /** No-op for WS push — we receive updates for all sports automatically. */
  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  /**
   * Clears all event/market caches. Called by the scheduler before a full rematch cycle.
   * After this, resetPhaseState() should be called to reconnect and trigger a fresh FULL_ODDS cycle.
   */
  clearCache(): void {
    this.logger.log('Pinnacle: clearing all event caches');
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.leagueSportKey.clear();
    this.cycleFullOddsReceived.clear();
    this.initialFetchFired = false;
  }

  /** Close existing WS connections and reconnect (after login() to get fresh URL). */
  resetPhaseState(): void {
    this.logger.log('Pinnacle: resetPhaseState — reconnecting WebSocket');
    this.closeAll();
    this.connectAll();
  }

  // ── Auth ─────────────────────────────────────────────────────

  /**
   * Launches headless Chrome, logs in to Pinnacle, and intercepts the WS URL via CDP.
   * Extracted dpJCA cookie and session cookies are stored for later use.
   */
  async login(): Promise<void> {
    const username = process.env.PINNACLE_USERNAME;
    const password = process.env.PINNACLE_PASSWORD;

    if (!username || !password) {
      this.logger.warn('Pinnacle: PINNACLE_USERNAME/PINNACLE_PASSWORD not set — cannot connect to WS');
      return;
    }

    const chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME_PATH;
    this.logger.log(`Pinnacle: launching headless Chrome (${chromePath})...`);
    let browser: Browser | null = null;

    try {
      const proxyUrl = process.env.PINNACLE_PROXY_URL;
      let proxyServer: string | undefined;
      let proxyUser: string | undefined;
      let proxyPass: string | undefined;

      if (proxyUrl) {
        const parsed = new URL(proxyUrl);
        proxyUser = parsed.username || undefined;
        proxyPass = parsed.password || undefined;
        // Chrome --proxy-server does not accept credentials in URL
        parsed.username = '';
        parsed.password = '';
        proxyServer = parsed.toString().replace(/\/$/, '');
      }

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
        ],
      });

      const page: Page = await browser.newPage();
      await page.setUserAgent(WS_HEADERS['User-Agent']);
      if (proxyUser && proxyPass) {
        await page.authenticate({ username: proxyUser, password: proxyPass });
      }

      // Intercept WebSocket URL via JS injection
      let wsUrl: string | null = null;
      await (page as any).evaluateOnNewDocument(`
        (() => {
          const OrigWS = window.WebSocket;
          window.WebSocket = function(url, protocols) {
            const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
            if (url.includes('sports-websocket')) {
              console.log('[WS_URL]' + url);
            }
            return ws;
          };
          window.WebSocket.prototype = OrigWS.prototype;
          window.WebSocket.CONNECTING = OrigWS.CONNECTING;
          window.WebSocket.OPEN = OrigWS.OPEN;
          window.WebSocket.CLOSING = OrigWS.CLOSING;
          window.WebSocket.CLOSED = OrigWS.CLOSED;
        })();
      `);

      page.on('console', (msg) => {
        const text = msg.text();
        if (text.startsWith('[WS_URL]')) {
          const url = text.slice(8);
          if (!wsUrl) { wsUrl = url; this.logger.log(`Pinnacle: WS URL intercepted (${url.slice(0, 80)}…)`); }
        }
      });

      this.logger.log('Pinnacle: navigating to sports page...');
      await page.goto(`${BASE_URL}/en/standard/home`, { waitUntil: 'networkidle2', timeout: 30_000 });

      // Fill and submit header login form
      const HEADER_USER = '#top-header input[name="username"]';
      const HEADER_PASS = '#top-header input[name="password"]';
      const HEADER_BTN  = '#top-header button[type="submit"]';

      await page.waitForSelector(HEADER_USER, { timeout: 10_000 });
      await page.click(HEADER_USER);
      await page.type(HEADER_USER, username, { delay: 50 });
      await page.click(HEADER_PASS);
      await page.type(HEADER_PASS, password, { delay: 50 });

      this.logger.log('Pinnacle: clicking header LOG IN...');
      await page.click(HEADER_BTN);

      // Wait for confirmation modal and click the green LOG IN button
      const MODAL_BTN = '#modal button[data-test-id="Button"]';
      await page.waitForSelector(MODAL_BTN, { timeout: 10_000 });
      await page.click(MODAL_BTN);
      this.logger.log('Pinnacle: modal confirmed — waiting for WS URL...');

      // Wait up to 20s for WS URL
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (wsUrl) break;
      }

      // Extract cookies for session + dpJCA
      const cookies = await page.cookies();
      const cookieMap = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
      this.dpJCA = cookieMap['dpJCA'] ?? 'h1ft';

      // Build cookie string for HTTP keep-alive calls
      this.sessionCookie = cookies
        .filter((c) => ['JSESSIONID', 'u', 'custid', 'dpJCA', 'lang'].includes(c.name))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

      if (this.sessionCookie) {
        this.httpClient.defaults.headers.common['Cookie'] = this.sessionCookie;
      }

      if (wsUrl) {
        this.wsUrl = wsUrl;
        this.logger.log(`Pinnacle: login complete, dpJCA=${this.dpJCA}`);
      } else {
        this.logger.error('Pinnacle: WS URL not intercepted — login may have failed');
      }
    } catch (err: any) {
      this.logger.error(`Pinnacle: login failed — ${err.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // ── WebSocket management ──────────────────────────────────────

  /** Open one WS connection per sport. */
  private connectAll(): void {
    if (!this.wsUrl) {
      this.logger.warn('Pinnacle: no WS URL available, skipping connectAll');
      return;
    }
    for (const sportId of ALL_SPORT_IDS) {
      this.connectSport(sportId);
    }
  }

  private connectSport(sportId: number): void {
    if (this.destroyed) return;
    if (!this.wsUrl) return;

    const sportLabel = this.sportLabel(sportId);
    this.logger.log(`Pinnacle: connecting WS for ${sportLabel} (sportId=${sportId})`);

    const proxyUrl = process.env.PINNACLE_PROXY_URL;
    const wsOptions: any = {
      headers: {
        ...WS_HEADERS,
        ...(this.sessionCookie ? { Cookie: this.sessionCookie } : {}),
      },
      ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    };

    const ws = new WebSocket(this.wsUrl, wsOptions);
    this.wsConnections.set(sportId, ws);

    ws.on('open', () => {
      this.sendSubscribesToWs(ws, sportId);
    });

    ws.on('message', (raw: any) => {
      try {
        this.handleMessage(JSON.parse(raw.toString()), sportId);
      } catch (e: any) {
        this.logger.warn(`Pinnacle: [${sportLabel}] parse error: ${e.message}`);
      }
    });

    ws.on('error', (err: any) => {
      this.logger.warn(`Pinnacle: [${sportLabel}] WS error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      // Only reconnect if this is still the active connection for this sport.
      // closeAll() removes the entry from the map BEFORE calling terminate(),
      // so intentional close will have a different (or no) entry here.
      if (this.wsConnections.get(sportId) !== ws) return;
      this.wsConnections.delete(sportId);
      this.logger.warn(`Pinnacle: [${sportLabel}] WS closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
      if (!this.destroyed) {
        setTimeout(() => this.connectSport(sportId), WS_RECONNECT_DELAY_MS);
      }
    });
  }

  closeAll(): void {
    for (const [sportId, ws] of this.wsConnections) {
      try { ws.terminate(); } catch {}
      this.wsConnections.delete(sportId);
    }
  }

  /** Send SUBSCRIBE messages for a given sportId to a specific WS instance. */
  private sendSubscribesToWs(ws: any, sportId: number): void {
    const sid = String(sportId);
    if (sportId === ESPORTS_SPORT_ID) {
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE', destination: 'HLE_EURO_ODDS',
        body: { dpJCA: this.dpJCA, sportId: sid, isHlE: true, isLive: false, isHomePage: true,
                oddsType: 2, version: 0, eventType: 0, locale: 'en_US', periodNum: '0,8,39,3,4,5,6,7' },
      }));
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE', destination: 'LIVE_EURO_ODDS',
        body: { dpJCA: this.dpJCA, sportId: sid, isHlE: false, isLive: true,
                oddsType: 2, version: 0, eventType: 0, locale: 'en_US', periodNum: '0,8,39,3,4,5,6,7' },
      }));
    } else {
      const body = { dpJCA: this.dpJCA, sportId: sid, oddsType: 2, version: 0, periodNum: 0, locale: 'en_US' };
      ws.send(JSON.stringify({ type: 'SUBSCRIBE', destination: 'MATCHUPS_EURO_ODDS', body }));
      ws.send(JSON.stringify({ type: 'SUBSCRIBE', destination: 'LIVE_EURO_ODDS', body }));
    }
  }


  // ── Message handling ──────────────────────────────────────────

  private handleMessage(msg: any, sportId: number): void {
    if (msg.type === 'PING') {
      const ws = this.wsConnections.get(sportId);
      if (ws?.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'PONG', destination: 'ALL' }));
      }
      return;
    }

    if (msg.type === 'FULL_ODDS') {
      const odds = msg.odds;
      const key = `${odds.sportId}:${msg.destination}`;

      if (!this.cycleFullOddsReceived.has(key)) {
        this.cycleFullOddsReceived.add(key);
        let changedEvents = 0;
        let totalEvents = 0;
        for (const league of odds.leagues ?? []) {
          this.cacheLeagueSportKey(league);
          for (const event of league.events ?? []) {
            // pruneStale=true only before initialFetchFired — currentMatches is still empty,
            // so splice cannot orphan any references yet.
            const changes = this.mergeEvent(event, league, false, !this.initialFetchFired);
            this.eventLastSeen.set(String(event.id), Date.now());
            totalEvents++;
            if (changes.length) changedEvents++;
          }
        }
        this.logger.log(
          `[Pinnacle WS] FULL_ODDS ${msg.destination} sportId=${odds.sportId} ` +
          `— ${totalEvents} events, ${changedEvents} changed ` +
          `(${this.cycleFullOddsReceived.size}/${EXPECTED_FULL_ODDS})`,
        );

        // All FULL_ODDS for this cycle received — fire callback, stay subscribed for UPDATE_ODDS
        if (this.cycleFullOddsReceived.size >= EXPECTED_FULL_ODDS) {
          this.logger.log(`[Pinnacle WS] Initial FULL_ODDS complete — ${this.eventCache.size} events in cache`);
          this.cycleFullOddsReceived.clear();
          if (!this.initialFetchFired) {
            this.initialFetchFired = true;
            this.onAllMarketsReady?.();
          }
          // Stay subscribed — subsequent price changes arrive via UPDATE_ODDS
        }
      }
      return;
    }

    if (msg.type === 'UPDATE_ODDS') {
      const odds = msg.odds;
      const changeLines: string[] = [];
      const now = Date.now();

      // When refreshAll=true Pinnacle sends a complete current state in odds.leagues.
      // odds.update may be empty or contain only lineId-only entries without prices.
      // Fall back to odds.leagues if odds.update is absent or empty.
      const isRefreshAll = !!odds.refreshAll;
      const leagues: any[] = (isRefreshAll || !odds.update?.length) ? (odds.leagues ?? []) : (odds.update ?? []);

      for (const league of leagues) {
        for (const event of league.events ?? []) {
          const changes = this.mergeEvent(event, league, isRefreshAll ? false : true);
          this.eventLastSeen.set(String(event.id), now);
          if (changes.length) {
            const name = this.eventCache.get(String(event.id))?.name ?? `event#${event.id}`;
            for (const c of changes) changeLines.push(`  ${name}: ${c}`);
          }
        }
      }

      if (changeLines.length) {
        this.logger.log(
          `[Pinnacle WS] UPDATE_ODDS ${msg.destination} sportId=${odds.sportId}\n` +
          changeLines.join('\n'),
        );
        if (this.initialFetchFired) this.onPriceUpdate?.();
      }
      return;
    }
  }

  // ── Merge ─────────────────────────────────────────────────────

  private mergeEvent(event: PinnacleEvent, league: PinnacleLeague, isPartial = false, pruneStale = false): string[] {
    const eventId = String(event.id);
    const sportKey = this.resolveSportKey(league);
    if (!sportKey) return [];

    const existing = this.eventCache.get(eventId);

    // ── Resolve participant names ─────────────────────────────
    // Extract from fresh participants first (FULL_ODDS always has them).
    // For UPDATE_ODDS (no participants), fall back to what's already cached.
    let homeName: string | null = null;
    let awayName: string | null = null;

    if (event.participants?.length) {
      const homeP = event.participants.find((p) => p.type === 'HOME');
      const awayP = event.participants.find((p) => p.type === 'AWAY');
      if (homeP?.englishName) homeName = this.cleanName(homeP.englishName);
      if (awayP?.englishName) awayName = this.cleanName(awayP.englishName);
    }

    if (existing && (!homeName || !awayName)) {
      // Fall back to the name already stored — avoids re-splitting on every UPDATE_ODDS
      const parts = existing.name.split(' vs ');
      if (!homeName && parts[0]) homeName = parts[0];
      if (!awayName && parts[1]) awayName = parts[1];
    }

    // For a brand-new event we must have both names to produce correct outcome labels.
    // Without them we'd store '?' in the market — reject instead and wait for FULL_ODDS.
    if (!existing && (!homeName || !awayName)) return [];

    const markets = this.buildMarkets(event, homeName, awayName);

    // Brand-new event: need participant names to create an entry.
    // We cache even with empty markets (all offline) so that when UPDATE_ODDS later
    // brings a market back online, mergeEvent can find the event and reuse stored names.
    // Without this, UPDATE_ODDS can never create a new event (no participants in partial msgs).
    if (!existing) {
      if (!homeName || !awayName) return [];
      this.eventCache.set(eventId, {
        eventId,
        name: `${homeName} vs ${awayName}`,
        sportKey,
        isLive: event.live,
        startTime: Math.floor(event.time / 1000),
        tournamentName: league.name,
        markets,
        updatedAt: Date.now(),
      });
      return markets.length > 0 ? [`new event, ${markets.length} markets`] : [];
    }

    // ── Update existing event ─────────────────────────────────────
    // NOTE: we must handle offline eviction BEFORE the early-return on empty markets,
    // because an UPDATE_ODDS that only contains offline:true markets will produce
    // markets=[] (addPeriodMarkets skips them), but we still need to evict from cache.

    const changes: string[] = [];

    // For UPDATE_ODDS: log offline markets but keep them in cache with last known prices.
    // Removing them here would orphan the reference held by currentMatches — same bug as
    // Cloudbet/Stake adapters. When the market comes back online it is updated in-place below.
    if (isPartial) {
      const offlineIds = this.collectOfflineMarketIds(event);
      for (const cached of existing.markets) {
        if (offlineIds.has(cached.marketId)) {
          changes.push(`[${cached.name}] offline (kept in cache)`);
        }
      }
    }

    // Nothing else to do if no new/updated market data arrived.
    if (!markets.length) return changes;

    // Update scalar fields in-place
    if (homeName && awayName) existing.name = `${homeName} vs ${awayName}`;
    existing.isLive = event.live;
    existing.startTime = Math.floor(event.time / 1000);
    existing.updatedAt = Date.now();

    // Update markets in-place so that references held by currentMatches stay valid.
    // Replacing existing.markets with a new array would leave matchedMarkets[].dexMarket
    // pointing at stale objects, freezing prices until the next full match cycle.
    const newById = new Map(markets.map((m) => [m.marketId, m]));

    for (const cached of existing.markets) {
      const updated = newById.get(cached.marketId);
      if (updated) {
        // Update outcomes in-place — match by name to avoid index-order issues.
        // This handles partial UPDATE_ODDS where only one price (e.g. awayPrice) is sent.
        for (let i = 0; i < cached.outcomes.length; i++) {
          const updatedOutcome = updated.outcomes.find((o) => o.name === cached.outcomes[i].name);
          if (!updatedOutcome) continue;
          const newPrice = updatedOutcome.price;
          if (isFinite(newPrice) && newPrice > 0 && cached.outcomes[i].price !== newPrice) {
            const arrow = newPrice > cached.outcomes[i].price ? '↑' : '↓';
            changes.push(
              `[${cached.name}] ${cached.outcomes[i].name}: ${cached.outcomes[i].price?.toFixed(3)} → ${newPrice.toFixed(3)} ${arrow}`,
            );
            cached.outcomes[i] = { ...cached.outcomes[i], price: newPrice };
          }
        }
        newById.delete(cached.marketId);
      }
    }

    // Add markets that came back online or are genuinely new.
    for (const newMarket of newById.values()) {
      existing.markets.push(newMarket);
      changes.push(`[${newMarket.name}] online`);
    }

    // Remove markets that disappeared — only during the initial FULL_ODDS sweep (pruneStale=true),
    // when currentMatches is guaranteed empty and splice cannot orphan any references.
    // After initialFetchFired, markets absent from FULL_ODDS are kept with last known prices;
    // the event-level eviction timer handles true stale cleanup.
    if (!isPartial && pruneStale) {
      const updatedIds = new Set(markets.map((m) => m.marketId));
      for (let i = existing.markets.length - 1; i >= 0; i--) {
        if (!updatedIds.has(existing.markets[i].marketId)) {
          existing.markets.splice(i, 1);
          changes.push('market removed');
        }
      }
    }

    return changes;
  }

  // ── Offline market detection ──────────────────────────────────

  /**
   * Returns market IDs from the event whose moneyLine is offline.
   * Used by partial (UPDATE_ODDS) merge to explicitly evict suspended markets from cache.
   */
  private collectOfflineMarketIds(event: PinnacleEvent): Set<string> {
    const ids = new Set<string>();
    for (const [periodStr, period] of Object.entries(event.periods ?? {})) {
      const periodNum = Number(periodStr);
      if ((period as PinnaclePeriod).moneyLine?.offline) {
        ids.add(`${event.id}_p${periodNum}_ml`);
      }
    }
    return ids;
  }

  // ── Market building ───────────────────────────────────────────

  /**
   * Strips Pinnacle betting-variant suffixes from participant names.
   * e.g. "Carlos Alcaraz (Sets)" → "Carlos Alcaraz"
   * Pinnacle creates sibling events with "(Sets)" / "(Games)" / "(Maps)" etc.
   * We need clean names for text matching against Polymarket.
   */
  private cleanName(name: string): string {
    return name.replace(/\s*\([^)]+\)\s*$/, '').trim();
  }

  private buildMarkets(
    event: PinnacleEvent,
    homeName: string | null,
    awayName: string | null,
  ): DexMarket[] {
    if (!homeName || !awayName) return [];

    const markets: DexMarket[] = [];
    for (const [periodStr, period] of Object.entries(event.periods)) {
      const periodNum = Number(periodStr);
      this.addPeriodMarkets(markets, event.id, periodNum, period, homeName, awayName);
    }
    return markets;
  }

  private addPeriodMarkets(
    markets: DexMarket[],
    eventId: number,
    period: number,
    data: PinnaclePeriod,
    home: string,
    away: string,
  ): void {
    // ── Money line ─────────────────────────────────────────────
    const ml = data.moneyLine;
    if (ml && !ml.unavailable && !ml.offline) {
      // UPDATE_ODDS can send partial prices (e.g. only awayPrice, homePrice absent → NaN).
      // Allow NaN prices through — mergeEvent will only update outcomes with valid new prices.
      // Skip only if BOTH prices are missing (lineId-only notification).
      const homePrice = parseFloat(ml.homePrice);
      const awayPrice = parseFloat(ml.awayPrice);
      const homeValid = isFinite(homePrice) && homePrice > 0;
      const awayValid = isFinite(awayPrice) && awayPrice > 0;
      if (!homeValid && !awayValid) return;

      const outcomes: DexOutcome[] = [
        { name: home, price: homePrice },
        { name: away, price: awayPrice },
      ];
      if (ml.drawPrice) {
        const drawPrice = parseFloat(ml.drawPrice);
        if (isFinite(drawPrice) && drawPrice > 0) {
          outcomes.push({ name: 'Draw', price: drawPrice });
        }
      }

      markets.push({
        marketId: `${eventId}_p${period}_ml`,
        name: period === 0 ? 'moneyline' : `child_moneyline_map${period}`,
        marketType: period === 0 ? 'moneyline' : 'child_moneyline',
        outcomes,
      });
    }
  }

  // ── League sport key caching ──────────────────────────────────

  /** Cache league.id → sportKey from FULL_ODDS (which always has gameCode). */
  private cacheLeagueSportKey(league: PinnacleLeague): void {
    if (this.leagueSportKey.has(league.id)) return;
    const key = this.resolveSportKey(league);
    if (key) this.leagueSportKey.set(league.id, key);
  }

  private resolveSportKey(league: PinnacleLeague): string | null {
    // Try cached value first (works for UPDATE_ODDS where gameCode may be absent)
    const cached = this.leagueSportKey.get(league.id);
    if (cached) return cached;

    if (league.sportId === ESPORTS_SPORT_ID) {
      return ESPORT_GAME_CODE_TO_SPORT_KEY[league.gameCode] ?? null;
    }
    return REGULAR_SPORTS.find((s) => s.sportId === league.sportId)?.sportKey ?? null;
  }

  private sportLabel(sportId: number): string {
    if (sportId === ESPORTS_SPORT_ID) return 'Esports';
    return REGULAR_SPORTS.find((s) => s.sportId === sportId)?.sportKey ?? String(sportId);
  }

  // ── Timers ────────────────────────────────────────────────────

  private startTimers(): void {
    this.keepAliveTimer = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
    this.evictTimer = setInterval(() => this.evictStale(), EVICT_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    if (this.evictTimer) { clearInterval(this.evictTimer); this.evictTimer = null; }
  }

  private async sendKeepAlive(): Promise<void> {
    if (!this.sessionCookie) return;
    try {
      await this.httpClient.get('/member-auth/v2/keep-alive');
    } catch {
      // Non-critical — WS will reconnect automatically on close
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
      }
    }
  }
}
