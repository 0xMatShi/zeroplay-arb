/**
 * pari-test.ts — тестовый скрипт для pari.ru odds (live + prematch)
 *
 * Запуск:
 *   cd andex-arb-be
 *   pnpm exec ts-node src/arbitrage/pm-bm-arb/adapters/pari/pari-test.ts
 *
 * Как работает pari.ru:
 *   - Платформа: Parimatch B2B white-label (pb06e2-resources.com)
 *   - HTTP версионированный дельта-поллинг, интервал ~900мс
 *   - Один эндпоинт для live + prematch
 *
 * Механизм:
 *   1. GET /events/list?version=0  → полный снапшот (events + sports + customFactors)
 *   2. GET /events/list?version={packetVersion} → только изменения с прошлого запроса
 *   3. customFactors: [{e: eventId, factors: [{f: factorId, v: odds, pt?: handicapText}]}]
 *      v=0 означает снятие ставки (suspended)
 *
 * Иерархия событий:
 *   - level=1, kind=1, !noEventView  → основной матч (парсим)
 *   - level=2, parentId=...          → под-событие (1-й тайм и т.д., пропускаем)
 *   - level=1, kind=501/3            → контейнер турнира, noEventView=true (пропускаем)
 *
 * Виды спорта (parentId в sports[]):
 *   Хоккей=2, Баскетбол=3, Теннис=4, Бейсбол=5, Киберспорт=29086
 *   Эспорт сегменты разбираются по имени: Counter-Strike / Dota 2 / LoL / Valorant
 *
 * Основные factor ID:
 *   921=П1 (winner 1), 922=X (draw), 923=П2 (winner 2)  — всегда основной исход
 *   910=П1(гандикап), 912=П2(гандикап)                  — гандикап по сетам/картам
 *   927=Ф1, 928=Ф2, 989=Ф1, 991=Ф2                      — гандикапы
 *   930/931, 974/976, 978/980, 1696/1697, 1727/1728      — тоталы (разные линии)
 */

import axios from 'axios';

// ── Constants ──────────────────────────────────────────────────────────────────

const LINE_BASE = 'https://line-lb01-w.pb06e2-resources.com';
const SCOPE_MARKET = 2300;
const LANG = 'en';
const POLL_INTERVAL_MS = 1_000;
const MAX_EVENTS_PER_UPDATE = 10;

// ── Target sports ──────────────────────────────────────────────────────────────

/**
 * Целевые корневые спорты по ID из sports[].
 * Хоккей=2, Баскетбол=3, Теннис=4, Бейсбол=5
 */
const TARGET_ROOT_SPORT_IDS = new Set([2, 3, 4, 5]);

const ROOT_SPORT_KEY: Record<number, string> = {
  2: 'hockey',
  3: 'basketball',
  4: 'tennis',
  5: 'baseball',
};

/** Определяет sportKey для эспорт-сегментов по имени */
function classifyEsport(segmentName: string): string | null {
  if (/counter.strike|^cs2/i.test(segmentName)) return 'cs2';
  if (/dota\s*2/i.test(segmentName)) return 'dota2';
  if (/\blol\b|league of legends/i.test(segmentName)) return 'lol';
  if (/valorant/i.test(segmentName)) return 'valorant';
  return null;
}

// ── Moneyline factor IDs ───────────────────────────────────────────────────────
// 921=П1, 922=X (draw, если есть), 923=П2
// Других факторов в этом адаптере не отслеживаем.

// ── Types ──────────────────────────────────────────────────────────────────────

interface PariSportEntry {
  id: number;
  kind: 'sport' | 'segment';
  parentId?: number;
  name: string;
  alias?: string;
}

interface PariEvent {
  id: number;
  sportId: number;
  kind: number;
  level: number;
  noEventView?: boolean;
  parentId?: number;
  team1: string;
  team2?: string;
  name: string;
  place: 'live' | 'line';
  startTime: number;
}

interface PariLiveInfo {
  eventId: number;
  timer: string;
  scoreComment: string;
}

interface PariFactor {
  f: number;
  v: number;
  pt?: string;
}

interface PariCustomFactors {
  e: number;
  countAll: number;
  factors: PariFactor[];
}

interface PariListResponse {
  packetVersion: number;
  sports?: PariSportEntry[];
  events?: PariEvent[];
  liveEventInfos?: PariLiveInfo[];
  customFactors?: PariCustomFactors[];
}

// ── State ──────────────────────────────────────────────────────────────────────

/** segmentId → sportKey (строится один раз из sports[]) */
const segmentSportKey = new Map<number, string>();

/** eventId → event meta */
const eventCache = new Map<number, PariEvent>();

/** eventId → liveInfo */
const liveInfoCache = new Map<number, PariLiveInfo>();

/** Moneyline factor IDs */
const MONEYLINE_FACTORS = new Set([921, 922, 923]);

/** eventId → { factorId → {value, pt} } — все факторы */
const oddsCache = new Map<number, Map<number, { v: number; pt?: string }>>();

/**
 * Factor discovery: factorId → { count, samples[] }
 * Собираем статистику по всем неизвестным factor ID для целевых матчей.
 */
const factorDiscovery = new Map<number, { count: number; samples: Array<{ v: number; pt?: string }> }>();

let currentVersion = 0;
let pollCount = 0;
let totalChanges = 0;

// ── Sport key resolution ───────────────────────────────────────────────────────

/**
 * Строит карту segmentId → sportKey из массива sports[].
 * Вызывается один раз при инициализации (и при каждом обновлении sports[]).
 */
function buildSegmentMap(sports: PariSportEntry[]): void {
  // Сначала кладём все записи в быстрый lookup
  const byId = new Map<number, PariSportEntry>();
  for (const s of sports) byId.set(s.id, s);

  // Функция: поднимаемся по parentId до корневого спорта (kind=sport)
  function rootOf(id: number): PariSportEntry | null {
    let cur = byId.get(id);
    const visited = new Set<number>();
    while (cur && cur.kind !== 'sport') {
      if (visited.has(cur.id)) break;
      visited.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return cur ?? null;
  }

  for (const s of sports) {
    if (s.kind !== 'segment') continue;

    const root = rootOf(s.id);
    if (!root) continue;

    if (TARGET_ROOT_SPORT_IDS.has(root.id)) {
      // Обычный спорт
      segmentSportKey.set(s.id, ROOT_SPORT_KEY[root.id]);
    } else if (root.id === 29086) {
      // Киберспорт — определяем по имени сегмента
      const key = classifyEsport(s.name);
      if (key) segmentSportKey.set(s.id, key);
    }
  }
}

/** Возвращает sportKey события или null если не в списке целевых */
function getSportKey(event: PariEvent): string | null {
  return segmentSportKey.get(event.sportId) ?? null;
}

/** Основной матч: level=1, kind=1, без noEventView, в целевом виде спорта */
function isTargetMatch(e: PariEvent): boolean {
  return e.level === 1 && e.kind === 1 && !e.noEventView && getSportKey(e) !== null;
}

// ── API ────────────────────────────────────────────────────────────────────────

async function fetchEventsList(version: number): Promise<PariListResponse> {
  const res = await axios.get<PariListResponse>(`${LINE_BASE}/events/list`, {
    params: { lang: LANG, version, scopeMarket: SCOPE_MARKET },
    timeout: 10_000,
    headers: { Accept: 'application/json', Referer: 'https://pari.ru/' },
  });
  return res.data;
}

// ── State updaters ─────────────────────────────────────────────────────────────

function applyEvents(events: PariEvent[]): void {
  for (const e of events) eventCache.set(e.id, e);
}

function applyLiveInfos(infos: PariLiveInfo[]): void {
  for (const info of infos) liveInfoCache.set(info.eventId, info);
}

function applyCustomFactors(customFactors: PariCustomFactors[]): void {
  for (const item of customFactors) {
    const event = eventCache.get(item.e);
    const isTarget = !!event && isTargetMatch(event);
    if (!isTarget) continue;

    const prevMap = oddsCache.get(item.e) ?? new Map<number, { v: number; pt?: string }>();

    for (const factor of item.factors) {
      if (factor.v === 0) {
        prevMap.delete(factor.f);
      } else {
        prevMap.set(factor.f, { v: factor.v, pt: factor.pt });

        // Collect into discovery map (skip moneyline — already known)
        if (!MONEYLINE_FACTORS.has(factor.f)) {
          const entry = factorDiscovery.get(factor.f) ?? { count: 0, samples: [] };
          entry.count++;
          if (entry.samples.length < 3) entry.samples.push({ v: factor.v, pt: factor.pt });
          factorDiscovery.set(factor.f, entry);
        }
      }
    }
    oddsCache.set(item.e, prevMap);
  }
}

// ── Factor discovery display ───────────────────────────────────────────────────

function printDiscovery(): void {
  if (factorDiscovery.size === 0) { console.log('  (no unknown factors yet)'); return; }

  // Sort by factor ID
  const sorted = [...factorDiscovery.entries()].sort((a, b) => a[0] - b[0]);

  console.log(`\n${'─'.repeat(75)}`);
  console.log(`[FACTOR DISCOVERY] ${sorted.length} unknown factor IDs found across target events:`);
  console.log(`  factorId  count  samples (value  pt)`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const [fid, data] of sorted) {
    const samplesStr = data.samples
      .map(s => `${s.v.toFixed(3)}${s.pt ? `(${s.pt})` : ''}`)
      .join('  ');
    console.log(`  ${String(fid).padEnd(9)} ${String(data.count).padEnd(6)} ${samplesStr}`);
  }
  console.log(`${'─'.repeat(75)}\n`);
}

// ── Per-event factor dump ──────────────────────────────────────────────────────

function printEventFactors(sportKeyFilter?: string): void {
  const targets = [...eventCache.values()].filter(e =>
    isTargetMatch(e) && (!sportKeyFilter || getSportKey(e) === sportKeyFilter),
  );
  if (targets.length === 0) { console.log('  No matching events'); return; }

  const sample = targets[0];
  const factors = oddsCache.get(sample.id);
  if (!factors) { console.log('  No factors for event'); return; }

  console.log(`\n[EVENT FACTORS] ${sample.team1} vs ${sample.team2} (${getSportKey(sample)})`);
  const sorted = [...factors.entries()].sort((a, b) => a[0] - b[0]);
  for (const [fid, { v, pt }] of sorted) {
    const known = MONEYLINE_FACTORS.has(fid) ? ' ← moneyline' : '';
    console.log(`  f=${String(fid).padEnd(6)} v=${v.toFixed(3).padEnd(8)} pt=${(pt ?? '').padEnd(12)}${known}`);
  }
  console.log('');
}

// ── Display ────────────────────────────────────────────────────────────────────

const SPORT_LABEL: Record<string, string> = {
  hockey: 'Хоккей  ',
  basketball: 'Баскетб.',
  tennis: 'Теннис  ',
  baseball: 'Бейсбол ',
  cs2: 'CS2     ',
  dota2: 'Dota2   ',
  lol: 'LoL     ',
  valorant: 'Valorant',
};

function printSnapshot(): void {
  const targets = Array.from(eventCache.values()).filter(isTargetMatch);
  const live = targets.filter(e => e.place === 'live');
  const pre = targets.filter(e => e.place === 'line');

  // Статистика по спортам
  const bySport: Record<string, { live: number; pre: number }> = {};
  for (const e of targets) {
    const sk = getSportKey(e)!;
    if (!bySport[sk]) bySport[sk] = { live: 0, pre: 0 };
    if (e.place === 'live') bySport[sk].live++;
    else bySport[sk].pre++;
  }

  console.log(`\n${'─'.repeat(75)}`);
  console.log(`[SNAPSHOT] Целевых матчей: ${targets.length}  (live: ${live.length} / prematch: ${pre.length})`);
  console.log('  Спорт        live  pre');
  for (const [sk, cnt] of Object.entries(bySport)) {
    console.log(`  ${(SPORT_LABEL[sk] ?? sk).padEnd(12)} ${String(cnt.live).padStart(4)}  ${String(cnt.pre).padStart(3)}`);
  }
  console.log(`${'─'.repeat(75)}`);

  // Показываем live матчи
  let shown = 0;
  for (const e of live) {
    if (++shown > 15) { console.log(`  ... ещё live: ${live.length - 15}`); break; }
    const sk = getSportKey(e)!;
    const liveInfo = liveInfoCache.get(e.id);
    const score = liveInfo?.scoreComment ?? '';
    const timer = liveInfo?.timer ? `[${liveInfo.timer}]` : '';
    const odds = oddsCache.get(e.id);
    const p1 = odds?.get(921)?.v;
    const draw = odds?.get(922)?.v;
    const p2 = odds?.get(923)?.v;
    const oddsStr = [
      p1 ? `П1:${p1.toFixed(2)}` : null,
      draw ? `X:${draw.toFixed(2)}` : null,
      p2 ? `П2:${p2.toFixed(2)}` : null,
    ].filter(Boolean).join(' / ');
    const name = `${e.team1} vs ${e.team2 ?? ''}`;
    console.log(`  ${SPORT_LABEL[sk]} ${timer.padEnd(8)} ${score.padEnd(7)} ${name.slice(0, 32).padEnd(32)} ${oddsStr || '—'}`);
  }
  console.log(`${'─'.repeat(75)}\n`);
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  try {
    const data = await fetchEventsList(currentVersion);
    pollCount++;

    if (data.sports?.length) buildSegmentMap(data.sports);
    if (data.events?.length) applyEvents(data.events);
    if (data.liveEventInfos?.length) applyLiveInfos(data.liveEventInfos);

    if (data.customFactors?.length) applyCustomFactors(data.customFactors);

    if (currentVersion === 0) {
      const targets = Array.from(eventCache.values()).filter(isTargetMatch);
      console.log(`[INIT] version=${data.packetVersion}  allEvents=${eventCache.size}  target=${targets.length}  segments=${segmentSportKey.size}`);
      printSnapshot();
      // Print all factors for first basketball and hockey event
      printEventFactors('basketball');
      printEventFactors('hockey');
    } else if (pollCount % 30 === 0) {
      // Every 30 polls (~30s) print discovery summary
      printDiscovery();
    } else {
      const liveCount = Array.from(eventCache.values()).filter(e => isTargetMatch(e) && e.place === 'live').length;
      process.stdout.write(`\r[POLL #${pollCount}] targetLive=${liveCount}  discovered=${factorDiscovery.size} factor IDs  version=${data.packetVersion}   `);
    }

    currentVersion = data.packetVersion;
  } catch (err: any) {
    console.error(`[ERROR] ${err.message}`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== pari.ru odds (live + prematch) ===');
  console.log(`Спорты: хоккей, баскетбол, теннис, бейсбол, CS2, Dota2, LoL, Valorant`);
  console.log(`Эндпоинт: ${LINE_BASE}/events/list\n`);

  await poll(); // снапшот

  setInterval(poll, POLL_INTERVAL_MS);
  console.log('[INFO] Watching for changes... (Ctrl+C to stop)\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
