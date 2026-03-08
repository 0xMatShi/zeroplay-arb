/**
 * Test script: subscribe to Polymarket CLOB WS for a specific event
 * and log all incoming messages.
 *
 * Usage: node scripts/test-pm-ws.mjs
 */

import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// pain vs Aurora CS2 2026-03-08
const EVENT_SLUG = 'cs2-pain-aur1-2026-03-08';

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Fetching event: ${EVENT_SLUG}`);
  const events = await fetchJson(`${GAMMA_API}/events?slug=${EVENT_SLUG}`);

  if (!events?.length) {
    console.error('Event not found');
    process.exit(1);
  }

  const event = events[0];
  console.log(`Event: ${event.title} (id=${event.id})`);

  // Find Total Maps markets
  const markets = (event.markets ?? []).filter(m => m.sportsMarketType);
  if (!markets.length) {
    console.error('No sports markets found');
    process.exit(1);
  }

  console.log(`\nMarkets (${markets.length} total):`);
  const allTokenIds = [];
  for (const m of markets) {
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');
    console.log(`  [${m.sportsMarketType}] ${m.question}`);
    for (let i = 0; i < outcomes.length; i++) {
      console.log(`    ${outcomes[i]}: price=${prices[i]} tokenId=${tokenIds[i]?.slice(0, 20)}...`);
    }
    allTokenIds.push(...tokenIds);
  }

  console.log(`\nConnecting to WS, subscribing to ${allTokenIds.length} tokens...`);

  const ws = new WebSocket(CLOB_WS, {
    headers: { Origin: 'https://polymarket.com' },
  });

  ws.on('open', () => {
    console.log('WS connected\n');

    // Subscribe in chunks with custom_feature_enabled
    const CHUNK = 200;
    for (let i = 0; i < allTokenIds.length; i += CHUNK) {
      const chunk = allTokenIds.slice(i, i + CHUNK);
      ws.send(JSON.stringify({ assets_ids: chunk, type: 'market', custom_feature_enabled: true }));
    }
  });

  ws.on('message', (raw) => {
    const str = raw.toString();
    let parsed;
    try { parsed = JSON.parse(str); } catch { console.log('RAW:', str); return; }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of items) {
      const type = msg.event_type ?? msg.type ?? 'unknown';
      const ts = new Date().toISOString().slice(11, 23);

      if (type === 'book') {
        const bids = (msg.bids ?? []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        const asks = (msg.asks ?? []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        console.log(`[${ts}] BOOK  asset=${msg.asset_id?.slice(0, 20)}...`);
        console.log(`        best_bid=${bids[0]?.price ?? 'none'}  best_ask=${asks[0]?.price ?? 'none'}`);
        console.log(`        bids=${bids.length}  asks=${asks.length}`);
      } else if (type === 'price_change') {
        for (const c of (msg.price_changes ?? [])) {
          console.log(`[${ts}] PRICE_CHANGE  asset=${c.asset_id?.slice(0, 20)}...  side=${c.side}  price=${c.price}  size=${c.size}  best_bid=${c.best_bid ?? 'N/A'}  best_ask=${c.best_ask ?? 'N/A'}`);
        }
      } else if (type === 'best_bid_ask') {
        console.log(`[${ts}] BEST_BID_ASK  asset=${msg.asset_id?.slice(0, 20)}...  best_bid=${msg.best_bid}  best_ask=${msg.best_ask}  spread=${msg.spread}`);
      } else {
        console.log(`[${ts}] ${type.toUpperCase()}`, JSON.stringify(msg).slice(0, 200));
      }
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
  ws.on('close', (code) => console.log('WS closed:', code));

  // Keep alive — application-level PING (NOT ws.ping() which is WS-protocol level)
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('PING');
  }, 9_000);
}

main().catch(console.error);
