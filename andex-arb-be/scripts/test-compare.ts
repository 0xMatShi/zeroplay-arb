/**
 * Сравнение коэффициентов DexSport vs Polymarket
 * Матч: MOUZ vs Heroic (CS:GO)
 *
 * DexSport:   https://dexsport.io/esports/csgo/mouz-vs-heroic-33944196/bets/
 * Polymarket: https://polymarket.com/sports/counter-strike/cs2-mouz-hero-2026-03-06
 *
 * Запуск: npx ts-node scripts/test-compare.ts
 */

import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';

// ── DexSport ──────────────────────────────────────────────────
const DEXSPORT_BASE = 'https://prod.dexsport.work';
const DEXSPORT_WS   = 'wss://prod.dexsport.work/ws';
const DEXSPORT_API_KEY = 'ta-dexsport';

// Числовой ID матча из URL (live = префикс 2, prematch = 1)
const DEXSPORT_EVENT_ID = '2.33944196';

// ── Polymarket ────────────────────────────────────────────────
const POLYMARKET_GAMMA   = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB    = 'https://clob.polymarket.com';
const POLYMARKET_CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const POLYMARKET_SLUG    = 'cs2-mouz-hero-2026-03-06';

// ── Типы ──────────────────────────────────────────────────────

interface TeamOdds {
  name: string;
  /** вероятность 0..1 */
  prob: number;
}

interface PlatformState {
  teams: TeamOdds[];
}

const state: { dexsport: PlatformState | null; polymarket: PlatformState | null } = {
  dexsport: null,
  polymarket: null,
};

// ── Форматирование ────────────────────────────────────────────

function decimal(prob: number): string {
  return prob > 0 ? (1 / prob).toFixed(3) : '   ?';
}

function pct(prob: number): string {
  return (prob * 100).toFixed(1).padStart(5) + '%';
}

function row(name: string, prob: number): string {
  return `  ${name.padEnd(28)} ${pct(prob)}   ${decimal(prob)}`;
}

// ── Сравнение и арбитраж ──────────────────────────────────────

/**
 * Нечёткое совпадение имён команд: нормализуем и проверяем включение.
 */
function teamsMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = norm(a), nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

function printComparison(): void {
  const d = state.dexsport;
  const p = state.polymarket;

  console.log('\n' + '═'.repeat(65));
  console.log('  СРАВНЕНИЕ   |  %prob    | decimal odds');
  console.log('═'.repeat(65));

  if (d) {
    console.log('\nDexSport (букмекер, overround ~108%):');
    d.teams.forEach((t) => console.log(row(t.name, t.prob)));
    const sum = d.teams.reduce((s, t) => s + t.prob, 0);
    console.log(`  ${'Сумма (overround):'.padEnd(28)} ${pct(sum)}`);
  } else {
    console.log('\nDexSport: ожидание...');
  }

  if (p) {
    console.log('\nPolymarket (предикшн маркет):');
    p.teams.forEach((t) => console.log(row(t.name, t.prob)));
    const sum = p.teams.reduce((s, t) => s + t.prob, 0);
    console.log(`  ${'Сумма:'.padEnd(28)} ${pct(sum)}`);
  } else {
    console.log('\nPolymarket: ожидание...');
  }

  if (!d || !p) {
    console.log('\n' + '─'.repeat(65));
    return;
  }

  // ── Матчинг команд по имени ───────────────────────────────
  console.log('\nМАТЧИНГ КОМАНД:');

  // Для каждой команды с DexSport — ищем пару на Polymarket
  const matched: { dex: TeamOdds; poly: TeamOdds }[] = [];
  const unmatchedPoly = new Set(p.teams.map((_, i) => i));

  for (const dTeam of d.teams) {
    const polyIdx = p.teams.findIndex((pt) => teamsMatch(dTeam.name, pt.name));
    if (polyIdx !== -1) {
      matched.push({ dex: dTeam, poly: p.teams[polyIdx] });
      unmatchedPoly.delete(polyIdx);
    } else {
      console.log(`  [!] DexSport "${dTeam.name}" — не найдена пара на Polymarket`);
    }
  }
  unmatchedPoly.forEach((i) => {
    console.log(`  [!] Polymarket "${p.teams[i].name}" — не найдена пара на DexSport`);
  });

  if (matched.length < 2) {
    console.log('  Недостаточно совпадений для расчёта арбитража');
    console.log('\n' + '─'.repeat(65));
    return;
  }

  // ── Арбитраж ─────────────────────────────────────────────
  console.log('\nАРБИТРАЖ (покупаем каждый исход на платформе с меньшей ценой):');

  let totalCost = 0;
  const legs: string[] = [];

  for (const { dex, poly } of matched) {
    const dexOdds  = dex.prob;
    const polyOdds = poly.prob;

    if (dexOdds < polyOdds) {
      // DexSport дешевле
      legs.push(`  Купить "${dex.name}" на DexSport:    ${pct(dexOdds)}  (${decimal(dexOdds)})`);
      totalCost += dexOdds;
    } else {
      // Polymarket дешевле
      legs.push(`  Купить "${poly.name}" на Polymarket: ${pct(polyOdds)}  (${decimal(polyOdds)})`);
      totalCost += polyOdds;
    }
  }

  legs.forEach((l) => console.log(l));
  console.log(`\n  Суммарная стоимость: ${pct(totalCost)}`);

  if (totalCost < 1) {
    const profit = (1 - totalCost) * 100;
    console.log(`  ✓ АРБИТРАЖ! Прибыль: ${profit.toFixed(2)}% с каждого $1 инвестиций`);
  } else {
    console.log(`  ✗ Арбитража нет (суммарная стоимость > 100%)`);
  }

  console.log('\n' + '─'.repeat(65));
}

// ══════════════════════════════════════════════════════════════
// DexSport
// ══════════════════════════════════════════════════════════════

async function getDexsportToken(): Promise<string> {
  // guest: true — без авторизации, как анонимный пользователь на сайте
  const { data } = await axios.post(`${DEXSPORT_BASE}/public/api/profile`, {
    apiKey: DEXSPORT_API_KEY,
    visitorId: randomUUID().replace(/-/g, ''),
    guest: true,
  }, { timeout: 10_000 });

  console.log(`[dexsport] Токен получен (guest=${data.guest ?? true})`);
  if (!data.token) throw new Error('DexSport: нет токена');
  return data.token;
}

function buildTimestamp(): string {
  return Buffer.from(JSON.stringify({ now: new Date().toISOString(), expired: false }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function connectDexsport(): Promise<void> {
  console.log('[dexsport] Получаем токен...');
  const token = await getDexsportToken();
  console.log('[dexsport] Токен получен');

  const query = new URLSearchParams({
    cid: DEXSPORT_API_KEY, lang: 'en',
    timestamp: buildTimestamp(), token, format: 'long',
  });

  const ws = new Ws.WebSocket(`${DEXSPORT_WS}?${query}`);
  const subscribedMarkets = new Set<string>();
  let eventName = '';

  const send = (msg: unknown) => {
    if (ws.readyState === Ws.WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('open', () => {
    console.log('[dexsport] WS подключён');
    send(['join', 'event', DEXSPORT_EVENT_ID]);
    send(['join', 'event', DEXSPORT_EVENT_ID.replace('2.', '1.')]);
  });

  ws.on('message', (raw: Ws.RawData) => {
    try {
      const str = raw.toString();
      const [model, payload] = JSON.parse(str);

      if (model !== 'batch') {
        console.log(`[dexsport ← ${model}] ${JSON.stringify(payload).slice(0, 200)}`);
        return;
      }

      for (const item of payload as any[]) {
        const [entityName, entityId, , entityData] = item as [string, string, number, any];

        if (entityName === 'event') {
          console.log(`[dexsport batch:event] id=${entityId} RAW: ${JSON.stringify(entityData).slice(0, 300)}`);

          if (entityData?.name && !eventName) {
            eventName = entityData.name;
            const parts = eventName.split(' vs ');
            console.log(`[dexsport] Событие: "${eventName}"`);
            console.log(`  Home: "${parts[0]?.trim()}"  Away: "${parts[1]?.trim()}"`);
          }

          const mainMarketId: string | null =
            entityData?.matchWinnerId ??
            (entityData?.mainMarketIds ?? []).find((id: string | null) => id !== null) ??
            null;

          if (mainMarketId && !subscribedMarkets.has(mainMarketId)) {
            subscribedMarkets.add(mainMarketId);
            console.log(`[dexsport] Подписываемся на маркет: ${mainMarketId}`);
            send(['join', 'market', [mainMarketId]]);
          }
        }

        if (entityName === 'market') {
          console.log(`[dexsport batch:market] id=${entityId} RAW: ${JSON.stringify(entityData).slice(0, 300)}`);

          if (!entityData?.outcomes) continue;

          const outcomes: any[] = entityData.outcomes;
          console.log(`  Все аутком (${outcomes.length}):`);
          outcomes.forEach((o) => {
            console.log(`    lid=${o.lid}  price=${o.price}  status=${o.status}  frozen=${o.isFrozen}`);
          });

          // Берём незамороженные аутком (убрали фильтр status === 3)
          const active = outcomes.filter((o) => !o.isFrozen);
          if (active.length < 2) {
            console.log(`  [!] Только ${active.length} активных аутком — пропускаем`);
            continue;
          }

          // Берём имена команд из event.name
          const nameParts = eventName.split(' vs ');
          const homeTeam = nameParts[0]?.trim() ?? 'Home';
          const awayTeam = nameParts[1]?.trim() ?? 'Away';

          const teamNames =
            active.length === 3
              ? [homeTeam, 'Draw', awayTeam]
              : [homeTeam, awayTeam];

          console.log(`\n[dexsport] Маркет обновлён (${active.length} аутком):`);
          active.forEach((o, i) => {
            console.log(`  ${teamNames[i]?.padEnd(28)} ${pct(1/o.price)}   ${o.price.toFixed(3)}`);
          });

          state.dexsport = {
            teams: active.map((o, i) => ({
              name: teamNames[i] ?? `Team${i}`,
              prob: o.price > 0 ? 1 / o.price : 0,
            })),
          };

          printComparison();
        }

        if (!['event', 'market', 'count', 'discipline', 'tournament', 'scoreboard'].includes(entityName)) {
          console.log(`[dexsport batch:?] type=${entityName} id=${entityId} RAW: ${JSON.stringify(entityData).slice(0, 150)}`);
        }
      }
    } catch (err: any) {
      console.warn('[dexsport] parse error:', err.message);
    }
  });

  ws.on('error', (err) => console.error('[dexsport] WS error:', err.message));
  ws.on('close', (code) => console.log(`[dexsport] WS закрыт: ${code}`));
}

// ══════════════════════════════════════════════════════════════
// Polymarket
// ══════════════════════════════════════════════════════════════

async function connectPolymarketWs(tokenIds: string[], market: any): Promise<void> {
  const outcomeNames: string[] = JSON.parse(market.outcomes ?? '[]');

  const ws = new Ws.WebSocket(POLYMARKET_CLOB_WS, {
    headers: { 'Origin': 'https://polymarket.com' },
  });

  ws.on('open', () => {
    console.log('[polymarket WS] Подключён');
    ws.send(JSON.stringify({ auth: {}, assets_ids: tokenIds, type: 'market' }));

    setInterval(() => {
      if (ws.readyState === Ws.WebSocket.OPEN) ws.ping();
    }, 10_000);
  });

  ws.on('message', (raw: Ws.RawData) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of items) {
        if (msg.event_type !== 'book') continue;

        const tokenId: string = msg.asset_id ?? '';
        const idx = tokenIds.indexOf(tokenId);
        if (idx === -1) continue;

        const bids: any[] = [...(msg.bids ?? [])].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        const asks: any[] = [...(msg.asks ?? [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        const bestAsk = asks[0];
        const bestBid = bids[0];

        if (!bestAsk && !bestBid) continue;

        // mid price как лучшая оценка вероятности
        const midPrice = bestBid && bestAsk
          ? (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2
          : parseFloat(bestAsk?.price ?? bestBid?.price ?? '0');

        console.log(`[polymarket WS] book "${outcomeNames[idx]}"  bid=${bestBid?.price ?? '?'}  ask=${bestAsk?.price ?? '?'}  mid=${midPrice.toFixed(3)}  (${decimal(midPrice)})`);

        // Обновляем состояние — только если уже инициализировано
        if (state.polymarket) {
          const t = state.polymarket.teams.find((t) => t.name === outcomeNames[idx]);
          if (t) {
            t.prob = midPrice;
            printComparison();
          }
        }
      }
    } catch { /* ignore */ }
  });

  ws.on('error', (err) => console.error('[polymarket WS] error:', err.message));
  ws.on('close', (code) => console.log(`[polymarket WS] закрыт: ${code}`));
}

async function fetchPolymarket(): Promise<void> {
  console.log(`[polymarket] Запрашиваем маркет: ${POLYMARKET_SLUG}`);

  // Пробуем через /markets напрямую (быстрее чем /events)
  const { data } = await axios.get(`${POLYMARKET_GAMMA}/markets`, {
    params: { slug: POLYMARKET_SLUG },
    timeout: 10_000,
  });

  const markets: any[] = Array.isArray(data) ? data : (data.data ?? []);
  if (markets.length === 0) throw new Error(`Маркет не найден: ${POLYMARKET_SLUG}`);

  const market = markets[0];
  const outcomeNames: string[] = JSON.parse(market.outcomes ?? '[]');
  const outcomePrices: string[] = JSON.parse(market.outcomePrices ?? '[]');
  const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? '[]');

  // Живые данные из маркета
  const eventInfo = market.events?.[0] ?? {};
  console.log(`[polymarket] "${market.question}"`);
  console.log(`  live=${eventInfo.live ?? market.live ?? '?'}  score="${eventInfo.score ?? market.score ?? '?'}"  period="${eventInfo.period ?? market.period ?? '?'}"`);
  console.log(`  bestBid=${market.bestBid ?? '?'} (${decimal(market.bestBid ?? 0)})  bestAsk=${market.bestAsk ?? '?'} (${decimal(market.bestAsk ?? 0)})`);

  console.log('\n[polymarket] Аутком:');
  outcomeNames.forEach((name, i) => {
    const p = parseFloat(outcomePrices[i] ?? '0');
    console.log(`  ${name.padEnd(28)} ${pct(p)}   ${decimal(p)}`);
  });

  state.polymarket = {
    teams: outcomeNames.map((name, i) => ({
      name,
      prob: parseFloat(outcomePrices[i] ?? '0'),
    })),
  };

  printComparison();

  // WS для live-обновлений
  if (tokenIds.length > 0) {
    await connectPolymarketWs(tokenIds, market);
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('Матч: MOUZ vs Heroic (CS:GO)');
  console.log('DexSport event: ' + DEXSPORT_EVENT_ID);
  console.log('Polymarket slug: ' + POLYMARKET_SLUG);
  console.log('─'.repeat(65) + '\n');

  await Promise.all([
    connectDexsport().catch((err) => console.error('[dexsport] Fatal:', err.message)),
    fetchPolymarket().catch((err) => console.error('[polymarket] Fatal:', err.message)),
  ]);

  setTimeout(() => {
    console.log('\n[timeout] 5 минут истекло');
    process.exit(0);
  }, 5 * 60_000);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
