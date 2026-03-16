import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import * as WebSocketLib from 'ws';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import { StakeFixture, StakeWsMarket, StakeWsOutcome } from './stake.types';

// ── Constants ────────────────────────────────────────────────

const GRAPHQL_URL = 'https://stake3017.com/_api/graphql';
const WS_URL      = 'wss://stake3017.com/_api/websockets';

/** FlareSolverr HTTP API endpoint. Override with FLARESOLVERR_URL env var. */
const DEFAULT_FLARESOLVERR_URL = 'http://localhost:8191';

/**
 * Static token from JS bundle /_app/immutable/chunks/XVztU-V4.js:
 *   const h = "s5MNWtjTM5TvCMkAzxov"
 * Override with STAKE_LOCKDOWN_TOKEN env var when the site redeploys.
 */
const FALLBACK_LOCKDOWN_TOKEN = 's5MNWtjTM5TvCMkAzxov';

/**
 * Betradar template extIds that represent a main match H2H / winner market.
 *
 *   "186" = Head-to-Head (Betradar) — tennis, baseball, all esports via Betradar
 *   "52"  = Home/Away Winner       — NBA basketball
 *   "406" = Winner Incl. OT        — NHL hockey
 *
 * IMPORTANT: extId alone is NOT sufficient — we also require specifiers === ""
 * (non-empty specifiers mean the same template is parameterised for a sub-market,
 * e.g. extId "186" with specifiers "period=1" = "who wins first period", not moneyline).
 */
const MONEYLINE_EXT_IDS = new Set(['52', '186', '219', '406']);

/**
 * Human-readable market name patterns for the moneyline (winner) market.
 * Used as a structural fallback for:
 *   - Oddin-based sports (Valorant uses Oddin feed — different extId system)
 *   - Any future sport with an extId not yet in MONEYLINE_EXT_IDS
 */
const MONEYLINE_NAME_RE = /^(match winner|winner|h2h|head.to.head|winner \(incl\. overtime\)|winner \(including overtime\))$/i;

/** Keepalive ping interval (server disconnects after ~30s without pong) */
const PING_INTERVAL_MS = 20_000;

/** How long to wait after connection_ack before firing onAllMarketsReady.
 *  Stake delivers the initial full odds snapshot ~18s after each subscription. */
const INITIAL_STATE_WAIT_MS = 28_000;

/** Remove event from cache if not updated within this window */
const EVENT_TTL_MS = 5 * 60_000;

/** Evict stale events on this interval */
const EVICT_INTERVAL_MS = 60_000;

const WS_RECONNECT_DELAY_MS = 5_000;

// ── Sport configuration ───────────────────────────────────────

interface StakeSportConfig {
  /** Canonical sport key used by the pipeline */
  sportKey: string;
  /** Stake URL slug */
  stakeSlug: string;
  /** True if the sport appears in the top-10 sportList query */
  inSportList: boolean;
  /** Additional tournaments to fetch via slugTournament (for sports outside top-10) */
  extraTournaments?: Array<{ sport: string; category: string; tournament: string }>;
  /** Use free-text search instead of slugTournament */
  useTextSearch?: boolean;
}

const TARGET_SPORTS: StakeSportConfig[] = [
  {
    sportKey: 'basketball',
    stakeSlug: 'basketball',
    inSportList: false,
    extraTournaments: [
      { sport: 'basketball', category: 'usa', tournament: 'nba' },
      { sport: 'basketball', category: 'europe', tournament: 'euroleague' },
      { sport: 'basketball', category: 'europe', tournament: 'eurocup' },
      { sport: 'basketball', category: 'usa', tournament: 'ncaa' },
    ],
  },
  { sportKey: 'tennis',   stakeSlug: 'tennis',            inSportList: true },
  {
    sportKey: 'hockey',
    stakeSlug: 'ice-hockey',
    inSportList: false,
    extraTournaments: [
      { sport: 'ice-hockey', category: 'usa', tournament: 'nhl' },
      { sport: 'ice-hockey', category: 'russia', tournament: 'khl' },
      { sport: 'ice-hockey', category: 'sweden', tournament: 'shl' },
    ],
  },
  { sportKey: 'baseball', stakeSlug: 'baseball',          inSportList: true },
  { sportKey: 'csgo',     stakeSlug: 'counter-strike',    inSportList: true },
  { sportKey: 'dota2',    stakeSlug: 'dota-2',            inSportList: true },
  { sportKey: 'lol',      stakeSlug: 'league-of-legends', inSportList: true },
  { sportKey: 'valorant', stakeSlug: 'valorant',          inSportList: false, useTextSearch: true },
];

// Slug → canonical sportKey for resolving from sportList (top-10)
const STAKE_SLUG_TO_SPORT = new Map<string, string>(
  TARGET_SPORTS.map((s) => [s.stakeSlug, s.sportKey]),
);

// ── HTTP headers ───────────────────────────────────────────────

const HTTP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://stake3017.com',
  'Referer': 'https://stake3017.com/sports',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-dest': 'empty',
};

// ── Adapter ───────────────────────────────────────────────────

@Injectable()
export class StakeAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StakeAdapter.name);

  // ── Callbacks (same contract as Dexsport/Pinnacle) ────────────
  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;

  /** Market IDs currently in matched pairs — used to filter debug logs */
  trackedMarketIds: Set<string> = new Set();

  // ── CF credentials (from FlareSolverr) ────────────────────────
  private cfCookieHeader = '';
  private cfUserAgent    = '';

  // ── Fixture cache (from HTTP) ──────────────────────────────────
  private readonly fixtureCache = new Map<string, StakeFixture>();

  // ── Event cache (stable objects, updated in-place) ────────────
  private readonly eventCache    = new Map<string, DexSportsEvent>();
  private readonly eventLastSeen = new Map<string, number>();

  // ── WS state ───────────────────────────────────────────────────
  private ws: any = null;
  private subIdCounter = 0;
  /** graphql-transport-ws subscription ID → fixtureId */
  private readonly subToFixture = new Map<string, string>();
  /** Fixtures that have received at least one WS message (initial state) */
  private readonly fixtureInitialReceived = new Set<string>();

  // ── Ready state ────────────────────────────────────────────────
  private initialStateFired = false;
  private initialStateTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Timers ─────────────────────────────────────────────────────
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  // ── NestJS lifecycle ──────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.login();
    await this.fetchAllFixtures();
    await this.fetchInitialOddsForAllFixtures();
    this.connectWs();
    this.startTimers();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.stopTimers();
    this.terminateWs();
  }

  // ── Public API (contract shared with Dexsport/Pinnacle) ───────

  getEvents(): DexSportsEvent[] {
    return [...this.eventCache.values()];
  }

  /** Stake pushes all fixtures automatically — no per-market subscription needed. */
  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  /**
   * Clear all caches and restart from scratch (called by scheduler before rematch cycle).
   * Re-fetches fixtures from HTTP and reconnects WebSocket.
   */
  clearCache(): void {
    this.logger.log('Stake: clearing all caches, refetching fixtures and reconnecting WS');
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.fixtureCache.clear();
    this.subToFixture.clear();
    this.fixtureInitialReceived.clear();
    this.initialStateFired = false;
    if (this.initialStateTimer) { clearTimeout(this.initialStateTimer); this.initialStateTimer = null; }
    this.terminateWs();
    // Async chain: fetch fixtures → prefetch odds → reconnect WS
    this.fetchAllFixtures()
      .then(() => this.fetchInitialOddsForAllFixtures())
      .then(() => { if (!this.destroyed) this.connectWs(); })
      .catch((e) => this.logger.error(`Stake: clearCache refetch failed — ${e.message}`));
  }

  /**
   * Reconnect WS without re-fetching fixtures (called after login() for a fresh CF cookie).
   */
  resetPhaseState(): void {
    this.logger.log('Stake: resetPhaseState — reconnecting WebSocket');
    this.subToFixture.clear();
    this.fixtureInitialReceived.clear();
    this.initialStateFired = false;
    if (this.initialStateTimer) { clearTimeout(this.initialStateTimer); this.initialStateTimer = null; }
    this.terminateWs();
    if (!this.destroyed) this.connectWs();
  }

  closeAll(): void {
    this.terminateWs();
  }

  // ── Cloudflare bypass via FlareSolverr ────────────────────────

  /**
   * Calls FlareSolverr (Docker-based CF bypass proxy) to obtain cf_clearance cookies
   * and a compatible User-Agent. Must be called before any HTTP/WS requests.
   *
   * Setup: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
   * Override endpoint with FLARESOLVERR_URL env var.
   */
  async login(): Promise<void> {
    const solverrUrl = process.env.FLARESOLVERR_URL ?? DEFAULT_FLARESOLVERR_URL;
    this.logger.log(`Stake: calling FlareSolverr at ${solverrUrl} to bypass Cloudflare...`);

    try {
      const res = await axios.post(
        `${solverrUrl}/v1`,
        {
          cmd: 'request.get',
          url: 'https://stake3017.com/sports',
          maxTimeout: 60_000,
        },
        { timeout: 70_000 },
      );

      const solution = res.data?.solution;
      if (!solution) {
        throw new Error(`FlareSolverr returned no solution: ${JSON.stringify(res.data)}`);
      }

      const cookies: Array<{ name: string; value: string }> = solution.cookies ?? [];
      const cfClearance = cookies.find((c) => c.name === 'cf_clearance');
      if (!cfClearance) {
        throw new Error('FlareSolverr did not return cf_clearance cookie');
      }

      this.cfCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      this.cfUserAgent    = solution.userAgent ?? HTTP_HEADERS['User-Agent'];
      this.logger.log(
        `Stake: CF cookies obtained via FlareSolverr (${cookies.length} cookies, cf_clearance present)`,
      );
    } catch (err: any) {
      this.logger.error(`Stake: FlareSolverr login failed — ${err.message}`);
    }
  }

  // ── Fixture discovery ─────────────────────────────────────────

  /**
   * Fetches fixtures for all target sports via HTTP GraphQL.
   * Populates fixtureCache with current live + prematch fixtures.
   */
  private async fetchAllFixtures(): Promise<void> {
    this.logger.log('Stake: fetching fixtures via HTTP GraphQL...');
    const fixtures: StakeFixture[] = [];

    // ── sportList: in-top-10 sports ────────────────────────────
    const inListSlugs = TARGET_SPORTS.filter((s) => s.inSportList).map((s) => s.stakeSlug);
    if (inListSlugs.length > 0) {
      try {
        const result = await this.gql(`
          {
            sportList {
              slug name
              tournamentList {
                id name slug
                category { slug }
                fixtureList(limit: 50) {
                  id name slug status startTime provider extId
                }
              }
            }
          }
        `);
        for (const sport of result.data?.sportList ?? []) {
          const sportKey = STAKE_SLUG_TO_SPORT.get(sport.slug);
          if (!sportKey) continue;
          for (const tournament of sport.tournamentList ?? []) {
            for (const fix of tournament.fixtureList ?? []) {
              fixtures.push(this.buildFixture(fix, sportKey, tournament.name, {
                sportSlug: sport.slug,
                categorySlug: tournament.category?.slug ?? '',
                tournamentSlug: tournament.slug ?? '',
              }));
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`Stake: sportList fetch failed — ${e.message}`);
      }
    }

    // ── slugTournament: sports outside top-10 (basketball, hockey) ──
    const extraConfigs = TARGET_SPORTS.filter((s) => s.extraTournaments?.length);
    if (extraConfigs.length > 0) {
      const aliases = extraConfigs.flatMap((s) =>
        (s.extraTournaments ?? []).map((t, i) => ({
          alias: `t${s.sportKey.replace(/[^a-z]/g, '')}_${i}`,
          sport: t.sport,
          category: t.category,
          tournament: t.tournament,
          sportKey: s.sportKey,
        })),
      );

      // Build batched query: one alias per tournament
      const queryParts = aliases
        .map(
          (a) => `
        ${a.alias}: slugTournament(sport:"${a.sport}", category:"${a.category}", tournament:"${a.tournament}") {
          id name slug
          fixtureList(limit: 30) {
            id name slug status startTime provider extId
          }
        }`,
        )
        .join('\n');

      try {
        const result = await this.gql(`{ ${queryParts} }`);
        for (const a of aliases) {
          const tournament = result.data?.[a.alias];
          if (!tournament) continue;
          for (const fix of tournament.fixtureList ?? []) {
            fixtures.push(this.buildFixture(fix, a.sportKey, tournament.name, {
              sportSlug: a.sport,
              categorySlug: a.category,
              tournamentSlug: a.tournament,
            }));
          }
        }
      } catch (e: any) {
        this.logger.warn(`Stake: slugTournament batch fetch failed — ${e.message}`);
      }
    }

    // ── sportFixtureQuery: text search for valorant ─────────────
    const searchConfigs = TARGET_SPORTS.filter((s) => s.useTextSearch);
    for (const cfg of searchConfigs) {
      try {
        const result = await this.gql(`
          {
            results: sportFixtureQuery(query: "${cfg.stakeSlug}") {
              fixture {
                ... on SportFixture {
                  id name slug status startTime provider extId
                  tournament { name slug category { slug } }
                }
              }
            }
          }
        `);
        for (const item of result.data?.results ?? []) {
          const fix = item.fixture;
          if (!fix) continue;
          fixtures.push(this.buildFixture(fix, cfg.sportKey, fix.tournament?.name ?? '', {
            sportSlug: cfg.stakeSlug,
            categorySlug: fix.tournament?.category?.slug ?? '',
            tournamentSlug: fix.tournament?.slug ?? '',
          }));
        }
      } catch (e: any) {
        this.logger.warn(`Stake: text search for ${cfg.stakeSlug} failed — ${e.message}`);
      }
    }

    // Deduplicate by fixtureId (sportList and slugTournament can overlap)
    this.fixtureCache.clear();
    for (const f of fixtures) {
      if (!this.fixtureCache.has(f.id)) this.fixtureCache.set(f.id, f);
    }

    // Count by sport for logs
    const bySport = new Map<string, number>();
    for (const f of this.fixtureCache.values()) {
      bySport.set(f.sportKey, (bySport.get(f.sportKey) ?? 0) + 1);
    }
    const summary = [...bySport.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
    this.logger.log(`Stake: fetched ${this.fixtureCache.size} fixtures (${summary})`);
  }

  /**
   * HTTP prefetch of current odds for all known fixtures via batched slugFixture queries.
   * Populates eventCache immediately so the first match cycle has data to work with,
   * without waiting for WS to deliver the initial snapshot (which can take 20–30s).
   *
   * Batches fixtures in groups of ODDS_BATCH_SIZE to avoid oversized GraphQL queries.
   */
  private async fetchInitialOddsForAllFixtures(): Promise<void> {
    const BATCH_SIZE = 20;
    const fixtures = [...this.fixtureCache.values()];
    if (fixtures.length === 0) return;

    this.logger.log(`Stake: prefetching HTTP odds for ${fixtures.length} fixtures (batches of ${BATCH_SIZE})...`);
    let populated = 0;

    for (let i = 0; i < fixtures.length; i += BATCH_SIZE) {
      const batch = fixtures.slice(i, i + BATCH_SIZE);

      // Build a single aliased GraphQL query for the whole batch
      const queryParts = batch.map((f, idx) => `
        f${idx}: slugFixture(fixture: "${f.slug}") {
          markets: groups(groups: ["main"]) {
            templates(includeEmpty: false) {
              markets {
                id name status extId specifiers
                outcomes { id name odds active }
              }
            }
          }
        }
      `).join('\n');

      try {
        const result = await this.gql(`{ ${queryParts} }`);
        for (let idx = 0; idx < batch.length; idx++) {
          const fixture = batch[idx];
          const raw = result.data?.[`f${idx}`];
          if (!raw) continue;

          // Flatten groups → templates → markets
          const wsMarkets: StakeWsMarket[] = [];
          for (const group of raw.markets ?? []) {
            for (const tmpl of group.templates ?? []) {
              for (const mkt of tmpl.markets ?? []) {
                wsMarkets.push(mkt);
              }
            }
          }
          if (wsMarkets.length === 0) continue;

          this.mergeFixtureMarkets(fixture, wsMarkets, /* isSnapshot */ true);
          if (this.eventCache.has(fixture.id)) populated++;
        }
      } catch (e: any) {
        this.logger.warn(`Stake: HTTP odds prefetch batch ${i / BATCH_SIZE + 1} failed — ${e.message}`);
      }
    }

    this.logger.log(`Stake: HTTP odds prefetch complete — ${populated}/${fixtures.length} events populated`);
  }

  private buildFixture(
    raw: any,
    sportKey: string,
    tournamentName: string,
    slugs: { sportSlug: string; categorySlug: string; tournamentSlug: string } = { sportSlug: '', categorySlug: '', tournamentSlug: '' },
  ): StakeFixture {
    // startTime is an ISO string or epoch ms — normalize to Unix ms
    let startTime = 0;
    if (raw.startTime) {
      const parsed = typeof raw.startTime === 'number' ? raw.startTime : Date.parse(raw.startTime);
      startTime = isNaN(parsed) ? 0 : parsed;
    }
    return {
      id: String(raw.id),
      name: raw.name ?? '',
      slug: raw.slug ?? '',
      status: raw.status ?? 'prematch',
      startTime,
      provider: raw.provider ?? '',
      extId: raw.extId ?? '',
      sportKey,
      tournamentName,
      sportSlug: slugs.sportSlug,
      categorySlug: slugs.categorySlug,
      tournamentSlug: slugs.tournamentSlug,
    };
  }

  // ── WebSocket ─────────────────────────────────────────────────

  private connectWs(): void {
    if (this.destroyed) return;

    this.logger.log(`Stake: connecting to ${WS_URL}...`);

    const ws = new WebSocket(WS_URL, ['graphql-transport-ws'], {
      headers: {
        'Origin': 'https://stake3017.com',
        'User-Agent': this.cfUserAgent || HTTP_HEADERS['User-Agent'],
        ...(this.cfCookieHeader ? { Cookie: this.cfCookieHeader } : {}),
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('Stake: WS open — sending connection_init');
      const lockdownToken = process.env.STAKE_LOCKDOWN_TOKEN ?? FALLBACK_LOCKDOWN_TOKEN;
      ws.send(JSON.stringify({
        type: 'connection_init',
        payload: { language: 'en', lockdownToken },
      }));
    });

    ws.on('message', (raw: any) => {
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch (e: any) {
        this.logger.warn(`Stake: WS parse error — ${e.message}`);
      }
    });

    ws.on('error', (err: any) => {
      this.logger.warn(`Stake: WS error — ${err.message}`);
    });

    ws.on('close', (code: number) => {
      if (this.ws !== ws) return; // Stale connection (already replaced)
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.initialStateTimer) { clearTimeout(this.initialStateTimer); this.initialStateTimer = null; }
      this.logger.warn(`Stake: WS closed (code=${code}), reconnecting in ${WS_RECONNECT_DELAY_MS}ms`);
      if (!this.destroyed) {
        setTimeout(() => this.connectWs(), WS_RECONNECT_DELAY_MS);
      }
    });
  }

  private handleMessage(msg: any): void {
    // ── Server ping → client pong ─────────────────────────────
    if (msg.type === 'ping') {
      this.ws?.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── connection_ack → subscribe all fixtures ────────────────
    if (msg.type === 'connection_ack') {
      this.logger.log(
        `Stake: connection_ack — subscribing to ${this.fixtureCache.size} fixtures` +
        ` (initial state expected in ~${INITIAL_STATE_WAIT_MS / 1000}s)`,
      );
      this.subscribeAll();

      // Schedule ready signal — fires after initial state window
      if (this.initialStateTimer) clearTimeout(this.initialStateTimer);
      this.initialStateTimer = setTimeout(() => {
        this.initialStateTimer = null;
        if (!this.initialStateFired) {
          this.initialStateFired = true;
          this.logger.log(
            `Stake: initial state window elapsed — ${this.fixtureInitialReceived.size}/` +
            `${this.fixtureCache.size} fixtures received data; ` +
            `${this.eventCache.size} events in cache`,
          );
          this.onAllMarketsReady?.();
        }
      }, INITIAL_STATE_WAIT_MS);
      return;
    }

    // ── Subscription data (market odds) ───────────────────────
    if (msg.type === 'next' && msg.id) {
      const fixtureId = this.subToFixture.get(msg.id);
      if (!fixtureId) return;

      const markets: StakeWsMarket[] | undefined = msg.payload?.data?.sportFixtureMarketsNext;
      if (!markets?.length) return;

      const fixture = this.fixtureCache.get(fixtureId);
      if (!fixture) return;

      const isFirstMessage = !this.fixtureInitialReceived.has(fixtureId);
      if (isFirstMessage) this.fixtureInitialReceived.add(fixtureId);

      this.mergeFixtureMarkets(fixture, markets, isFirstMessage);
      return;
    }

    // ── Subscription error ─────────────────────────────────────
    if (msg.type === 'error' && msg.id) {
      const fixtureId = this.subToFixture.get(msg.id);
      this.logger.warn(
        `Stake: subscription error for fixture=${fixtureId ?? msg.id} — ` +
        JSON.stringify(msg.payload?.errors?.[0]?.message ?? msg.payload),
      );
      return;
    }

    // ── Subscription complete (fixture ended) ──────────────────
    if (msg.type === 'complete' && msg.id) {
      const fixtureId = this.subToFixture.get(msg.id);
      if (fixtureId) {
        this.subToFixture.delete(msg.id);
        this.logger.log(`Stake: subscription complete for fixture=${fixtureId}`);
      }
    }
  }

  private subscribeAll(): void {
    // Start keepalive ping
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === 1 /* OPEN */) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);

    // Subscribe per fixture
    for (const fixture of this.fixtureCache.values()) {
      const id = String(++this.subIdCounter);
      this.subToFixture.set(id, fixture.id);
      this.ws?.send(JSON.stringify({
        type: 'subscribe',
        id,
        payload: {
          query: `subscription {
            sportFixtureMarketsNext(fixtureId: "${fixture.id}") {
              id name status extId specifiers
              outcomes { id name odds active }
            }
          }`,
        },
      }));
    }
  }

  // ── Market merge ──────────────────────────────────────────────

  /**
   * Update or create the stable DexSportsEvent for this fixture.
   * First message is a complete snapshot; subsequent messages are partial updates.
   */
  private mergeFixtureMarkets(
    fixture: StakeFixture,
    wsMarkets: StakeWsMarket[],
    isSnapshot: boolean,
  ): void {
    const now = Date.now();
    this.eventLastSeen.set(fixture.id, now);

    // Categorize and filter WS markets into DexMarket objects
    const newMarkets = wsMarkets
      .filter((m) => m.status !== 'suspended' && m.outcomes?.length > 0)
      .map((m) => this.categorizeMarket(m, fixture.sportKey))
      .filter((m): m is DexMarket => m !== null);

    const existing = this.eventCache.get(fixture.id);

    if (!existing) {
      // First time we see this fixture — create the event object
      if (newMarkets.length === 0) return; // No usable markets yet

      const url = this.buildFixtureUrl(fixture);
      this.eventCache.set(fixture.id, {
        eventId: fixture.id,
        name: fixture.name,
        sportKey: fixture.sportKey,
        isLive: fixture.status === 'live',
        startTime: fixture.startTime > 0 ? Math.floor(fixture.startTime / 1000) : undefined,
        tournamentName: fixture.tournamentName || undefined,
        url: url || undefined,
        markets: newMarkets,
        updatedAt: now,
      });
      return;
    }

    // ── Update existing event in-place ────────────────────────
    existing.isLive  = fixture.status === 'live';
    existing.updatedAt = now;

    const newById = new Map(newMarkets.map((m) => [m.marketId, m]));
    const changes: string[] = [];

    for (const cached of existing.markets) {
      const updated = newById.get(cached.marketId);
      if (!updated) continue;

      // Update outcomes in-place — only overwrite prices that are valid in the incoming data
      for (let i = 0; i < cached.outcomes.length && i < updated.outcomes.length; i++) {
        const newPrice = updated.outcomes[i].price;
        if (isFinite(newPrice) && newPrice > 1) {
          if (cached.outcomes[i].price !== newPrice) {
            if (this.trackedMarketIds.has(cached.marketId)) {
              const arrow = newPrice > cached.outcomes[i].price ? '↑' : '↓';
              changes.push(
                `[${cached.name}] ${cached.outcomes[i].name}: ` +
                `${cached.outcomes[i].price?.toFixed(3)} → ${newPrice.toFixed(3)} ${arrow}`,
              );
            }
            cached.outcomes[i] = { ...cached.outcomes[i], price: newPrice };
          }
        }
      }
      newById.delete(cached.marketId);
    }

    // Add markets that are new (came online or not seen before)
    for (const m of newById.values()) {
      existing.markets.push(m);
    }

    // On full snapshot: remove markets that are no longer present
    if (isSnapshot) {
      const updatedIds = new Set(newMarkets.map((m) => m.marketId));
      for (let i = existing.markets.length - 1; i >= 0; i--) {
        if (!updatedIds.has(existing.markets[i].marketId)) {
          existing.markets.splice(i, 1);
        }
      }
    }

    if (changes.length > 0) {
      this.logger.log(
        `[Stake WS] ${existing.name}:\n` + changes.map((c) => `  ${c}`).join('\n'),
      );
      if (this.initialStateFired) this.onPriceUpdate?.();
    }
  }

  // ── Market categorization ─────────────────────────────────────

  /**
   * Maps a raw WS market to a DexMarket, or returns null if not useful for arbitrage.
   *
   * We expose only:
   *   - moneyline     (main match winner, whole-match, 2 outcomes)
   *   - child_moneyline (esports: winner of Map N, specifiers="map=N")
   *
   * Two-layer detection:
   *   1. extId path  — Betradar template ID reliably identifies market type.
   *                    Requires specifiers === "" to exclude parameterised variants
   *                    (e.g. extId "186" + specifiers "period=1" = "1st period winner").
   *   2. Structural fallback — for Oddin-based sports (Valorant) whose extIds differ
   *                    from Betradar. Checks name + outcome shape.
   */
  private categorizeMarket(m: StakeWsMarket, _sportKey: string): DexMarket | null {
    const extId   = m.extId ?? '';
    const specs   = m.specifiers ?? '';
    const name    = m.name ?? '';
    const outcomes = this.buildOutcomes(m.outcomes);

    if (outcomes.length < 2) return null;

    // ── Layer 1: Betradar extId path ───────────────────────────

    if (MONEYLINE_EXT_IDS.has(extId)) {
      // extId "186" with specifiers "map=1" → esports Map 1 winner (child_moneyline)
      const mapMatch = specs.match(/^map=(\d+)$/i);
      if (mapMatch) {
        return {
          marketId: m.id,
          marketType: 'child_moneyline',
          name: `child_moneyline_map${mapMatch[1]}`,
          outcomes,
        };
      }

      // Require truly empty specifiers for the main moneyline.
      // Non-empty but non-map specifiers (e.g. "period=1", "hcp=0.0") mean it is
      // a derivative market that happens to share the same template — skip it.
      if (specs !== '') return null;

      return { marketId: m.id, marketType: 'moneyline', name: 'moneyline', outcomes };
    }

    // ── Layer 2: Structural fallback (Oddin / unknown extIds) ──
    //
    // Conditions for a main-match moneyline:
    //   - No specifiers (it is the whole-match market, not period/map/set)
    //   - Exactly 2 outcomes (2-way winner, no draw)
    //   - Market name matches known winner-market patterns
    //   - Outcome names are plain team names (no "Over"/"Under", no ±numbers)
    if (
      specs === '' &&
      outcomes.length === 2 &&
      MONEYLINE_NAME_RE.test(name.trim()) &&
      outcomes.every((o) => !/over|under|yes|no|draw|[+-][\d.]/.test(o.name.toLowerCase()))
    ) {
      return { marketId: m.id, marketType: 'moneyline', name: 'moneyline', outcomes };
    }

    return null;
  }

  /**
   * Builds a direct URL to the fixture on stake3017.com.
   * Pattern: /en/sports/{sportSlug}/{categorySlug}/{tournamentSlug}/{slug}
   *
   * fixture.slug from the GraphQL API already includes the numeric prefix,
   * e.g. "46229503-new-york-knicks-golden-state-warriors".
   */
  private buildFixtureUrl(fixture: StakeFixture): string {
    const { sportSlug, categorySlug, tournamentSlug, slug } = fixture;
    if (!sportSlug || !categorySlug || !tournamentSlug || !slug) return '';
    return `https://stake3017.com/en/sports/${sportSlug}/${categorySlug}/${tournamentSlug}/${slug}`;
  }

  private buildOutcomes(raw: StakeWsOutcome[]): DexOutcome[] {
    return (raw ?? [])
      .filter((o) => o.active && isFinite(o.odds) && o.odds > 1)
      .map((o) => ({ name: o.name, price: o.odds }));
  }

  // ── HTTP helper ───────────────────────────────────────────────

  private async gql(query: string): Promise<{ data: any }> {
    const res = await axios.post(
      GRAPHQL_URL,
      { query },
      {
        headers: {
          ...HTTP_HEADERS,
          'User-Agent': this.cfUserAgent || HTTP_HEADERS['User-Agent'],
          ...(this.cfCookieHeader ? { Cookie: this.cfCookieHeader } : {}),
        },
        timeout: 15_000,
      },
    );
    if (res.data.errors) {
      const fatal = res.data.errors.find((e: any) => !res.data.data);
      if (fatal) throw new Error(`GraphQL error: ${fatal.message}`);
    }
    return res.data;
  }

  // ── Timers ─────────────────────────────────────────────────────

  private startTimers(): void {
    this.evictTimer = setInterval(() => this.evictStale(), EVICT_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.pingTimer)  { clearInterval(this.pingTimer);  this.pingTimer = null; }
    if (this.evictTimer) { clearInterval(this.evictTimer); this.evictTimer = null; }
    if (this.initialStateTimer) { clearTimeout(this.initialStateTimer); this.initialStateTimer = null; }
  }

  private terminateWs(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.terminate(); } catch {}
    }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    let evicted = 0;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Stake: evicted ${evicted} stale events (${this.eventCache.size} remaining)`);
    }
  }
}
