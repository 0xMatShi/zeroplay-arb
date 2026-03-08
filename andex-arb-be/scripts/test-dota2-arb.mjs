/**
 * Test script: monitor Polymarket + DexSport prices for a specific Dota2 match
 * and detect arbitrage in real-time.
 *
 * PM event:  https://polymarket.com/sports/dota-2/dota2-tundra-yes-2026-03-08
 * DEX event: https://dexsport.io/esports/dota2/tundra-vs-yellow-submarine-33999461/bets/
 *
 * Uses the same tag/market mapping as sports-constants.ts:
 *   PM tag:     dota-2
 *   DEX slug:   dota2
 *   moneyline       → Match Winner
 *   child_moneyline → Winner. Map N  (dynamic)
 *   map_handicap    → Maps Handicap
 *   totals          → Total maps
 *
 * Usage: node scripts/test-dota2-arb.mjs
 */

import https from 'https';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────────

const PM_GAMMA   = 'https://gamma-api.polymarket.com';
const PM_CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PM_SLUG    = 'dota2-tundra-yes-2026-03-08';
const PM_TAG     = 'dota-2';          // from PM_TAG_TO_SPORT in sports-constants.ts

const DEX_BASE    = 'https://prod.dexsport.work';
const DEX_WS      = 'wss://prod.dexsport.work/ws';
const DEX_API_KEY = 'ta-dexsport';
const DEX_SLUG    = 'dota2';          // from DEX_SLUG_TO_SPORT in sports-constants.ts
// Event ID from URL: 33999461. Live events start with '2.', pre-match with '1.'
const DEX_EVENT_IDS = ['2.33999461', '1.33999461'];

// From MARKET_MAP.dota2 in sports-constants.ts
const DOTA2_MARKET_MAP = {
  moneyline:       ['Match Winner'],
  child_moneyline: [],                // dynamic: "Winner. Map N"
  map_handicap:    ['Maps Handicap'],
  totals:          ['Total maps'],
};

const MIN_PROFIT_PCT = 0.1;

// ── Shared state ────────────────────────────────────────────────

// tokenId → { outcomeName, conditionId, marketType, price }
const pmTokens = new Map();
// marketId → { name, outcomes: [{name, price}] }
const dexMarkets = new Map();

// ── Utilities ───────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}\nBody: ${data.slice(0, 300)}`)); }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}\nBody: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Market type matching (mirrors sports-matcher.service.ts logic) ──

/**
 * Returns expected DEX market names for a given PM sportsMarketType.
 * For child_moneyline the match is done by regex since DEX name is dynamic.
 */
function getDexNamesForPmType(pmType) {
  if (pmType === 'child_moneyline') return null; // handled separately
  return DOTA2_MARKET_MAP[pmType] ?? null;
}

function isDexMatchForPmType(pmType, dexName) {
  if (!dexName) return false;
  const lower = dexName.toLowerCase();

  if (pmType === 'child_moneyline') {
    // "Winner. Map N" pattern
    return /winner\.?\s*map\s*\d/i.test(dexName) || lower.includes('winner. map');
  }

  const expected = DOTA2_MARKET_MAP[pmType];
  if (!expected || expected.length === 0) return false;
  return expected.some((e) => lower === e.toLowerCase());
}

// ── Arbitrage calculator ─────────────────────────────────────────

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchOutcomes(pmOutcomes, dexOutcomes) {
  const legs = [];
  for (const pmO of pmOutcomes) {
    const pmNorm = norm(pmO.outcomeName);
    let dexO = dexOutcomes.find((d) => norm(d.name) === pmNorm);
    if (!dexO) {
      dexO = dexOutcomes.find((d) => {
        const dn = norm(d.name);
        return dn.includes(pmNorm) || pmNorm.includes(dn);
      });
    }
    if (!dexO && dexOutcomes.length === 2) {
      const lower = pmO.outcomeName.toLowerCase();
      if (lower === 'yes' || lower === 'over') dexO = dexOutcomes[0];
      else if (lower === 'no' || lower === 'under') dexO = dexOutcomes[1];
    }
    if (!dexO) return null;

    const pmProb  = pmO.price;
    const dexProb = dexO.price > 0 ? 1 / dexO.price : 1;

    if (pmProb <= dexProb) {
      legs.push({ platform: 'PM', outcome: pmO.outcomeName, prob: pmProb });
    } else {
      legs.push({ platform: 'DEX', outcome: dexO.name, prob: dexProb, odds: dexO.price });
    }
  }
  return legs.length >= 2 ? legs : null;
}

function computeArb() {
  if (pmTokens.size === 0 || dexMarkets.size === 0) return;

  // Group PM tokens by conditionId
  const pmByCondition = new Map();
  for (const [tokenId, info] of pmTokens) {
    if (!pmByCondition.has(info.conditionId)) {
      pmByCondition.set(info.conditionId, []);
    }
    pmByCondition.get(info.conditionId).push({ tokenId, ...info });
  }

  const lines = [];
  lines.push(`\n${'═'.repeat(72)}`);
  lines.push(`[${ts()}] PRICES SUMMARY`);
  lines.push('═'.repeat(72));

  lines.push('\nPOLYMARKET:');
  for (const [conditionId, outcomes] of pmByCondition) {
    const pmType = outcomes[0]?.marketType ?? '?';
    const dexNames = getDexNamesForPmType(pmType);
    const dexHint  = dexNames ? ` → DEX:"${dexNames.join('/')}"` : (pmType === 'child_moneyline' ? ' → DEX:"Winner. Map N"' : '');
    lines.push(`  [${pmType}${dexHint}]  cond=${conditionId.slice(0, 10)}...`);
    for (const o of outcomes) {
      lines.push(`    ${o.outcomeName.padEnd(22)} $${o.price.toFixed(3)}`);
    }
  }

  lines.push('\nDEXSPORT:');
  for (const [mid, m] of dexMarkets) {
    lines.push(`  [${m.name}]  marketId=${mid}`);
    for (const o of m.outcomes) {
      const prob = o.price > 0 ? 1 / o.price : 0;
      lines.push(`    ${o.name.padEnd(22)} odds=${o.price.toFixed(3)}  prob=$${prob.toFixed(3)}`);
    }
  }

  lines.push('\nARBITRAGE CHECK:');
  let foundArb = false;

  for (const [conditionId, pmOutcomes] of pmByCondition) {
    const pmType = pmOutcomes[0]?.marketType ?? '';

    for (const [mid, dexMarket] of dexMarkets) {
      // Filter by expected market name from MARKET_MAP
      if (!isDexMatchForPmType(pmType, dexMarket.name)) continue;

      const legs = matchOutcomes(pmOutcomes, dexMarket.outcomes);
      if (!legs) {
        lines.push(`  [${pmType}] vs DEX[${dexMarket.name}]: ⚠️  outcome names don't match`);
        continue;
      }

      const totalCost   = legs.reduce((s, l) => s + l.prob, 0);
      const profitPct   = totalCost < 1 ? ((1 - totalCost) / totalCost) * 100 : 0;
      const marker      = profitPct >= MIN_PROFIT_PCT ? '✅ ARB' : '❌ no arb';

      lines.push(`  [${pmType}] vs DEX[${dexMarket.name}]  totalCost=${totalCost.toFixed(4)}  profit=${profitPct.toFixed(2)}%  ${marker}`);
      for (const l of legs) {
        if (l.platform === 'PM') {
          lines.push(`    PM  ${l.outcome.padEnd(22)} prob=$${l.prob.toFixed(3)}`);
        } else {
          lines.push(`    DEX ${l.outcome.padEnd(22)} odds=${l.odds?.toFixed(3)}  prob=$${l.prob.toFixed(3)}`);
        }
      }
      if (profitPct >= MIN_PROFIT_PCT) foundArb = true;
    }
  }

  if (!foundArb) lines.push('  (no profitable arb at current prices)');
  lines.push('');
  console.log(lines.join('\n'));
}

// ── Polymarket ───────────────────────────────────────────────────

async function startPolymarket() {
  // Try by slug first; if not found, fall back to tag_slug search
  console.log(`[PM] Fetching event by slug: ${PM_SLUG}`);
  let events = await fetchJson(`${PM_GAMMA}/events?slug=${PM_SLUG}`);

  if (!events?.length) {
    console.log(`[PM] Slug not found, searching by tag: ${PM_TAG}`);
    events = await fetchJson(
      `${PM_GAMMA}/events?active=true&closed=false&tag_slug=${PM_TAG}&limit=100`
    );
    // filter by slug substring
    events = (events ?? []).filter(
      (e) => e.slug?.includes('tundra') || e.title?.toLowerCase().includes('tundra')
    );
    if (!events.length) {
      console.error('[PM] Event not found. It may have ended or the slug changed.');
      return;
    }
  }

  const event = events[0];
  console.log(`[PM] Found: "${event.title}" (id=${event.id}, slug=${event.slug})`);

  const markets = (event.markets ?? []).filter((m) => m.sportsMarketType);
  if (!markets.length) {
    console.error('[PM] No sports markets on this event.');
    return;
  }

  console.log(`[PM] ${markets.length} sports markets:`);
  const allTokenIds = [];

  for (const m of markets) {
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const outcomes  = JSON.parse(m.outcomes || '[]');
    const prices    = JSON.parse(m.outcomePrices || '[]');

    // label DEX equivalents for context
    const dexNames = getDexNamesForPmType(m.sportsMarketType);
    const dexHint  = dexNames?.length
      ? ` → DEX:"${dexNames.join('/')}"`
      : (m.sportsMarketType === 'child_moneyline' ? ' → DEX:"Winner. Map N"' : '');

    console.log(`  [${m.sportsMarketType}${dexHint}] ${m.question}`);
    for (let i = 0; i < outcomes.length; i++) {
      const price = parseFloat(prices[i]) || 0;
      console.log(`    ${outcomes[i].padEnd(22)} $${price.toFixed(3)}  tok=${tokenIds[i]?.slice(0, 16)}...`);
      if (tokenIds[i]) {
        pmTokens.set(tokenIds[i], {
          outcomeName: outcomes[i],
          conditionId: m.conditionId,
          marketType:  m.sportsMarketType,
          price,
        });
        allTokenIds.push(tokenIds[i]);
      }
    }
  }

  console.log(`\n[PM] Connecting WS, ${allTokenIds.length} tokens...`);
  connectPmWs(allTokenIds);
}

function connectPmWs(allTokenIds) {
  const ws = new WebSocket(PM_CLOB_WS, {
    headers: { Origin: 'https://polymarket.com' },
  });

  ws.on('open', () => {
    console.log(`[PM] WS connected ✓`);
    const CHUNK = 200;
    for (let i = 0; i < allTokenIds.length; i += CHUNK) {
      ws.send(JSON.stringify({
        assets_ids: allTokenIds.slice(i, i + CHUNK),
        type: 'market',
        custom_feature_enabled: true,
      }));
    }
    // Application-level heartbeat — NOT ws.ping() (WS protocol frames, ignored by Polymarket)
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('PING');
    }, 9_000);
  });

  ws.on('message', (raw) => {
    const str = raw.toString();
    if (str === 'PONG') return;

    let parsed;
    try { parsed = JSON.parse(str); } catch { console.log('[PM] non-JSON:', str.slice(0, 80)); return; }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of items) {
      switch (msg.event_type) {
        case 'book': {
          const asks = [...(msg.asks ?? [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const best = asks[0];
          if (!best) break;
          const price = parseFloat(best.price);
          const info = pmTokens.get(msg.asset_id);
          if (info) {
            const old = info.price;
            info.price = price;
            console.log(`[${ts()}] PM BOOK      [${info.marketType}] ${info.outcomeName.padEnd(20)} $${old.toFixed(3)} → $${price.toFixed(3)}  (asks=${asks.length} bids=${msg.bids?.length ?? 0})`);
          }
          break;
        }
        case 'price_change': {
          for (const c of (msg.price_changes ?? [])) {
            const bestAsk = c.best_ask != null ? parseFloat(c.best_ask) : NaN;
            if (!isFinite(bestAsk) || bestAsk <= 0) continue;
            const info = pmTokens.get(c.asset_id);
            if (info) {
              const old = info.price;
              info.price = bestAsk;
              console.log(`[${ts()}] PM PRICE_CHG [${info.marketType}] ${info.outcomeName.padEnd(20)} $${old.toFixed(3)} → $${bestAsk.toFixed(3)}  side=${c.side} best_bid=${c.best_bid ?? 'N/A'}`);
            }
          }
          break;
        }
        case 'best_bid_ask': {
          const bestAsk = parseFloat(msg.best_ask);
          if (!isFinite(bestAsk) || bestAsk <= 0) break;
          const info = pmTokens.get(msg.asset_id);
          if (info) {
            const old = info.price;
            info.price = bestAsk;
            console.log(`[${ts()}] PM BID_ASK   [${info.marketType}] ${info.outcomeName.padEnd(20)} $${old.toFixed(3)} → $${bestAsk.toFixed(3)}  bid=${msg.best_bid} spread=${msg.spread}`);
          }
          break;
        }
      }
    }
  });

  ws.on('error', (err) => console.error('[PM] error:', err.message));
  ws.on('close', (code) => {
    console.log(`[PM] WS closed (${code}), reconnecting in 5s...`);
    setTimeout(() => connectPmWs(allTokenIds), 5_000);
  });
}

// ── DexSport ─────────────────────────────────────────────────────

async function startDexsport() {
  console.log(`\n[DEX] Fetching token (slug: ${DEX_SLUG})...`);
  const profile = await postJson(`${DEX_BASE}/public/api/profile`, {
    apiKey:    DEX_API_KEY,
    visitorId: randomUUID().replace(/-/g, ''),
    guest:     true,
  });
  if (!profile.token) throw new Error('No token in DexSport profile response');
  console.log(`[DEX] Token obtained ✓`);
  connectDexWs(profile.token);
}

function connectDexWs(token) {
  const timestamp = Buffer.from(
    JSON.stringify({ now: new Date().toISOString(), expired: false }),
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const query = new URLSearchParams({
    cid: DEX_API_KEY, lang: 'en', timestamp, token, format: 'long',
  });

  const ws = new WebSocket(`${DEX_WS}?${query}`);
  const subscribedMarkets = new Set();
  const joinedEvents = new Set();

  ws.on('open', () => console.log(`[DEX] WS connected ✓`));

  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }

    const [model, payload] = parsed;

    if (model === 'config') {
      // Join the specific event IDs directly (no need to traverse discipline→tournament chain)
      for (const eid of DEX_EVENT_IDS) {
        if (!joinedEvents.has(eid)) {
          joinedEvents.add(eid);
          ws.send(JSON.stringify(['join', 'event', eid]));
          console.log(`[DEX] Joining event: ${eid}`);
        }
      }
      return;
    }

    if (model !== 'batch') return;

    for (const item of payload) {
      const [entityName, entityId, , entityData] = item;

      if (entityName === 'event') {
        if (!entityData) continue;
        console.log(`[${ts()}] DEX EVENT  id=${entityId}  name="${entityData.name ?? '?'}"  isLive=${entityId.startsWith('2.')}`);

        // Subscribe to markets listed on this event
        const allMarketIds = [
          ...(entityData.mainMarketIds ?? []).filter(Boolean),
          ...(entityData.marketIds ?? []),
        ];
        const newMarkets = allMarketIds.filter((m) => m && !subscribedMarkets.has(m));
        if (newMarkets.length > 0) {
          newMarkets.forEach((m) => subscribedMarkets.add(m));
          ws.send(JSON.stringify(['join', 'market', newMarkets]));
          console.log(`[DEX] Subscribing to ${newMarkets.length} markets: ${newMarkets.slice(0, 5).join(', ')}...`);
        }

      } else if (entityName === 'market') {
        if (!entityData) continue;

        const outcomes = (entityData.outcomes ?? []).map((o) => ({
          name:  o.name  ?? '',
          price: o.price ?? 0,
        }));

        const existing = dexMarkets.get(entityId);
        if (existing) {
          const oldStr = existing.outcomes.map((o) => `${o.name}=${o.price.toFixed(3)}`).join(', ');
          if (entityData.name) existing.name = entityData.name;
          if (outcomes.length > 0) existing.outcomes = outcomes;
          const newStr = existing.outcomes.map((o) => `${o.name}=${o.price.toFixed(3)}`).join(', ');
          if (oldStr !== newStr) {
            console.log(`[${ts()}] DEX PRICE  [${existing.name}]`);
            console.log(`            ${oldStr}`);
            console.log(`          → ${newStr}`);
          }
        } else {
          dexMarkets.set(entityId, {
            name:     entityData.name ?? entityId,
            outcomes,
          });
          const priceStr = outcomes.map((o) => `${o.name}=${o.price.toFixed(3)}`).join(', ');
          console.log(`[${ts()}] DEX MARKET [${entityData.name ?? entityId}]  ${priceStr}`);
        }
      }
    }
  });

  ws.on('error', (err) => console.error('[DEX] error:', err.message));
  ws.on('close', (code) => {
    console.log(`[DEX] WS closed (${code}), reconnecting in 5s...`);
    setTimeout(() => connectDexWs(token), 5_000);
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(72));
  console.log('  Dota2 Arb Monitor — Tundra vs Yellow Submarine');
  console.log(`  PM slug:   ${PM_SLUG}  (tag: ${PM_TAG})`);
  console.log(`  DEX slug:  ${DEX_SLUG}  events: ${DEX_EVENT_IDS.join(', ')}`);
  console.log('═'.repeat(72) + '\n');

  await Promise.all([
    startPolymarket().catch((e) => console.error('[PM] startup error:', e.message)),
    startDexsport().catch((e) => console.error('[DEX] startup error:', e.message)),
  ]);

  // Summary every 10 seconds
  setInterval(computeArb, 10_000);
}

main().catch(console.error);
