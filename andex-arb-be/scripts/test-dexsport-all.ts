/**
 * Полный обход всех событий DexSport через WebSocket
 *
 * Цепочка: guest token → config → discipline → tournament → event → market
 * Собирает все события со всех дисциплин (live + prematch)
 *
 * Запуск: npx ts-node scripts/test-dexsport-all.ts
 */

import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL   = 'wss://prod.dexsport.work/ws';
const API_KEY  = 'ta-dexsport';

// Лимиты чтобы не захлебнуться данными
const MAX_TOURNAMENTS_PER_DISCIPLINE = 10;
const MAX_EVENTS_PER_TOURNAMENT      = 5;
const MAX_TOTAL_EVENTS               = 1000;
const SUMMARY_INTERVAL_MS            = 15_000; // выводить сводку каждые 15с
const TIMEOUT_MS                     = 3 * 60_000; // 3 минуты

// ── Типы ──────────────────────────────────────────────────────

interface EventInfo {
  id: string;
  name: string;
  discipline: string;
  status: number; // 3=live, 1=prematch
  startTime?: number;
  marketId?: string;
}

interface MarketInfo {
  marketId: string;
  eventId: string;
  name: string;
  outcomes: { name: string; price: number }[];
}

// ── Состояние ─────────────────────────────────────────────────

const events = new Map<string, EventInfo>();
const markets = new Map<string, MarketInfo>();

const subscribedDisciplines  = new Set<string>();
const subscribedTournaments  = new Set<string>();
const subscribedEvents       = new Set<string>();
const subscribedMarkets      = new Set<string>();

// Маппинг tournamentId → discipline для определения дисциплины события
const tournamentDiscipline = new Map<string, string>();

let totalEventsJoined = 0;

// ── Получение токена ───────────────────────────────────────────

async function getToken(): Promise<string> {
  const { data } = await axios.post(`${BASE_URL}/public/api/profile`, {
    apiKey: API_KEY,
    visitorId: randomUUID().replace(/-/g, ''),
    guest: true,
  }, { timeout: 10_000 });

  if (!data.token) throw new Error('DexSport: нет токена');
  console.log(`[auth] Токен получен (guest=${data.guest}, currency=${data.currency?.name})`);
  return data.token;
}

function buildTimestamp(): string {
  return Buffer.from(JSON.stringify({
    now: new Date().toISOString(),
    expired: false,
    exp: new Date(Date.now() + 600_000).toISOString(),
    rcv: new Date().toISOString(),
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Сводка ────────────────────────────────────────────────────

function printSummary(): void {
  const liveEvents  = [...events.values()].filter((e) => e.status === 3);
  const preEvents   = [...events.values()].filter((e) => e.status !== 3);

  const byDiscipline = new Map<string, number>();
  for (const e of events.values()) {
    // Группируем по дисциплине — пропускаем числовые ID (некорректно определённые)
    const disc = /^\d/.test(e.discipline) ? '?' : e.discipline;
    byDiscipline.set(disc, (byDiscipline.get(disc) ?? 0) + 1);
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`СВОДКА: events=${events.size} (live=${liveEvents.length} prematch=${preEvents.length})  markets=${markets.size}`);
  console.log('─'.repeat(70));

  // По дисциплинам
  const sorted = [...byDiscipline.entries()].sort((a, b) => b[1] - a[1]);
  for (const [disc, count] of sorted) {
    console.log(`  ${disc.padEnd(20)} ${count} events`);
  }

  // Последние 10 маркетов с ценами
  if (markets.size > 0) {
    console.log('\nПоследние маркеты (Match Winner):');
    const latest = [...markets.values()].slice(-10);
    for (const m of latest) {
      const ev = events.get(m.eventId);
      const prefix = ev?.status === 3 ? '[LIVE]' : '[PRE] ';
      const disc = ev?.discipline ?? '?';
      const oddsStr = m.outcomes.map((o) => `${o.name} ${o.price.toFixed(2)}`).join('  |  ');
      console.log(`  ${prefix} [${disc.padEnd(8)}] ${m.name.padEnd(40)} ${oddsStr}`);
    }
  }

  console.log('═'.repeat(70) + '\n');
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const token = await getToken();

  const query = new URLSearchParams({
    cid: API_KEY, lang: 'en',
    timestamp: buildTimestamp(), token, format: 'long',
  });

  console.log('\n[ws] Подключаемся...');
  const ws = new Ws.WebSocket(`${WS_URL}?${query}`);

  const send = (msg: unknown) => {
    if (ws.readyState === Ws.WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('open', () => {
    console.log('[ws] Подключено\n');
    // Инициируем цепочку через count чтобы получить список дисциплин
    send(['join', 'count', ['csgo', 'dota2', 'lol', 'efootball', 'etennis', 'ebasketball', 'ehockey', 'football', 'basketball', 'tennis']]);
  });

  ws.on('message', (raw: Ws.RawData) => {
    try {
      const [model, payload] = JSON.parse(raw.toString());

      // Пропускаем служебные init-сообщения
      if (['version', 'timestamp', 'sessionId'].includes(model)) return;

      if (model === 'config') {
        // config содержит полный список дисциплин
        const disciplines: { id: string }[] = payload?.disciplines ?? [];
        const allIds = disciplines.flatMap((d) => [`2.${d.id}`, `1.${d.id}`]);
        const newIds = allIds.filter((id) => !subscribedDisciplines.has(id));
        newIds.forEach((id) => subscribedDisciplines.add(id));
        console.log(`[config] ${disciplines.length} дисциплин → подписываемся на ${newIds.length} (live+prematch)`);
        if (newIds.length > 0) send(['join', 'discipline', newIds]);
        return;
      }

      if (model === 'error') {
        // Тихо логируем ошибки (напр. "not found" для prematch версии live-матча)
        if (payload?.code !== 106) {
          console.warn(`[error] code=${payload?.code} "${payload?.message}"`);
        }
        return;
      }

      if (model !== 'batch') return;

      for (const item of payload as any[]) {
        const [entityName, entityId, , entityData] = item as [string, string, number, any];

        switch (entityName) {
          case 'count': {
            // Резервный путь если config не пришёл
            const sportsWithEvents: string[] = [];
            for (const [sport, info] of Object.entries(entityData as Record<string, any>)) {
              if ((info as any).live > 0 || (info as any).prematch > 0) {
                sportsWithEvents.push(sport);
              }
            }
            const ids = sportsWithEvents.flatMap((s) => [`2.${s}`, `1.${s}`]);
            const newIds = ids.filter((id) => !subscribedDisciplines.has(id));
            newIds.forEach((id) => subscribedDisciplines.add(id));
            if (newIds.length > 0) {
              console.log(`[count] ${sportsWithEvents.length} спортов с событиями → join discipline (${newIds.length})`);
              send(['join', 'discipline', newIds]);
            }
            break;
          }

          case 'discipline': {
            // entityId вида "2.csgo" или "1.football" → извлекаем имя дисциплины
            const discName = entityId.split('.').slice(1).join('.'); // "csgo", "football" и т.д.

            const tournamentIds: string[] = entityData?.tournamentIds ?? [];
            const newTournaments = tournamentIds
              .filter((id) => id && !subscribedTournaments.has(id))
              .slice(0, MAX_TOURNAMENTS_PER_DISCIPLINE);

            if (newTournaments.length > 0) {
              newTournaments.forEach((id) => {
                subscribedTournaments.add(id);
                tournamentDiscipline.set(id, discName);
              });
              console.log(`[discipline] ${entityId.slice(0, 20)} → ${newTournaments.length} турниров`);
              send(['join', 'tournament', newTournaments]);
            }
            break;
          }

          case 'tournament': {
            if (totalEventsJoined >= MAX_TOTAL_EVENTS) break;

            const discFromTournament = tournamentDiscipline.get(entityId) ?? '?';
            const eventIds: string[] = entityData?.eventIds ?? [];
            // Пропускаем outright события (турнирные ставки, не матчи)
            const newEvents = eventIds
              .filter((id) => id && !id.startsWith('outright') && !subscribedEvents.has(id))
              .slice(0, MAX_EVENTS_PER_TOURNAMENT);

            if (newEvents.length > 0) {
              newEvents.forEach((id) => {
                subscribedEvents.add(id);
                // Сохраняем дисциплину для события через tournamentDiscipline
                tournamentDiscipline.set(id, discFromTournament);
              });
              totalEventsJoined += newEvents.length;
              console.log(`[tournament] ${entityId} [${discFromTournament}] → ${newEvents.length} events (total=${totalEventsJoined})`);
              for (const eid of newEvents) {
                send(['join', 'event', eid]);
              }
            }
            break;
          }

          case 'event': {
            if (!entityData) break;

            // Пропускаем outright (турниры/чемпионаты)
            if (entityId.startsWith('outright')) break;

            // Берём дисциплину из маппинга (сохранили при подписке на tournament)
            const discipline = tournamentDiscipline.get(entityId)
              ?? entityData.disciplineId
              ?? entityId.split('.')[1]
              ?? '?';

            const eventInfo: EventInfo = {
              id: entityId,
              name: entityData.name ?? entityId,
              discipline,
              status: entityData.status ?? 0,
              startTime: entityData.startTime,
            };
            events.set(entityId, eventInfo);

            // Получаем ID маркета Match Winner
            const marketId: string | null =
              entityData.matchWinnerId ??
              (entityData.mainMarketIds ?? []).find((id: string | null) => id) ??
              null;

            if (marketId && !subscribedMarkets.has(marketId)) {
              subscribedMarkets.add(marketId);
              eventInfo.marketId = marketId;
              send(['join', 'market', [marketId]]);
            }
            break;
          }

          case 'market': {
            if (!entityData?.outcomes) break;

            // Находим event для этого маркета
            const eventId = entityData.pid ?? entityData.eventId;
            const ev = events.get(eventId ?? '') ?? events.get(entityId.split('.').slice(0, -1).join('.')) ?? null;

            const outcomes: any[] = entityData.outcomes;
            const active = outcomes.filter((o) => !o.isFrozen);
            if (active.length < 2) break;

            // Названия исходов
            const outcomeNames: string[] = active.map((o, i) => {
              if (o.name) return o.name;
              if (ev) {
                const parts = ev.name.split(' vs ');
                return i === 0 ? (parts[0]?.trim() ?? 'Home') : (parts[1]?.trim() ?? 'Away');
              }
              return `Outcome${i + 1}`;
            });

            const marketInfo: MarketInfo = {
              marketId: entityId,
              eventId: eventId ?? '',
              name: ev?.name ?? entityData.name ?? entityId,
              outcomes: active.map((o, i) => ({
                name: outcomeNames[i],
                price: o.price,
              })),
            };
            markets.set(entityId, marketInfo);

            const prefix = ev?.status === 3 ? '[LIVE]' : '[PRE] ';
            const disc = ev?.discipline ?? '?';
            const oddsStr = marketInfo.outcomes.map((o) => `${o.name} ${o.price.toFixed(2)}`).join('  |  ');
            console.log(`${prefix} [${disc.padEnd(8)}] ${marketInfo.name.slice(0, 35).padEnd(35)} ${oddsStr}`);
            break;
          }
        }
      }
    } catch (err: any) {
      console.warn('[parse error]', err.message);
    }
  });

  ws.on('error', (err) => console.error('[ws] error:', err.message));
  ws.on('close', (code) => {
    console.log(`\n[ws] Закрыто: ${code}`);
    printSummary();
    process.exit(0);
  });

  // Периодическая сводка
  const summaryTimer = setInterval(printSummary, SUMMARY_INTERVAL_MS);

  setTimeout(() => {
    clearInterval(summaryTimer);
    console.log(`\n[timeout] ${TIMEOUT_MS / 1000}с истекло`);
    printSummary();
    ws.close();
    process.exit(0);
  }, TIMEOUT_MS);
}

main().catch((err) => {
  console.error('Fatal:', err.response?.data ?? err.message);
  process.exit(1);
});
