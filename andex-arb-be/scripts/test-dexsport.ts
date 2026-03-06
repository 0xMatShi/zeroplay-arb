/**
 * Тест интеграции с DexSport
 * Запуск: npx ts-node scripts/test-dexsport.ts
 *
 * Шаги:
 * 1. Получаем guest-токен через POST /public/api/profile
 * 2. Подключаемся к WebSocket
 * 3. Подписываемся на count → discipline → event → market
 * 4. Логируем структуру данных с коэффициентами
 */

import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL = 'wss://prod.dexsport.work/ws';
const API_KEY = 'ta-dexsport';
const LANG = 'en';

const SPORTS = ['csgo', 'dota2', 'efootball', 'lol', 'etennis', 'ebasketball', 'ehockey'];

// Если есть hash пользователя из mainnet.dexsport.io — используем его для аутентификации.
// Иначе — guest режим.
// hash берётся из Local Storage: presist user → address_info → hash
const USER_HASH = '4af7bd19b431375b0ae72894112f12d2'; // твой hash из Local Storage

// ────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const partnerToken = USER_HASH ? `${USER_HASH}_binance_usdt_sportsbook` : undefined;

  console.log('[auth] Запрашиваем токен...', partnerToken ? '(authenticated)' : '(guest)');

  const body: Record<string, unknown> = {
    apiKey: API_KEY,
    visitorId: randomUUID().replace(/-/g, ''),
  };

  if (partnerToken) {
    body.token = partnerToken;
  } else {
    body.guest = true;
  }

  const { data } = await axios.post(`${BASE_URL}/public/api/profile`, body);

  console.log('[auth] OK:', {
    id: data.id,
    guest: data.guest,
    currency: data.currency?.name,
    token: data.token?.slice(0, 50) + '...',
  });

  if (!data.token) throw new Error('Токен не получен в ответе');
  return data.token;
}

function buildTimestamp(): string {
  return Buffer.from(
    JSON.stringify({
      now: new Date().toISOString(),
      expired: false,
      exp: new Date(Date.now() + 600_000).toISOString(),
      rcv: new Date().toISOString(),
    }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

async function main() {
  const token = await getToken();

  const query = new URLSearchParams({
    cid: API_KEY,
    lang: LANG,
    timestamp: buildTimestamp(),
    token,
    format: 'long',
  });

  console.log(`\n[ws] Подключаемся...`);
  const ws = new Ws.WebSocket(`${WS_URL}?${query}`);

  let marketCount = 0;
  const MAX_MARKETS = 5;

  let disciplinesJoined = false;
  const subscribedTournaments = new Set<string>();
  const subscribedEvents = new Set<string>();
  const subscribedMarkets = new Set<string>();

  const send = (msg: unknown) => {
    ws.send(JSON.stringify(msg));
    const preview = JSON.stringify(msg).slice(0, 120);
    console.log(`[→] ${preview}`);
  };

  ws.on('open', () => {
    console.log('[ws] Соединение установлено\n');
    send(['join', 'count', SPORTS]);
  });

  ws.on('message', (raw: Ws.RawData) => {
    const str = raw.toString();
    const [model, payload] = JSON.parse(str);

    // Логируем все НЕ-batch сообщения для отладки
    if (model !== 'batch') {
      console.log(`[← ${model}]`, JSON.stringify(payload).slice(0, 200));

      // config содержит список дисциплин — используем его если count не пришёл
      if (model === 'config' && !disciplinesJoined) {
        disciplinesJoined = true;
        const disciplines: { id: string }[] = payload?.disciplines ?? [];
        const disciplineIds = disciplines.flatMap((d) => [`2.${d.id}`, `1.${d.id}`]);
        console.log(`\n[config] Подписываемся на ${disciplineIds.length} дисциплин: ${disciplineIds.slice(0, 8).join(', ')}...`);
        send(['join', 'count', SPORTS]);
        send(['join', 'discipline', disciplineIds]);
      }

      return;
    }

    for (const item of payload as any[]) {
      // Логируем тип каждого элемента батча чтобы видеть что приходит
      const entityName = item[0];

      // Для неизвестных типов — печатаем сырые данные
      if (!['count', 'discipline', 'event', 'market', 'scoreboard', 'tournament'].includes(entityName)) {
        console.log(`[batch:?] ${JSON.stringify(item).slice(0, 120)}`);
        continue;
      }

      // Все batch-элементы: ["type", id, version, data]
      const entityId = item[1];
      const entityData = item[3];

      switch (entityName) {
        case 'count': {
          // Подписываемся на дисциплины только один раз
          if (disciplinesJoined) break;
          disciplinesJoined = true;

          console.log('\n[count] RAW:', JSON.stringify(entityData).slice(0, 300));
          console.log('[count] Live события по спортам:');

          const sportsWithLive: string[] = [];
          for (const [sport, info] of Object.entries(entityData as Record<string, any>)) {
            if ((info as any).live > 0) {
              console.log(`  ${sport}: live=${(info as any).live}`);
              sportsWithLive.push(sport);
            }
          }

          // Пробуем все варианты: "2.csgo" (live), "1.csgo" (prematch), "csgo" (без префикса)
          const disciplineIds = sportsWithLive.flatMap((s) => [`2.${s}`, `1.${s}`]);
          console.log(`\n[→] joining ${disciplineIds.length} disciplines: ${disciplineIds.join(', ')}`);
          send(['join', 'discipline', disciplineIds]);
          break;
        }

        case 'discipline': {
          const tournamentIds: string[] = entityData?.tournamentIds ?? [];
          if (!tournamentIds.length) break;

          // Берём максимум 2 турнира на дисциплину
          const newTournaments = tournamentIds
            .filter((id) => !subscribedTournaments.has(id))
            .slice(0, 2);
          if (!newTournaments.length) break;

          newTournaments.forEach((id) => subscribedTournaments.add(id));
          console.log(`\n[discipline] ${entityId} → tournaments: ${newTournaments.join(', ')}`);
          send(['join', 'tournament', newTournaments]);
          break;
        }

        case 'tournament': {
          const eventIds: string[] = entityData?.eventIds ?? [];
          if (!eventIds.length) break;

          const newEvents = eventIds.filter((id) => !subscribedEvents.has(id)).slice(0, 2);
          if (!newEvents.length) break;

          newEvents.forEach((id) => subscribedEvents.add(id));
          console.log(`\n[tournament] ${entityId} → events: ${newEvents.join(', ')}`);
          for (const eventId of newEvents) {
            send(['join', 'event', eventId]);
          }
          break;
        }

        case 'event': {
          console.log(`\n[event] RAW id=${entityId}:`, JSON.stringify(entityData).slice(0, 300));

          const mainMarketIds: string[] = entityData?.mainMarketIds ?? [];
          const marketIds: string[] = entityData?.marketIds ?? [];
          const allMarketIds = [...new Set([...mainMarketIds, ...marketIds])];
          const newMarkets = allMarketIds.filter((id) => id && !subscribedMarkets.has(id)).slice(0, 3);

          console.log(`  name: ${entityData?.name ?? '?'} | status: ${entityData?.status}`);

          if (!newMarkets.length) break;

          newMarkets.forEach((id) => subscribedMarkets.add(id));
          send(['join', 'market', newMarkets]);
          break;
        }

        case 'market': {
          if (marketCount >= MAX_MARKETS) break;
          marketCount++;

          const outcomes: any[] = entityData?.outcomes ?? [];
          const activeOutcomes = outcomes.filter((o) => !o.isFrozen);

          console.log(`\n[market #${marketCount}] ${entityId}`);
          console.log(`  sortIndex: ${entityData?.sortIndex}`);
          console.log(`  outcomes (${outcomes.length} total, ${activeOutcomes.length} active):`);

          for (const o of outcomes) {
            const frozen = o.isFrozen ? ' [FROZEN]' : '';
            console.log(`    lid=${o.lid}  price=${o.price}  status=${o.status}${frozen}`);
          }

          if (marketCount >= MAX_MARKETS) {
            console.log(`\n[done] Получено ${MAX_MARKETS} маркетов. Закрываем.`);
            ws.close();
          }
          break;
        }
      }
    }
  });

  ws.on('error', (err: Error) => console.error('[ws] Ошибка:', err.message));

  ws.on('close', (code: number) => {
    console.log(`\n[ws] Закрыто: ${code}`);
    process.exit(0);
  });

  setTimeout(() => {
    console.log('\n[timeout] 60с истекло');
    ws.close();
  }, 60_000);
}

main().catch((err) => {
  console.error('Ошибка:', err.response?.data ?? err.message);
  process.exit(1);
});
