/**
 * cloudbet-test.ts — тестовый скрипт для Cloudbet adapter
 *
 * Запуск:
 *   cd andex-arb-be
 *   CLOUDBET_API_KEY=<key> pnpm exec ts-node src/arbitrage/pm-bm-arb/adapters/cloudbet/cloudbet-test.ts
 *
 * Как получить API Key:
 *   - Affiliate key (кэшированный, ~1 мин): https://affiliates.cloudbet.com/affiliate_api_token
 *   - Trading key (реалтайм): аккаунт Cloudbet → My Account → API
 *
 * Что делает:
 *  1. REST (sports-api.cloudbet.com/pub/v2/) — загружает события для целевых спортов
 *  2. Pusher WS — подписывается на обновления кэфов/статуса для каждого события
 *     Канал: {randomUUID}_cAPI_{md5(topic)} (публичный, не требует авторизации)
 *
 * Подтверждённые факты:
 *   - Pusher app key: c065c29ae4b4b2f23f53 (ws-eu.pusher.com)
 *   - Каналы технически ПУБЛИЧНЫЕ (auth=""), но сервер рассылает обновления ТОЛЬКО на UUID из аккаунта
 *   - UUID берётся из JWT клейма `uuid` в CLOUDBET_API_KEY (не randomUUID!)
 *   - WS данные: base64(gzip({uuid, index, chunk, final})) → base64(inner JSON)
 *   - Топики: event_v6_main_{id} (odds), metadata_{id} (score), v6_live_events_list_update (list)
 */

import axios from 'axios';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as WebSocketLib from 'ws';
const WebSocket = (WebSocketLib as any).default ?? WebSocketLib;

// ── Constants ─────────────────────────────────────────────────────────────────

const REST_BASE    = 'https://sports-api.cloudbet.com/pub/v2/odds';
const PUSHER_KEY   = 'c065c29ae4b4b2f23f53';
const PUSHER_WS    = `wss://ws-eu.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;

/**
 * UUID должен совпадать с `uuid` клеймом в JWT-токене API ключа.
 * Каналы технически публичные, но сервер рассылает обновления только на UUID из аккаунта.
 * Случайный UUID → 0 обновлений. UUID из JWT → сотни обновлений в минуту.
 */
/** API key из env или пустая строка (получите на affiliates.cloudbet.com) */
const API_KEY      = process.env.CLOUDBET_API_KEY ?? '';

function extractUuidFromJwt(apiKey: string): string {
  try {
    const parts = apiKey.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.uuid) return payload.uuid as string;
    }
  } catch { /* ignore */ }
  return crypto.randomUUID();
}
const PLAYER_UUID  = extractUuidFromJwt(API_KEY);

/** Лимит событий на спорт (REST запрос) */
const EVENTS_LIMIT = 50;

/** Keepalive ping каждые 25 сек */
const PING_INTERVAL_MS = 25_000;

// ── Target sports ──────────────────────────────────────────────────────────────

/**
 * Целевые виды спорта.
 * marketKey — основной рынок для arbitrage (moneyline / winner / match_odds).
 * submarket  — ключ субмаркета в котором ищем home/away outcomes.
 */
const TARGET_SPORTS: SportsConfig[] = [
  { sportKey: 'basketball',           marketKey: 'basketball.moneyline',         submarket: 'period=ot&period=ft'       },
  { sportKey: 'tennis',               marketKey: 'tennis.winner',               submarket: 'period=default'            },
  { sportKey: 'ice-hockey',           marketKey: 'ice_hockey.winner',            submarket: 'period=ot&period=ft&period=penalties' },
  { sportKey: 'baseball',             marketKey: 'baseball.moneyline',           submarket: 'period=ft'                 },
  { sportKey: 'counter-strike',       marketKey: 'counter_strike.winner',        submarket: 'period=default'            },
  { sportKey: 'dota-2',              marketKey: 'dota_2.winner',               submarket: 'period=default'            },
  { sportKey: 'league-of-legends',    marketKey: 'league_of_legends.winner',    submarket: 'period=default'            },
  { sportKey: 'esport-valorant',      marketKey: 'esport_valorant.winner',      submarket: 'period=default'            },
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface SportsConfig {
  sportKey: string;
  marketKey: string;
  /** Ключ субмаркета для основного moneyline */
  submarket: string;
}

interface CbEvent {
  id: number;
  name: string;
  status: string;
  startTime: string;
  cutoffTime: string;
  home: { name: string; key: string } | null;
  away: { name: string; key: string } | null;
  markets: Record<string, CbMarket>;
  sportKey: string;
  competitionKey: string;
  competitionName: string;
}

interface CbMarket {
  submarkets: Record<string, CbSubmarket>;
  liability?: number;
}

interface CbSubmarket {
  sequence: string;
  selections: CbSelection[];
}

interface CbSelection {
  outcome: string;    // "home" | "away" | "draw"
  params: string;
  price: number;
  status: string;     // "SELECTION_ENABLED" | "SELECTION_DISABLED"
  side: string;       // "BACK" | "LAY"
  probability?: number;
}

// ── State ──────────────────────────────────────────────────────────────────────

/** eventId → CbEvent */
const eventCache = new Map<number, CbEvent>();

/** Chunked WS message buffer: uuid → {chunks, final} */
const chunkBuffer = new Map<string, { chunks: Record<number, string>; receivedFinal: boolean }>();

// ── Pusher channel helpers ─────────────────────────────────────────────────────

/**
 * Строит Pusher канал по формуле сайта:
 *   channel = playerUuid + "_cAPI_" + md5(topic)
 *
 * Каналы ПУБЛИЧНЫЕ — auth="", работают с любым UUID.
 * Сервер пушит обновления для всех UUID-префиксов по одному topic-хэшу.
 */
function makeChannel(topic: string): string {
  const hash = crypto.createHash('md5').update(topic).digest('hex');
  return `${PLAYER_UUID}_cAPI_${hash}`;
}

function oddsChannel(eventId: number):    string { return makeChannel(`event_v6_main_${eventId}`); }
function metaChannel(eventId: number):    string { return makeChannel(`metadata_${eventId}`); }
function liveListChannel():               string { return makeChannel('v6_live_events_list_update'); }

// ── WS message decompression ───────────────────────────────────────────────────

/**
 * Декодирует Pusher "update" data:
 *   1. Base64 → Buffer → gunzip → outer JSON  {uuid, index, chunk, final}
 *   2. Собираем чанки по uuid
 *   3. Объединённая строка chunk → base64 decode → inner JSON
 */
function decompressAndAssemble(rawData: string, cb: (json: any) => void): void {
  try {
    const buf = Buffer.from(rawData, 'base64');
    zlib.gunzip(buf, (err, inflated) => {
      if (err) return;
      let outer: any;
      try { outer = JSON.parse(inflated.toString()); } catch { return; }

      // Собираем чанки
      const key = outer.uuid ?? 'single';
      if (!chunkBuffer.has(key)) {
        chunkBuffer.set(key, { chunks: {}, receivedFinal: false });
      }
      const entry = chunkBuffer.get(key)!;
      entry.chunks[Number(outer.index ?? 0)] = outer.chunk;
      if (outer.final) entry.receivedFinal = true;

      const indices = Object.keys(entry.chunks).map(Number).sort((a, b) => a - b);
      const allReceived = entry.receivedFinal && indices.length === indices[indices.length - 1] + 1;

      if (!allReceived) return; // Ждём остальные чанки

      const joined = indices.map(i => entry.chunks[i]).join('');
      chunkBuffer.delete(key);

      try {
        const inner = JSON.parse(Buffer.from(joined, 'base64').toString());
        cb(inner);
      } catch { /* invalid inner JSON */ }
    });
  } catch { /* invalid base64 or parse error */ }
}

// ── REST: загрузка событий ─────────────────────────────────────────────────────

async function fetchEventsForSport(cfg: SportsConfig): Promise<CbEvent[]> {
  const now = Math.floor(Date.now() / 1000);
  const to   = now + 24 * 60 * 60; // следующие 24 часа

  let events: CbEvent[] = [];

  // Live события
  try {
    const res = await restGet('/events', {
      sport: cfg.sportKey,
      live: 'true',
      markets: cfg.marketKey,
      limit: String(EVENTS_LIMIT),
    });
    for (const comp of (res.data?.competitions ?? [])) {
      for (const e of (comp.events ?? [])) {
        events.push(normalizeEvent(e, cfg, comp));
      }
    }
  } catch (err: any) {
    console.warn(`[REST] live ${cfg.sportKey}: ${err.message}`);
  }

  // Prematch события (следующие 24ч)
  try {
    const res = await restGet('/events', {
      sport: cfg.sportKey,
      live: 'false',
      from: String(now),
      to: String(to),
      markets: cfg.marketKey,
      limit: String(EVENTS_LIMIT),
    });
    for (const comp of (res.data?.competitions ?? [])) {
      for (const e of (comp.events ?? [])) {
        events.push(normalizeEvent(e, cfg, comp));
      }
    }
  } catch (err: any) {
    console.warn(`[REST] prematch ${cfg.sportKey}: ${err.message}`);
  }

  // Дедупликация по id
  const seen = new Set<number>();
  return events.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
}

function normalizeEvent(raw: any, cfg: SportsConfig, comp?: any): CbEvent {
  return {
    id:              raw.id,
    name:            raw.name ?? '',
    status:          raw.status ?? 'TRADING',
    startTime:       raw.startTime ?? '',
    cutoffTime:      raw.cutoffTime ?? '',
    home:            raw.home ?? null,
    away:            raw.away ?? null,
    markets:         raw.markets ?? {},
    sportKey:        cfg.sportKey,
    competitionKey:  comp?.key ?? raw.competition?.key ?? '',
    competitionName: comp?.name ?? raw.competition?.name ?? '',
  };
}

// ── Market helpers ─────────────────────────────────────────────────────────────

/**
 * Извлекает moneyline кэфы из события.
 * Ищет субмаркет с совпадающим ключом (или первый доступный).
 * Возвращает массив {name, price} для home/away/draw.
 */
function extractMoneyline(
  event: CbEvent,
  cfg: SportsConfig,
): Array<{ name: string; price: number }> | null {
  const market = event.markets[cfg.marketKey];
  if (!market?.submarkets) return null;

  // Ищем нужный субмаркет; если нет точного совпадения — берём первый
  let submarket = market.submarkets[cfg.submarket];
  if (!submarket) {
    const firstKey = Object.keys(market.submarkets)[0];
    if (!firstKey) return null;
    submarket = market.submarkets[firstKey];
  }

  const outcomes = (submarket.selections ?? [])
    .filter(s => s.status === 'SELECTION_ENABLED' && s.side === 'BACK' && s.params === '')
    .map(s => ({ name: s.outcome, price: s.price }));

  return outcomes.length >= 2 ? outcomes : null;
}

/**
 * Обновляет кэш события данными из WS update.
 * WS приходит частичный объект — мёрджим только markets.
 */
function applyWsUpdate(update: any): void {
  const id: number = update.id;
  if (!id) return;

  const event = eventCache.get(id);
  if (!event) return;

  // Обновляем статус
  if (update.status) event.status = update.status;

  // Мёрджим markets: обновляем только пришедшие
  if (update.markets) {
    for (const [mKey, mVal] of Object.entries(update.markets as Record<string, CbMarket>)) {
      if (!event.markets[mKey]) {
        event.markets[mKey] = mVal;
      } else {
        // Мёрджим субмаркеты
        const existing = event.markets[mKey];
        for (const [smKey, smVal] of Object.entries(mVal.submarkets ?? {})) {
          existing.submarkets[smKey] = smVal;
        }
      }
    }
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

let ws: any = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** eventId → имя канала кэфов */
const subscribedOddsChannels = new Map<number, string>();

function connectWs(events: CbEvent[]): void {
  console.log(`\n[WS] Connecting to Pusher (${events.length} events, UUID: ${PLAYER_UUID.slice(0, 8)}...)...`);

  ws = new WebSocket(PUSHER_WS);

  ws.on('open', () => console.log('[WS] Socket open'));

  ws.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(msg, events);
  });

  ws.on('close', (code: number) => {
    console.warn(`[WS] Closed (code=${code}), reconnecting in 5s...`);
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    setTimeout(() => connectWs(events), 5_000);
  });

  ws.on('error', (err: Error) => console.error('[WS] Error:', err.message));
}

function handleMessage(msg: any, events: CbEvent[]): void {
  switch (msg.event) {
    case 'pusher:connection_established': {
      console.log('[WS] Connected — subscribing to channels...');
      subscribeAll(events);

      pingTimer = setInterval(() => {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }, PING_INTERVAL_MS);
      break;
    }

    case 'pusher:pong':
    case 'pusher:ping':
      break;

    case 'pusher_internal:subscription_succeeded': {
      const eventId = [...subscribedOddsChannels.entries()]
        .find(([, ch]) => ch === msg.channel)?.[0];
      if (eventId) {
        const ev = eventCache.get(eventId);
        console.log(`[WS] Subscribed odds: ${ev?.name ?? eventId}`);
      }
      break;
    }

    case 'update': {
      const channel = msg.channel as string;

      // Проверяем, это odds-канал или live-list
      if (channel === liveListChannel()) {
        decompressAndAssemble(msg.data, (data) => {
          if (!data?.action || !Array.isArray(data.events)) return;
          console.log(`[WS] LiveList: ${data.action} × ${data.events.length}`);

          if (data.action === 'LIST_ADD') {
            // Автоматически подписываемся на кэфы новых live событий
            for (const ev of data.events) {
              const id: number = ev.id;
              if (!id || subscribedOddsChannels.has(id)) continue;

              // Найдём конфиг по sportKey
              const sportKey = ev.sport?.key ?? '';
              const cfg = TARGET_SPORTS.find(c => c.sportKey === sportKey);
              if (!cfg) continue;

              // Добавляем в кэш (без markets пока — придут через WS)
              if (!eventCache.has(id)) {
                eventCache.set(id, {
                  id,
                  name:            ev.name ?? `${ev.home?.name} vs ${ev.away?.name}`,
                  status:          'TRADING_LIVE',
                  startTime:       ev.startTime ?? '',
                  cutoffTime:      ev.cutoffTime ?? '',
                  home:            ev.home ?? null,
                  away:            ev.away ?? null,
                  markets:         {},
                  sportKey:        cfg.sportKey,
                  competitionKey:  ev.competition?.key ?? '',
                  competitionName: ev.competition?.name ?? '',
                });
              }

              const ch = oddsChannel(id);
              subscribedOddsChannels.set(id, ch);
              ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
              console.log(`[WS] Auto-subscribed live: ${eventCache.get(id)?.name ?? id}`);
            }
          } else if (data.action === 'LIST_REMOVE') {
            for (const ev of data.events) {
              const id: number = ev.id;
              if (eventCache.has(id)) {
                console.log(`[WS] LiveList remove: ${eventCache.get(id)?.name ?? id}`);
              }
            }
          }
        });
        return;
      }

      // Odds channel
      const eventId = [...subscribedOddsChannels.entries()]
        .find(([, ch]) => ch === channel)?.[0];


      decompressAndAssemble(msg.data, (update) => {
        if (!eventId) return;

        const prevEvent = eventCache.get(eventId);
        if (!prevEvent) return;
        const cfg = TARGET_SPORTS.find(s => s.sportKey === prevEvent.sportKey);
        if (!cfg) return;

        const prevML = cfg ? extractMoneyline(prevEvent, cfg) : null;
        applyWsUpdate(update);
        const newML = cfg ? extractMoneyline(prevEvent, cfg) : null;

        // Логируем изменения кэфов
        if (prevML && newML) {
          const changes: string[] = [];
          for (let i = 0; i < Math.min(prevML.length, newML.length); i++) {
            if (prevML[i].price !== newML[i].price) {
              const arrow = newML[i].price > prevML[i].price ? '↑' : '↓';
              changes.push(`${prevML[i].name}: ${prevML[i].price.toFixed(3)} → ${newML[i].price.toFixed(3)} ${arrow}`);
            }
          }
          if (changes.length > 0) {
            console.log(`[WS UPD] ${prevEvent.name}:`);
            changes.forEach(c => console.log(`  ${c}`));
          }
        }
      });
      break;
    }
  }
}

function subscribeAll(events: CbEvent[]): void {
  // Live list channel
  const llCh = liveListChannel();
  ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: llCh } }));
  console.log('[WS] Subscribed: v6_live_events_list_update');

  // Odds channel per event
  for (const event of events) {
    const ch = oddsChannel(event.id);
    subscribedOddsChannels.set(event.id, ch);
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
  }
  console.log(`[WS] Sent ${events.length} event subscriptions`);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function restGet(path: string, params: Record<string, string>): Promise<{ data: any }> {
  const url = new URL(REST_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);

  const res = await axios.get(url.toString(), {
    headers: {
      'accept': 'application/json',
      'X-API-Key': API_KEY,
    },
    timeout: 15_000,
  });
  return res;
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Cloudbet Adapter Test ===');
  console.log(`    UUID: ${PLAYER_UUID}\n`);

  if (!API_KEY) {
    console.warn('[WARN] CLOUDBET_API_KEY not set.');
    console.warn('       REST запросы вернут 401. События будут получены только через WS live-list.');
    console.warn('       Ключ: https://affiliates.cloudbet.com/affiliate_api_token\n');
  }

  // ── Step 1: Загружаем события через REST ──────────────────────────────────
  console.log('[REST] Fetching events for all target sports...');
  const allEvents: CbEvent[] = [];

  for (const cfg of TARGET_SPORTS) {
    try {
      const events = await fetchEventsForSport(cfg);
      for (const e of events) {
        if (!eventCache.has(e.id)) {
          eventCache.set(e.id, e);
          allEvents.push(e);
        }
      }
      console.log(`[REST] ${cfg.sportKey.padEnd(20)} ${events.length} events`);
    } catch (err: any) {
      console.warn(`[REST] ${cfg.sportKey}: ${err.message}`);
    }
  }

  console.log(`\n[REST] Total unique events: ${allEvents.length}`);

  // ── Step 2: Показываем снапшот ────────────────────────────────────────────
  console.log('\n[SNAPSHOT] Live/Prematch events with moneyline odds:');
  let shown = 0;
  for (const event of allEvents) {
    const cfg = TARGET_SPORTS.find(c => c.sportKey === event.sportKey)!;
    const ml = extractMoneyline(event, cfg);
    if (!ml) continue;
    const oddsStr = ml.map(o => `${o.name}:${o.price.toFixed(3)}`).join(' / ');
    const isLive = event.status === 'TRADING_LIVE' ? '[LIVE]' : '';
    console.log(`  ${isLive.padEnd(7)} ${cfg.sportKey.padEnd(20)} cutoff=${event.cutoffTime || 'N/A'} ${event.name} — ${oddsStr}`);
    if (++shown >= 30) { console.log(`  ... (${allEvents.length - shown} more)`); break; }
  }

  // ── Step 3: Подключаемся к Pusher WS ─────────────────────────────────────
  connectWs(allEvents);

  console.log('\n[INFO] Listening for WS updates... (Ctrl+C to stop)');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
