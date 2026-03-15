import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
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

const BASE_URL = 'https://www.pinnacle888.com';
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

/** WS destinations — one for live events, one for pre-match */
const DESTINATIONS = [
  { dest: 'LIVE_EURO_ODDS',     isLive: true  },
  { dest: 'MATCHUPS_EURO_ODDS', isLive: false },
];

/** Total FULL_ODDS messages expected before declaring ready */
const EXPECTED_FULL_ODDS = ALL_SPORT_IDS.length * DESTINATIONS.length;

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
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

  /** sportId:destination keys that have received FULL_ODDS */
  private fullOddsReceived: Set<string> = new Set();

  /** Prevents firing onAllMarketsReady more than once per init cycle */
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
    this.httpClient = axios.create({
      baseURL: BASE_URL,
      timeout: 10_000,
      headers: {
        'User-Agent': WS_HEADERS['User-Agent'],
        Accept: 'application/json, text/plain, */*',
      },
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
    this.fullOddsReceived.clear();
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
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      const page: Page = await browser.newPage();
      await page.setUserAgent(WS_HEADERS['User-Agent']);

      // Intercept WebSocket URL via CDP
      let wsUrl: string | null = null;
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketCreated', (params: any) => {
        if (params.url.includes('sports-websocket') && !wsUrl) {
          wsUrl = params.url;
          this.logger.log(`Pinnacle: WS URL intercepted (${params.url.slice(0, 80)}…)`);
        }
      });

      this.logger.log('Pinnacle: navigating to sports page...');
      await page.goto(`${BASE_URL}/en/standard/sports`, { waitUntil: 'networkidle2', timeout: 30_000 });

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

    const ws = new WebSocket(this.wsUrl, { headers: WS_HEADERS });
    this.wsConnections.set(sportId, ws);

    ws.on('open', () => {
      this.logger.log(`Pinnacle: [${sportLabel}] WS open — subscribing`);
      for (const { dest, isLive } of DESTINATIONS) {
        ws.send(JSON.stringify({
          type: 'SUBSCRIBE',
          destination: dest,
          body: {
            dpJCA: this.dpJCA,
            sportId:   String(sportId),
            isHlE:     false,
            isLive,
            oddsType:  2,
            version:   0,
            eventType: 0,
            locale:    'en_US',
            periodNum: '0,8,39,3,4,5,6,7',
          },
        }));
      }
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

  private closeAll(): void {
    for (const [sportId, ws] of this.wsConnections) {
      try { ws.terminate(); } catch {}
      this.wsConnections.delete(sportId);
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

      let mergedEvents = 0;
      for (const league of odds.leagues ?? []) {
        this.cacheLeagueSportKey(league);
        for (const event of league.events ?? []) {
          const changed = this.mergeEvent(event, league);
          this.eventLastSeen.set(String(event.id), Date.now());
          if (changed) mergedEvents++;
        }
      }

      if (!this.fullOddsReceived.has(key)) {
        this.fullOddsReceived.add(key);
        const totalEvents = (odds.leagues ?? []).reduce(
          (s: number, l: any) => s + (l.events?.length ?? 0), 0,
        );
        this.logger.log(
          `[Pinnacle WS] FULL_ODDS ${msg.destination} sportId=${odds.sportId} ` +
          `— ${totalEvents} events, ${mergedEvents} cached ` +
          `(${this.fullOddsReceived.size}/${EXPECTED_FULL_ODDS})`,
        );
      }

      // Fire onAllMarketsReady once all FULL_ODDS have arrived
      if (!this.initialFetchFired && this.fullOddsReceived.size >= EXPECTED_FULL_ODDS) {
        this.initialFetchFired = true;
        this.logger.log(`[Pinnacle WS] All FULL_ODDS received — ${this.eventCache.size} events in cache`);
        this.onAllMarketsReady?.();
      } else if (mergedEvents > 0 && this.initialFetchFired) {
        this.onPriceUpdate?.();
      }
      return;
    }

    if (msg.type === 'UPDATE_ODDS') {
      const odds = msg.odds;
      let changedEvents = 0;
      const now = Date.now();

      for (const league of odds.update ?? []) {
        for (const event of league.events ?? []) {
          const changed = this.mergeEvent(event, league, true);
          this.eventLastSeen.set(String(event.id), now);
          if (changed) changedEvents++;
        }
      }

      if (changedEvents > 0) {
        this.logger.log(
          `[Pinnacle WS] UPDATE_ODDS ${msg.destination} sportId=${odds.sportId} ` +
          `— ${changedEvents} events changed`,
        );
        if (this.initialFetchFired) this.onPriceUpdate?.();
      }
      return;
    }
  }

  // ── Merge ─────────────────────────────────────────────────────

  private mergeEvent(event: PinnacleEvent, league: PinnacleLeague, isPartial = false): boolean {
    const eventId = String(event.id);
    const sportKey = this.resolveSportKey(league);
    if (!sportKey) return false;

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
    if (!existing && (!homeName || !awayName)) return false;

    const markets = this.buildMarkets(event, homeName, awayName);
    if (!markets.length) return false;

    if (!existing) {
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
      return true;
    }

    // Update scalar fields in-place
    if (homeName && awayName) existing.name = `${homeName} vs ${awayName}`;
    existing.isLive = event.live;
    existing.startTime = Math.floor(event.time / 1000);
    existing.updatedAt = Date.now();

    // Update markets in-place so that references held by currentMatches stay valid.
    // Replacing existing.markets with a new array would leave matchedMarkets[].dexMarket
    // pointing at stale objects, freezing prices until the next full match cycle.
    let anyPriceChange = false;
    const newById = new Map(markets.map((m) => [m.marketId, m]));

    for (const cached of existing.markets) {
      const updated = newById.get(cached.marketId);
      if (updated) {
        // Update outcomes individually — only replace prices that are valid in the new data.
        // This handles partial UPDATE_ODDS where only one price (e.g. awayPrice) is sent.
        for (let i = 0; i < cached.outcomes.length && i < updated.outcomes.length; i++) {
          const newPrice = updated.outcomes[i].price;
          if (isFinite(newPrice) && newPrice > 0 && cached.outcomes[i].price !== newPrice) {
            cached.outcomes[i] = { ...cached.outcomes[i], price: newPrice };
            anyPriceChange = true;
          }
        }
        newById.delete(cached.marketId);
      }
    }

    // Add markets that are new
    for (const newMarket of newById.values()) {
      existing.markets.push(newMarket);
      anyPriceChange = true;
    }

    // Remove markets that disappeared — only for FULL_ODDS (complete snapshot).
    // UPDATE_ODDS only includes changed markets; absent markets are unchanged, not removed.
    if (!isPartial) {
      const updatedIds = new Set(markets.map((m) => m.marketId));
      for (let i = existing.markets.length - 1; i >= 0; i--) {
        if (!updatedIds.has(existing.markets[i].marketId)) {
          existing.markets.splice(i, 1);
          anyPriceChange = true;
        }
      }
    }

    return anyPriceChange;
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
