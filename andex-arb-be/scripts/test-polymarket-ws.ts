/**
 * Тест Polymarket WebSocket каналов для спортивных событий
 *
 * Два отдельных канала:
 *  1. CLOB WS   — wss://ws-subscriptions-clob.polymarket.com/ws/market  (цены/книга ордеров)
 *  2. Sports WS — wss://sports-api.polymarket.com/ws                    (счёт, период, статус матча)
 *
 * Запуск: npx ts-node scripts/test-polymarket-ws.ts
 */

import axios from 'axios';
import * as Ws from 'ws';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Конкретное событие: CS:GO матч KEYD vs FA
const EVENT_SLUG = 'cs2-keyd-fa-2026-03-06';

// ── Step 1: Получаем tokenIds через REST ──────────────────────

async function fetchMarketTokenIds(): Promise<{ tokenIds: string[]; market: any }> {
  console.log(`[rest] Ищем событие: ${EVENT_SLUG}`);

  const { data: events } = await axios.get(`${GAMMA_API}/events`, {
    params: { slug: EVENT_SLUG },
    timeout: 10_000,
  });

  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`Событие не найдено: ${EVENT_SLUG}`);
  }

  const event = events[0];
  const markets: any[] = event.markets ?? [];

  if (markets.length === 0) {
    throw new Error('Нет маркетов в событии');
  }

  // Выбираем маркет с наибольшей ликвидностью
  const market = markets.sort(
    (a, b) => parseFloat(b.liquidity ?? '0') - parseFloat(a.liquidity ?? '0'),
  )[0];

  const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? '[]');
  const outcomeNames: string[] = JSON.parse(market.outcomes ?? '[]');
  const outcomePrices: string[] = JSON.parse(market.outcomePrices ?? '[]');

  const eventInfo = market.events?.[0] ?? {};

  console.log(`[rest] Маркет: "${market.question}"`);
  console.log(`[rest] conditionId: ${market.conditionId}`);
  console.log(`[rest] Статус: live=${eventInfo.live ?? '?'}  ended=${eventInfo.ended ?? '?'}  score="${eventInfo.score ?? '?'}"  period="${eventInfo.period ?? '?'}"`);
  console.log(`[rest] bestBid=${market.bestBid ?? '?'} (${toDecimal(market.bestBid)})  bestAsk=${market.bestAsk ?? '?'} (${toDecimal(market.bestAsk)})  lastTrade=${market.lastTradePrice ?? '?'}`);
  console.log(`[rest] Токены (${tokenIds.length}):`);
  tokenIds.forEach((id, i) => {
    const p = parseFloat(outcomePrices[i] ?? '0');
    console.log(`  [${i}] ${outcomeNames[i]}: ${(p*100).toFixed(0)}¢ (${toDecimal(p)})  tokenId=${id.slice(0, 20)}...`);
  });

  return { tokenIds, market };
}

// ── Step 2: Проверяем книгу заявок через REST ─────────────────

function toDecimal(prob: number): string {
  return prob > 0 ? (1 / prob).toFixed(3) : '?';
}

function fmtLevel(prob: string): string {
  const p = parseFloat(prob);
  return `${(p * 100).toFixed(0)}¢  (${toDecimal(p)})`;
}

async function fetchOrderBook(tokenId: string, name: string): Promise<void> {
  console.log(`\n[rest/book] "${name}":`);

  try {
    const { data } = await axios.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId },
      timeout: 10_000,
    });

    const bids: any[] = (data.bids ?? []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks: any[] = (data.asks ?? []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));

    console.log(`  Asks (${asks.length}):`);
    asks.slice(0, 4).forEach((a: any) => console.log(`    ${fmtLevel(a.price).padEnd(18)}  qty=${a.size}`));

    const bestBid = bids[0];
    const bestAsk = asks[0];
    const spread = bestBid && bestAsk
      ? ((parseFloat(bestAsk.price) - parseFloat(bestBid.price)) * 100).toFixed(0) + '¢'
      : '?';
    console.log(`  Last: ${bestBid ? fmtLevel(bestBid.price) : '?'}   Spread: ${spread}`);

    console.log(`  Bids (${bids.length}):`);
    bids.slice(0, 4).forEach((b: any) => console.log(`    ${fmtLevel(b.price).padEnd(18)}  qty=${b.size}`));
  } catch (err: any) {
    console.error(`  Ошибка: ${err.response?.status} ${err.message}`);
  }
}

// ── Step 3: CLOB WebSocket (перебираем варианты подписки) ─────

// Все варианты формата подписки которые стоит попробовать
const SUBSCRIBE_VARIANTS = [
  // Вариант 1: документальный формат
  { label: 'v1 {auth,markets,type}', msg: (ids: string[]) => ({ auth: {}, markets: ids, type: 'market' }) },
  // Вариант 2: assets_ids вместо markets
  { label: 'v2 {assets_ids,type}',   msg: (ids: string[]) => ({ auth: {}, assets_ids: ids, type: 'market' }) },
  // Вариант 3: массив объектов
  { label: 'v3 [{markets,type}]',    msg: (ids: string[]) => [{ auth: {}, markets: ids, type: 'market' }] },
  // Вариант 4: без auth
  { label: 'v4 {markets,type} no auth', msg: (ids: string[]) => ({ markets: ids, type: 'market' }) },
  // Вариант 5: level=2 (price updates без книги)
  { label: 'v5 {markets,type,level:2}', msg: (ids: string[]) => ({ auth: {}, markets: ids, type: 'market', level: 2 }) },
  // Вариант 6: ничего не отправляем — просто слушаем
  { label: 'v6 no subscription (just listen)', msg: (_ids: string[]) => null },
];

let variantIdx = 1; // v2 (assets_ids) — подтверждено что работает

function connectWs(tokenIds: string[], market: any): void {
  const outcomeNames: string[] = JSON.parse(market.outcomes ?? '[]');
  const variant = SUBSCRIBE_VARIANTS[variantIdx];

  console.log(`\n[ws] Подключаемся (${variant.label})...`);

  const ws = new Ws.WebSocket(CLOB_WS, {
    headers: {
      'Origin': 'https://polymarket.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let messageCount = 0;
  const openTime = Date.now(); // для измерения через сколько закрылось

  ws.on('open', () => {
    console.log(`[ws] Открыт (${variant.label})`);

    const msg = variant.msg(tokenIds);
    if (msg !== null) {
      const str = JSON.stringify(msg);
      console.log(`[ws →] ${str.slice(0, 120)}`);
      ws.send(str);
    } else {
      console.log('[ws] Подписку не отправляем — ждём что придёт само');
    }

    pingInterval = setInterval(() => {
      if (ws.readyState === Ws.WebSocket.OPEN) {
        ws.ping();
      }
    }, 10_000);
  });

  ws.on('pong', () => {
    console.log('[ws ←] pong');
  });

  ws.on('message', (raw: Ws.RawData) => {
    messageCount++;
    const str = raw.toString();

    try {
      const parsed = JSON.parse(str);

      // Сообщения приходят либо как объект, либо как массив объектов — нормализуем
      const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of items) {
        const eventType: string = msg.event_type ?? msg.type ?? '?';
        const tokenId: string = msg.asset_id ?? msg.market ?? '?';
        const idx = tokenIds.indexOf(tokenId);
        const name = idx >= 0 ? outcomeNames[idx] : `...${tokenId.slice(-8)}`;

        switch (eventType) {
          case 'book': {
            const bids: any[] = [...(msg.bids ?? [])].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
            const asks: any[] = [...(msg.asks ?? [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
            const bestBid = bids[0];
            const bestAsk = asks[0];
            const spread = bestBid && bestAsk
              ? ((parseFloat(bestAsk.price) - parseFloat(bestBid.price)) * 100).toFixed(0) + '¢'
              : '?';

            console.log(`\n[ws book] "${name}"`);
            console.log(`  Asks (${asks.length}):  best_ask=${bestAsk ? fmtLevel(bestAsk.price) : '?'}  qty=${bestAsk?.size ?? '?'}`);
            console.log(`  Spread: ${spread}`);
            console.log(`  Bids (${bids.length}):  best_bid=${bestBid ? fmtLevel(bestBid.price) : '?'}  qty=${bestBid?.size ?? '?'}`);
            break;
          }

          case 'price_change':
          case 'last_trade_price':
            // пропускаем
            break;

          case 'tick_size_change': {
            console.log(`[ws ← #${messageCount}] tick_size_change  "${name}"  new_tick=${msg.new_tick_size}`);
            break;
          }

          default: {
            console.log(`\n[ws ← #${messageCount}] UNKNOWN type="${eventType}"  RAW: ${JSON.stringify(msg).slice(0, 300)}`);
          }
        }
      }
    } catch {
      console.log(`[ws ← #${messageCount}] (non-JSON): ${str.slice(0, 100)}`);
    }
  });

  ws.on('ping', (data) => {
    console.log(`[ws ← ping] ${data.toString()}`);
    ws.pong(data);
  });

  ws.on('error', (err: Error) => {
    console.error(`[ws] Ошибка: ${err.message}`);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const aliveMs = Date.now() - openTime;
    if (pingInterval) clearInterval(pingInterval);

    console.log(`\n[ws] Закрыто за ${aliveMs}ms: code=${code} reason="${reason.toString()}" messages=${messageCount}`);

    // Переходим к следующему варианту
    variantIdx++;
    if (variantIdx < SUBSCRIBE_VARIANTS.length) {
      console.log(`[ws] Пробуем следующий вариант (${variantIdx + 1}/${SUBSCRIBE_VARIANTS.length})...`);
      setTimeout(() => connectWs(tokenIds, market), 1_000);
    } else {
      console.log('\n[ws] Все варианты исчерпаны. Итог: CLOB WS не работает без авторизации.');
      console.log('[ws] Рекомендация: использовать REST /book для получения цен.');
    }
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // 1. Получаем маркет данные через REST
  const { tokenIds, market } = await fetchMarketTokenIds();

  // 2. Сразу проверяем книгу заявок через REST (без WS)
  const outcomeNames: string[] = JSON.parse(market.outcomes ?? '[]');
  for (let i = 0; i < tokenIds.length; i++) {
    await fetchOrderBook(tokenIds[i], outcomeNames[i] ?? `token${i}`);
  }

  // 3. CLOB WS — перебираем варианты подписки
  connectWs(tokenIds, market);

  // Ждём 2 минуты
  setTimeout(() => {
    console.log('\n[timeout] 2 минуты истекло');
    process.exit(0);
  }, 2 * 60_000);
}

main().catch((err) => {
  console.error('Fatal:', err.response?.data ?? err.message);
  process.exit(1);
});
