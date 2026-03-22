/**
 * stake-test.ts — тестовый скрипт для Stake.com adapter
 *
 * Запуск:
 *   cd andex-arb-be
 *   pnpm exec ts-node --project tsconfig.json -e "require('ts-node').register(); require('./src/arbitrage/pm-bm-arb/adapters/stake/stake-test')"
 *   ИЛИ (если в package.json есть ts-node):
 *   pnpm exec ts-node src/arbitrage/pm-bm-arb/adapters/stake/stake-test.ts
 *
 * Что делает:
 *  1. HTTP GraphQL — получает фикстуры для 8 спортов
 *  2. WS (graphql-transport-ws) — подписывается на sportFixtureMarketsNext
 *     для каждой фикстуры → получает начальные кэфы и обновления в реальном времени
 */

import axios from 'axios';
import * as WebSocketLib from 'ws';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPHQL_URL = 'https://stake3017.com/_api/graphql';
const WS_URL      = 'wss://stake3017.com/_api/websockets';

/** FlareSolverr endpoint. Run: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest */
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL ?? 'http://localhost:8191';

/**
 * Статический токен из JS-бандла: /_app/immutable/chunks/XVztU-V4.js
 *   const h = "s5MNWtjTM5TvCMkAzxov"   ← export L (= lockdownToken)
 * Обновляется при редеплое сайта.
 */
const LOCKDOWN_TOKEN = 's5MNWtjTM5TvCMkAzxov';

/** Максимум фикстур на турнир через sportList */
const FIXTURE_LIMIT = 50;

/** Keepalive-пинг каждые 20 сек (сервер отключает по таймауту) */
const PING_INTERVAL_MS = 20_000;

/** Через сколько мс после connect_ack данные начинают приходить (~18с в тестах) */
const INITIAL_STATE_DELAY_NOTE = 18_000;

// ── Sport config ──────────────────────────────────────────────────────────────

/**
 * Спорты которые нас интересуют.
 * inSportList: true — в top-10 sportList, запрашиваем через tournamentList
 * extraTournaments — дополнительные slugTournament запросы для спортов вне top-10
 */
const TARGET_SPORTS: StageSportConfig[] = [
  {
    sportKey: 'basketball',
    stakeSlug: 'basketball',
    inSportList: false,
    extraTournaments: [
      { sport: 'basketball', category: 'usa',    tournament: 'nba' },
      { sport: 'basketball', category: 'europe', tournament: 'euroleague' },
    ],
  },
  {
    sportKey: 'tennis',
    stakeSlug: 'tennis',
    inSportList: true,
  },
  {
    sportKey: 'hockey',
    stakeSlug: 'ice-hockey',
    inSportList: false,
    extraTournaments: [
      { sport: 'ice-hockey', category: 'usa',    tournament: 'nhl' },
      { sport: 'ice-hockey', category: 'russia', tournament: 'khl' },
      { sport: 'ice-hockey', category: 'sweden', tournament: 'shl' },
    ],
  },
  {
    sportKey: 'baseball',
    stakeSlug: 'baseball',
    inSportList: true,
  },
  {
    sportKey: 'csgo',
    stakeSlug: 'counter-strike',
    inSportList: true,
  },
  {
    sportKey: 'dota2',
    stakeSlug: 'dota-2',
    inSportList: true,
  },
  {
    sportKey: 'lol',
    stakeSlug: 'league-of-legends',
    inSportList: true,
  },
  {
    sportKey: 'valorant',
    stakeSlug: 'valorant',
    inSportList: false,
    // Valorant не в top-10 → ищем через текстовый поиск
    useTextSearch: true,
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface StageSportConfig {
  sportKey: string;
  stakeSlug: string;
  inSportList: boolean;
  extraTournaments?: Array<{ sport: string; category: string; tournament: string }>;
  useTextSearch?: boolean;
}

interface StakeFixture {
  id: string;           // UUID — используется для WS-подписки
  name: string;         // "Team A - Team B"
  slug: string;         // для HTTP запроса кэфов
  status: string;       // "active" | "live" | "ended"
  startTime: string;
  provider: string;     // "betradar" | "oddin"
  extId: string;        // "sr:match:XXXXXXXX" или "od:match:XXXXXXX"
  sportKey: string;
  tournamentName: string;
}

interface StakeMarket {
  id: string;
  name: string;
  status: string;
  extId: string;
  specifiers: string;
  outcomes: Array<{ id: string; name: string; odds: number; active: boolean }>;
}

// ── Event cache ───────────────────────────────────────────────────────────────

/** fixtureId → последнее известное состояние маркетов */
const marketCache = new Map<string, StakeMarket[]>();

/** fixtureId → StakeFixture */
const fixtureMap = new Map<string, StakeFixture>();

// ── Step 1: HTTP — получение фикстур ─────────────────────────────────────────

async function fetchAllFixtures(): Promise<StakeFixture[]> {
  console.log('\n[HTTP] Fetching fixtures for all target sports...');

  const inList = TARGET_SPORTS.filter(s => s.inSportList).map(s => s.stakeSlug);
  const fixtures: StakeFixture[] = [];

  // ── 1a. sportList для спортов в top-10 ──────────────────────────────────────
  if (inList.length > 0) {
    const sportListQuery = `
      {
        sportList {
          slug name
          tournamentList {
            id name slug
            fixtureList(limit: ${FIXTURE_LIMIT}) {
              id name slug status startTime provider extId
            }
          }
        }
      }
    `;
    const { data } = await gql(sportListQuery);
    for (const sport of data.sportList ?? []) {
      const cfg = TARGET_SPORTS.find(s => s.stakeSlug === sport.slug);
      if (!cfg) continue;
      for (const tourney of sport.tournamentList ?? []) {
        for (const fix of tourney.fixtureList ?? []) {
          fixtures.push({
            ...fix,
            sportKey: cfg.sportKey,
            tournamentName: tourney.name,
          });
        }
      }
    }
    console.log(`[HTTP]   sportList: ${fixtures.length} fixtures from ${inList.join(', ')}`);
  }

  // ── 1b. slugTournament для спортов вне top-10 ────────────────────────────────
  const extraSports = TARGET_SPORTS.filter(s => !s.inSportList && s.extraTournaments?.length);
  for (const cfg of extraSports) {
    const before = fixtures.length;

    // Собираем все турниры одним batched-запросом
    const aliases = cfg.extraTournaments!.map((t, i) => `
      t${i}: slugTournament(sport: "${t.sport}", category: "${t.category}", tournament: "${t.tournament}") {
        id name slug
        fixtureList(limit: ${FIXTURE_LIMIT}) {
          id name slug status startTime provider extId
        }
      }
    `).join('\n');

    const { data } = await gql(`{ ${aliases} }`);
    for (let i = 0; i < cfg.extraTournaments!.length; i++) {
      const tourney = data[`t${i}`];
      if (!tourney) continue;
      for (const fix of tourney.fixtureList ?? []) {
        fixtures.push({
          ...fix,
          sportKey: cfg.sportKey,
          tournamentName: tourney.name,
        });
      }
    }
    console.log(`[HTTP]   ${cfg.sportKey}: ${fixtures.length - before} fixtures`);
  }

  // ── 1c. sportFixtureQuery для Valorant и других без slugTournament ───────────
  const searchSports = TARGET_SPORTS.filter(s => s.useTextSearch);
  for (const cfg of searchSports) {
    const before = fixtures.length;
    const { data } = await gql(`
      {
        results: sportFixtureQuery(query: "${cfg.stakeSlug}") {
          fixture {
            ... on SportFixture {
              id name slug status startTime provider extId
              tournament { id name slug category { sport { slug } } }
            }
          }
        }
      }
    `);
    for (const item of data.results ?? []) {
      const fix = item.fixture;
      if (!fix) continue;
      fixtures.push({
        id: fix.id,
        name: fix.name,
        slug: fix.slug,
        status: fix.status,
        startTime: fix.startTime,
        provider: fix.provider,
        extId: fix.extId,
        sportKey: cfg.sportKey,
        tournamentName: fix.tournament?.name ?? cfg.stakeSlug,
      });
    }
    console.log(`[HTTP]   ${cfg.sportKey} (search): ${fixtures.length - before} fixtures`);
  }

  // Дедупликация по id
  const seen = new Set<string>();
  const unique = fixtures.filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  console.log(`[HTTP] Total fixtures: ${unique.length}`);
  return unique;
}

// ── Step 2: HTTP — начальные кэфы (optional, при старте) ─────────────────────

/**
 * Получает начальные кэфы для фикстуры через HTTP.
 * Используется как fallback если WS начальный state задерживается.
 * WS затем будет обновлять кэш.
 */
async function fetchInitialOdds(fix: StakeFixture): Promise<StakeMarket[]> {
  const { data } = await gql(`
    {
      slugFixture(fixture: "${fix.slug}") {
        group: groups(groups: ["main"]) {
          templates(includeEmpty: false) {
            id extId name rank
            markets {
              id name status extId specifiers
              outcomes { id name odds active }
            }
          }
        }
      }
    }
  `);

  const markets: StakeMarket[] = [];
  for (const group of data.slugFixture?.group ?? []) {
    for (const tmpl of group.templates ?? []) {
      for (const mkt of tmpl.markets ?? []) {
        markets.push(mkt);
      }
    }
  }
  return markets;
}

// ── Cloudflare bypass via FlareSolverr ───────────────────────────────────────

/** cf_clearance + supporting cookies from FlareSolverr */
let cfCookieHeader = '';
let cfUserAgent    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Calls FlareSolverr to solve the Cloudflare challenge and retrieve cf_clearance cookies.
 * Setup: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
 */
async function getCfCookies(): Promise<void> {
  console.log(`[CF] Calling FlareSolverr at ${FLARESOLVERR_URL}...`);

  const res = await axios.post(
    `${FLARESOLVERR_URL}/v1`,
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
  const cfClearance = cookies.find(c => c.name === 'cf_clearance');
  if (!cfClearance) {
    throw new Error('FlareSolverr did not return cf_clearance cookie');
  }

  cfCookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  cfUserAgent    = solution.userAgent ?? cfUserAgent;
  console.log(`[CF] Got cookies via FlareSolverr (${cookies.length} total, cf_clearance present)`);
}

// ── Step 3: WebSocket ─────────────────────────────────────────────────────────

let ws: any = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let subId = 0;

/** subscriptionId → fixtureId */
const subIdToFixture = new Map<string, string>();

function connectWs(fixtures: StakeFixture[]): void {
  console.log(`\n[WS] Connecting to ${WS_URL}...`);

  ws = new WebSocket(WS_URL, ['graphql-transport-ws'], {
    headers: {
      'Origin': 'https://stake3017.com',
      'User-Agent': cfUserAgent,
      ...(cfCookieHeader ? { 'Cookie': cfCookieHeader } : {}),
    },
  });

  ws.on('open', () => {
    console.log('[WS] Connected — sending connection_init with lockdownToken');
    ws.send(JSON.stringify({
      type: 'connection_init',
      payload: {
        language: 'en',
        lockdownToken: LOCKDOWN_TOKEN,
      },
    }));
  });

  ws.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleWsMessage(msg, fixtures);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.warn(`[WS] Closed (code=${code}, reason=${reason.toString()}). Reconnecting in 5s...`);
    cleanup();
    setTimeout(() => connectWs(fixtures), 5_000);
  });

  ws.on('error', (err: Error) => {
    console.error('[WS] Error:', err.message);
  });
}

function handleWsMessage(msg: any, fixtures: StakeFixture[]): void {
  switch (msg.type) {

    case 'connection_ack': {
      console.log('[WS] connection_ack — subscribing to all fixtures...');
      console.log(`     (initial state expected in ~${INITIAL_STATE_DELAY_NOTE / 1000}s)`);

      // Подписываемся на каждую фикстуру через sportFixtureMarketsNext
      for (const fix of fixtures) {
        subscribeFixture(fix);
      }

      // Keepalive пинг
      pingTimer = setInterval(() => {
        if (ws?.readyState === 1 /* OPEN */) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
      break;
    }

    case 'ping': {
      // Сервер шлёт ping — отвечаем pong
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }

    case 'next': {
      const fixtureId = subIdToFixture.get(msg.id);
      if (!fixtureId) return;

      const data = msg.payload?.data;
      if (!data) return;

      // sportFixtureMarketsNext — список всех изменённых маркетов
      if (data.sportFixtureMarketsNext) {
        handleMarketsUpdate(fixtureId, data.sportFixtureMarketsNext);
      }
    }
  }
}

function subscribeFixture(fix: StakeFixture): void {
  const sid = `f${++subId}`;
  subIdToFixture.set(sid, fix.id);

  ws.send(JSON.stringify({
    type: 'subscribe',
    id: sid,
    payload: {
      query: `subscription {
        sportFixtureMarketsNext(fixtureId: "${fix.id}") {
          id name status extId specifiers
          outcomes { id name odds active }
        }
      }`,
    },
  }));
}

// ── Step 4: Обработка обновлений маркетов ────────────────────────────────────

function handleMarketsUpdate(fixtureId: string, markets: StakeMarket[]): void {
  const fix = fixtureMap.get(fixtureId);
  if (!fix) return;

  const existing = marketCache.get(fixtureId) ?? [];
  const isInitial = existing.length === 0;

  // Мёрджим: обновляем существующие маркеты или добавляем новые
  const byId = new Map(existing.map(m => [m.id, m]));
  const changes: string[] = [];

  for (const incoming of markets) {
    if (!incoming.outcomes?.length) continue;

    const cached = byId.get(incoming.id);
    if (!cached) {
      // Новый маркет
      byId.set(incoming.id, incoming);
      if (!isInitial) {
        changes.push(`  + [${incoming.name}] NEW`);
      }
    } else {
      // Обновляем кэфы
      for (let i = 0; i < incoming.outcomes.length; i++) {
        const newOdds = incoming.outcomes[i]?.odds;
        const oldOdds = cached.outcomes[i]?.odds;
        if (newOdds && oldOdds && newOdds !== oldOdds) {
          const arrow = newOdds > oldOdds ? '↑' : '↓';
          changes.push(
            `  [${incoming.name}] ${incoming.outcomes[i].name}: ` +
            `${oldOdds.toFixed(3)} → ${newOdds.toFixed(3)} ${arrow}`,
          );
          cached.outcomes[i] = { ...cached.outcomes[i], odds: newOdds };
        }
      }
      // Обновляем статус
      if (incoming.status !== cached.status) cached.status = incoming.status;
    }
  }

  marketCache.set(fixtureId, [...byId.values()]);

  if (isInitial) {
    // Первый батч — логируем начальное состояние
    const allMarkets = [...byId.values()];
    const mainMkt = findMoneylineMarket(allMarkets);
    console.log(
      `[WS INIT] ${fix.sportKey.toUpperCase().padEnd(10)} | ` +
      `${fix.name} | ` +
      `${allMarkets.length} markets | ` +
      (mainMkt
        ? mainMkt.outcomes.map(o => `${o.name}:${o.odds}`).join(' / ')
        : '(no moneyline)'),
    );

    // ── Дамп всех маркетов для анализа extId/specifiers ──────────────────────
    // Группируем по extId для компактного вывода
    const INTERESTING_KEYWORDS = /total|handicap|spread|over|under|map|maps|hcp|ou|ah/i;
    const interestingMarkets = allMarkets.filter(m =>
      INTERESTING_KEYWORDS.test(m.name) ||
      INTERESTING_KEYWORDS.test(m.specifiers ?? '') ||
      (m.extId && !['1', '52', '186', '219', '406'].includes(m.extId) && m.specifiers === '')
    );

    if (interestingMarkets.length > 0) {
      console.log(`         [MARKETS] ${fix.sportKey} — ${fix.name}:`);
      for (const m of interestingMarkets) {
        const outcomeStr = m.outcomes
          .filter(o => o.active)
          .map(o => `${o.name}:${o.odds}`)
          .join(' | ');
        console.log(
          `           extId=${m.extId.padEnd(6)} spec="${(m.specifiers ?? '').padEnd(20)}" ` +
          `name="${m.name}" → ${outcomeStr}`,
        );
      }
    }
  } else if (changes.length > 0) {
    // Обновление кэфов
    console.log(`[WS UPD]  ${fix.name}:`);
    for (const c of changes) console.log(c);
  }
}

/**
 * Находит основной moneyline-маркет в списке.
 * Логика: без specifiers, 2-3 outcomes, name не содержит "Half"/"Quarter"/"Map".
 * Stake использует разные extId для разных спортов:
 *   "1"   = 1x2 (soccer)
 *   "186" = Winner H2H (tennis, baseball, esports)
 *   "406" = Winner incl. OT/Penalties (NHL hockey)
 *   "52"  = Moneyline (NBA basketball)
 */
function findMoneylineMarket(markets: StakeMarket[]): StakeMarket | null {
  const MONEYLINE_EXT_IDS = new Set(['1', '52', '186', '219', '406']);

  // Сначала ищем по extId
  const byExtId = markets.find(m =>
    MONEYLINE_EXT_IDS.has(m.extId) &&
    !m.specifiers &&
    m.status === 'active',
  );
  if (byExtId) return byExtId;

  // Фоллбэк: ищем по структуре (2-3 outcomes, без specifiers, без "half/quarter/map/corner")
  return markets.find(m =>
    !m.specifiers &&
    m.status === 'active' &&
    m.outcomes.length >= 2 && m.outcomes.length <= 3 &&
    !/half|quarter|map|corner|set|period/i.test(m.name),
  ) ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gql(query: string): Promise<{ data: any }> {
  const res = await axios.post(GRAPHQL_URL, { query }, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': cfUserAgent,
      'Origin': 'https://stake3017.com',
      'Referer': 'https://stake3017.com/sports',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...(cfCookieHeader ? { 'Cookie': cfCookieHeader } : {}),
    },
    timeout: 15_000,
  });
  if (res.data.errors) {
    // Частичные ошибки (некоторые поля null) — не бросаем, возвращаем что есть
    const fatal = res.data.errors.find((e: any) => !res.data.data);
    if (fatal) throw new Error(`GraphQL error: ${fatal.message}`);
  }
  return res.data;
}

function cleanup(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  subIdToFixture.clear();
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stake Adapter Test ===');
  console.log(`Sports: ${TARGET_SPORTS.map(s => s.sportKey).join(', ')}\n`);

  // 0. Получаем Cloudflare cookies через headless Chrome
  await getCfCookies();

  // 1. Получаем фикстуры
  const fixtures = await fetchAllFixtures();

  // Регистрируем в map для быстрого доступа из WS handler
  for (const f of fixtures) {
    fixtureMap.set(f.id, f);
  }

  // Краткая статистика по спорту
  const bySport = new Map<string, number>();
  for (const f of fixtures) {
    bySport.set(f.sportKey, (bySport.get(f.sportKey) ?? 0) + 1);
  }
  console.log('\n[INFO] Fixtures by sport:');
  for (const [sport, count] of bySport) {
    console.log(`  ${sport.padEnd(12)} ${count}`);
  }

  // 2. Опционально: загружаем начальные кэфы через HTTP для live-фикстур
  //    WS даст те же данные через ~18с, но HTTP быстрее для горячего старта
  const liveFixtures = fixtures.filter(f => f.status === 'live').slice(0, 5);
  if (liveFixtures.length > 0) {
    console.log(`\n[HTTP] Prefetching odds for ${liveFixtures.length} live fixtures...`);
    for (const fix of liveFixtures) {
      try {
        const markets = await fetchInitialOdds(fix);
        marketCache.set(fix.id, markets);
        const ml = findMoneylineMarket(markets);
        console.log(
          `  ${fix.name} — ` +
          (ml ? ml.outcomes.map(o => `${o.name}:${o.odds}`).join(' / ') : 'no ML'),
        );
      } catch (e: any) {
        console.warn(`  ${fix.name}: ${e.message}`);
      }
    }
  }

  // 2b. HTTP-скан маркетов для одной фикстуры на каждый спорт
  //     Без groups-фильтра — получаем ВСЕ группы (тотали, гандикапы и т.д.)
  const SCAN_SPORTS = ['basketball', 'hockey', 'tennis', 'baseball', 'csgo', 'dota2', 'lol', 'valorant'];
  const scanned = new Set<string>();
  const scanFixtures: StakeFixture[] = [];
  for (const sport of SCAN_SPORTS) {
    // Берём только реальные матчи (не аутрайты): название должно содержать " - "
    const fix = fixtures.find(f => f.sportKey === sport && f.status !== 'ended' && f.name.includes(' - '));
    if (fix) { scanFixtures.push(fix); scanned.add(sport); }
  }

  if (scanFixtures.length > 0) {
    console.log(`\n[HTTP SCAN] Fetching ALL market groups for sample fixtures...`);
    const INTERESTING_KEYWORDS = /total|handicap|spread|over|under|hcp|ou|ah|maps|map winner|maps winner/i;
    for (const fix of scanFixtures) {
      try {
        const { data } = await gql(`
          {
            slugFixture(fixture: "${fix.slug}") {
              groups {
                name
                templates(includeEmpty: false) {
                  markets {
                    id name status extId specifiers
                    outcomes { id name odds active }
                  }
                }
              }
            }
          }
        `);
        const allMarkets: StakeMarket[] = [];
        for (const g of data.slugFixture?.groups ?? []) {
          for (const tmpl of g.templates ?? []) {
            for (const mkt of tmpl.markets ?? []) {
              allMarkets.push(mkt);
            }
          }
        }
        const interesting = allMarkets.filter(m =>
          INTERESTING_KEYWORDS.test(m.name) || INTERESTING_KEYWORDS.test(m.specifiers ?? ''),
        );
        console.log(`\n  [${fix.sportKey.toUpperCase()}] ${fix.name} (${allMarkets.length} markets total):`);
        if (interesting.length === 0) {
          console.log('    (no interesting markets found)');
        } else {
          for (const m of interesting) {
            const outcomes = m.outcomes.filter(o => o.active).map(o => `${o.name}:${o.odds}`).join(' | ');
            console.log(
              `    extId=${m.extId.padEnd(6)} spec="${(m.specifiers ?? '').padEnd(25)}" name="${m.name}"` +
              (outcomes ? `\n      → ${outcomes}` : ''),
            );
          }
        }
      } catch (e: any) {
        console.warn(`  [${fix.sportKey}] ${fix.name}: ${e.message}`);
      }
    }
    console.log('');
  }

  // 3. Подключаемся к WS и подписываемся на все фикстуры
  connectWs(fixtures);

  console.log('\n[INFO] Listening for WS updates... (Ctrl+C to stop)\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
