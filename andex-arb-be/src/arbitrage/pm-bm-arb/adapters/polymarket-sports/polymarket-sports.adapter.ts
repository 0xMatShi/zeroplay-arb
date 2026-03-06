import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as Ws from 'ws';
import { PolymarketSportsEvent } from '../../interfaces/sports-arb.types';
import { PolymarketSportsMarketRaw } from './polymarket-sports.types';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS   = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const BASE_URL  = 'https://polymarket.com';

/** How often to re-fetch the market list from REST (10 min) */
const FETCH_INTERVAL_MS = 10 * 60_000;
const WS_RECONNECT_DELAY_MS = 5_000;
const WS_PING_INTERVAL_MS   = 15_000;

/**
 * Exact seriesSlug → sport mapping, discovered from live Polymarket data.
 * Primary lookup — most reliable signal.
 */
const SERIES_SPORT: Record<string, string> = {
  // ── Esports ──────────────────────────────────────────────
  'counter-strike':               'csgo',
  'league-of-legends':            'lol',
  'dota-2':                       'dota2',
  'valorant':                     'valorant',
  'call-of-duty':                 'call-of-duty',
  'honor-of-kings':               'honor-of-kings',
  'starcraft-2':                  'starcraft2',
  // ── MMA / Combat ─────────────────────────────────────────
  'ufc':                          'mma',
  'zuffa':                        'boxing',
  'power-slap':                   'other',
  // ── Basketball ───────────────────────────────────────────
  'ncaa-cbb':                     'basketball',
  'cwbb':                         'basketball',
  'nba-2026':                     'basketball',
  'euroleague-basketball':        'basketball',
  'pro-a':                        'basketball',
  'liga-endesa':                  'basketball',
  'lnb':                          'basketball',
  'basketball-champions-league':  'basketball',
  'basketball-series-a':          'basketball',
  'kbl':                          'basketball',
  'nbl':                          'basketball',
  'wll':                          'basketball',
  // ── Ice Hockey ───────────────────────────────────────────
  'nhl-2026':                     'hockey',
  'ahl-2026':                     'hockey',
  'khl-2026':                     'hockey',
  'shl-2026':                     'hockey',
  'dehl-2026':                    'hockey',
  'snhl-2026':                    'hockey',
  // ── Baseball ─────────────────────────────────────────────
  'mlb':                          'baseball',
  'world-baseball-classic':       'baseball',
  // ── Tennis ───────────────────────────────────────────────
  'atp':                          'tennis',
  'wta':                          'tennis',
  // ── Cricket ──────────────────────────────────────────────
  'international-cricket':        'cricket',
  'pakistan-t20':                 'cricket',
  'sheffield-shield':             'cricket',
  'plunket-shield':               'cricket',
  'csa-t20':                      'cricket',
  'womens-national-cricket-league': 'cricket',
  'hong-kong-t20-premier-league-women': 'cricket',
  'cricket-bangladesh':           'cricket',
  // ── Rugby ────────────────────────────────────────────────
  'super-rugby-pacific':          'rugby',
  'united-rugby-championship':    'rugby',
  'rugby-top-14':                 'rugby',
  'rugby-premiership':            'rugby',
  'rugby-six-nations':            'rugby',
  // ── Football (Soccer) ────────────────────────────────────
  'japan-j2-league':              'football',
  'japan-j-league':               'football',
  'primera-a':                    'football',
  'primera-divisin-argentina':    'football',
  'primera-division':             'football',
  'fifa-friendly':                'football',
  'efl-championship':             'football',
  'efl-cup':                      'football',
  'fa-cup':                       'football',
  'premier-league-2025':          'football',
  'mls-2025':                     'football',
  'brazil-serie-a':               'football',
  'lib-2025':                     'football',
  'serie-b':                      'football',
  'serie-a-2025':                 'football',
  'mex-2025':                     'football',
  'ere-2025':                     'football',
  'tur-2025':                     'football',
  'primeira-liga':                'football',
  'russian-premier-league':       'football',
  'k-league':                     'football',
  'chinese-super-league':         'football',
  'la-liga-2':                    'football',
  'la-liga-2025':                 'football',
  'saudi-professional-league':    'football',
  'ligue-1-2025':                 'football',
  'ligue-2':                      'football',
  'liga-1':                       'football',
  'bundesliga-2025':              'football',
  'bundesliga-2':                 'football',
  'ucl-2025':                     'football',
  'uel-2025':                     'football',
  'europa-conference-league':     'football',
  'womens-champions-league':      'football',
  'norway-eliteserien':           'football',
  'ukraine-premier-liha':         'football',
  'czechia-1':                    'football',
  'morocco-1':                    'football',
  'egypt-1':                      'football',
  'indian-super-league':          'football',
  'a-league-soccer':              'football',
  'scottish-premiership':         'football',
  'romania-1':                    'football',
  // ── American Football ────────────────────────────────────
  'ncaa-fb':                      'american-football',
  'nfl':                          'american-football',
  // ── Lacrosse ─────────────────────────────────────────────
  'pll':                          'lacrosse',
};

/**
 * Fallback regex for question text when seriesSlug is absent or unknown.
 */
const SPORT_MAP: Array<[RegExp, string]> = [
  [/counter.?strike|cs2|cs:go/i,        'csgo'],
  [/league of legends|\blol\b/i,        'lol'],
  [/dota.?2/i,                          'dota2'],
  [/valorant/i,                         'valorant'],
  [/rainbow.?six|r6/i,                  'rainbow6'],
  [/call of duty|\bcod\b/i,             'call-of-duty'],
  [/overwatch/i,                        'overwatch'],
  [/rocket league/i,                    'rocket-league'],
  [/\bsoccer\b/i,                       'football'],
  [/\bbasketball\b|\bnba\b/i,           'basketball'],
  [/\btennis\b/i,                       'tennis'],
  [/\bhockey\b|\bnhl\b/i,               'hockey'],
  [/\bbaseball\b|\bmlb\b/i,             'baseball'],
  [/\bcricket\b/i,                      'cricket'],
  [/\bvolleyball\b/i,                   'volleyball'],
  [/\bhandball\b/i,                     'handball'],
  [/\bmma\b|\bufc\b/i,                  'mma'],
  [/\bboxing\b/i,                       'boxing'],
];

function detectSport(question: string, tags: string[], seriesSlug?: string): string {
  // 1. Exact seriesSlug lookup — most reliable
  if (seriesSlug && seriesSlug in SERIES_SPORT) {
    return SERIES_SPORT[seriesSlug];
  }
  // 2. Fall back to question + tag text
  const haystack = [question, ...tags].join(' ');
  for (const [re, slug] of SPORT_MAP) {
    if (re.test(haystack)) return slug;
  }
  return 'other';
}

/**
 * Fetches Polymarket sports moneyline markets and keeps their prices
 * up to date via the CLOB WebSocket.
 *
 * Exposes: getEvents() → PolymarketSportsEvent[]
 */
@Injectable()
export class PolymarketSportsAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolymarketSportsAdapter.name);

  /** conditionId → event */
  private readonly cache = new Map<string, PolymarketSportsEvent>();
  /** tokenId → conditionId (for WS price updates) */
  private readonly tokenToCondition = new Map<string, string>();

  private ws: Ws.WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  onModuleInit(): void {
    this.fetchAndConnect();
    this.fetchTimer = setInterval(() => this.fetchAndConnect(), FETCH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.fetchTimer)    clearInterval(this.fetchTimer);
    if (this.pingTimer)     clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }

  getEvents(): PolymarketSportsEvent[] {
    return [...this.cache.values()];
  }

  // ── Fetch ────────────────────────────────────────────────────

  private async fetchAndConnect(): Promise<void> {
    await this.fetchMarkets();
    this.connectWs();
  }

  private async fetchMarkets(): Promise<void> {
    const PAGE = 500;
    let offset = 0;
    let fetched = 0;

    try {
      while (true) {
        const { data } = await axios.get<PolymarketSportsMarketRaw[]>(`${GAMMA_API}/markets`, {
          params: {
            active: true,
            closed: false,
            sportsMarketType: 'moneyline',
            limit: PAGE,
            offset,
          },
          timeout: 30_000,
        });

        const markets: any[] = Array.isArray(data) ? data : [];
        if (markets.length === 0) break;

        for (const m of markets) {
          this.upsertMarket(m);
        }

        fetched += markets.length;
        if (markets.length < PAGE) break;
        offset += PAGE;
      }

      this.logger.log(`PolymarketSports: fetched ${fetched} sports markets, cache=${this.cache.size}`);
    } catch (err: any) {
      this.logger.error(`PolymarketSports fetch failed: ${err.message}`);
    }
  }

  private upsertMarket(m: PolymarketSportsMarketRaw): void {
    try {
      // API doesn't filter server-side — skip non-moneyline markets
      if (m.sportsMarketType !== 'moneyline') return;

      const outcomeNames: string[] = this.safeParse(m.outcomes, []);
      const outcomePricesRaw: string[] = this.safeParse(m.outcomePrices, []);
      const tokenIds: string[] = this.safeParse(m.clobTokenIds, []);

      if (outcomeNames.length < 2 || tokenIds.length < 2) return;

      // Team names = outcomes for moneyline markets
      const teamA = outcomeNames[0];
      const teamB = outcomeNames[outcomeNames.length - 1];

      // Determine sport: seriesSlug > question text > tags
      const tags: string[] = (m.tags ?? []).map((t) => t?.slug ?? t?.label ?? '');
      const seriesSlug = m.events?.[0]?.seriesSlug;
      const sport = detectSport(m.question ?? '', tags, seriesSlug);

      const outcomePrices = outcomePricesRaw.map((p) => parseFloat(p) || 0);

      const existing = this.cache.get(m.conditionId);
      const event: PolymarketSportsEvent = {
        conditionId: m.conditionId,
        slug: m.slug ?? '',
        question: m.question ?? '',
        sport,
        teamA,
        teamB,
        tokenIds,
        outcomeNames,
        outcomePrices: existing?.outcomePrices ?? outcomePrices, // keep WS prices if fresher
        isLive: m.live ?? m.events?.[0]?.live ?? false,
        url: `${BASE_URL}/event/${m.events?.[0]?.slug ?? m.slug}`,
        updatedAt: Date.now(),
      };

      this.cache.set(m.conditionId, event);

      // Register token→condition mapping
      for (const tid of tokenIds) {
        this.tokenToCondition.set(tid, m.conditionId);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to upsert market ${m.conditionId}: ${err.message}`);
    }
  }

  // ── CLOB WebSocket ───────────────────────────────────────────

  private connectWs(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === Ws.WebSocket.OPEN) {
      // Already open — just re-subscribe with current token IDs
      this.subscribeAll();
      return;
    }

    this.ws?.terminate();
    const ws = new Ws.WebSocket(CLOB_WS, {
      headers: { Origin: 'https://polymarket.com' },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('PolymarketSports CLOB WS connected');
      this.subscribeAll();

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === Ws.WebSocket.OPEN) ws.ping();
      }, WS_PING_INTERVAL_MS);
    });

    ws.on('message', (raw: Ws.RawData) => {
      try {
        this.handleWsMessage(raw.toString());
      } catch { /* ignore */ }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(`PolymarketSports WS error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.logger.warn(`PolymarketSports WS closed (${code}), reconnecting...`);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connectWs(), WS_RECONNECT_DELAY_MS);
      }
    });
  }

  private subscribeAll(): void {
    const tokenIds = [...this.tokenToCondition.keys()];
    if (tokenIds.length === 0) return;

    // CLOB WS subscription — batch in chunks of 200 to avoid oversized frames
    const CHUNK = 200;
    for (let i = 0; i < tokenIds.length; i += CHUNK) {
      const chunk = tokenIds.slice(i, i + CHUNK);
      this.ws?.send(JSON.stringify({ auth: {}, assets_ids: chunk, type: 'market' }));
    }
    this.logger.log(`PolymarketSports WS: subscribed to ${tokenIds.length} tokens`);
  }

  private handleWsMessage(str: string): void {
    const parsed = JSON.parse(str);
    const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const msg of items) {
      if (msg.event_type !== 'book') continue;

      const tokenId: string = msg.asset_id ?? '';
      const conditionId = this.tokenToCondition.get(tokenId);
      if (!conditionId) continue;

      const event = this.cache.get(conditionId);
      if (!event) continue;

      const tokenIndex = event.tokenIds.indexOf(tokenId);
      if (tokenIndex === -1) continue;

      const bids: any[] = [...(msg.bids ?? [])].sort(
        (a, b) => parseFloat(b.price) - parseFloat(a.price),
      );
      const asks: any[] = [...(msg.asks ?? [])].sort(
        (a, b) => parseFloat(a.price) - parseFloat(b.price),
      );

      const bestBid = bids[0];
      const bestAsk = asks[0];
      if (!bestBid && !bestAsk) continue;

      const midPrice =
        bestBid && bestAsk
          ? (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2
          : parseFloat(bestAsk?.price ?? bestBid?.price ?? '0');

      if (midPrice > 0) {
        event.outcomePrices[tokenIndex] = midPrice;
        event.updatedAt = Date.now();
      }
    }
  }

  private safeParse<T>(value: string | undefined, fallback: T): T {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }
}
