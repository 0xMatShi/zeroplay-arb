/**
 * Test script: connect to DexSport WS, grab events, log IDs + generated URLs.
 * Run: npx ts-node scripts/test-dex-url.ts
 */

import axios from 'axios';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';

const BASE_URL = 'https://prod.dexsport.work';
const WS_URL   = 'wss://prod.dexsport.work/ws';
const API_KEY  = 'ta-dexsport';
const LANG     = 'en';

const ESPORTS = new Set(['csgo', 'dota2', 'lol', 'valorant', 'call-of-duty']);
const TARGET_SPORTS = ['csgo', 'dota2', 'lol', 'valorant', 'basketball', 'tennis', 'hockey', 'boxing'];

function buildDexUrl(eventId: string, eventName: string, sportKey: string): string {
  const rawId = eventId.includes('.') ? eventId.split('.')[1] : eventId;
  const nameSlug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const category = ESPORTS.has(sportKey) ? 'esports' : 'sports';
  return `https://dexsport.io/${category}/${sportKey}/${nameSlug}-${rawId}/bets/`;
}

async function fetchToken(): Promise<string> {
  const { data } = await axios.post(`${BASE_URL}/public/api/profile`, {
    apiKey: API_KEY,
    visitorId: randomUUID().replace(/-/g, ''),
    guest: true,
  }, { timeout: 10_000 });
  return data.token;
}

function send(ws: Ws.WebSocket, msg: unknown) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  console.log('Fetching token...');
  const token = await fetchToken();
  console.log('Token OK\n');

  const timestamp = Buffer.from(
    JSON.stringify({ now: new Date().toISOString(), expired: false }),
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const query = new URLSearchParams({ cid: API_KEY, lang: LANG, timestamp, token, format: 'long' });
  const ws = new Ws.WebSocket(`${WS_URL}?${query}`);

  const tournamentToSport = new Map<string, string>();
  const eventToSport      = new Map<string, string>();
  const subscribedT       = new Set<string>();
  const subscribedE       = new Set<string>();

  let found = 0;

  ws.on('open', () => console.log('WS connected, waiting for config...'));

  ws.on('message', (raw: Ws.RawData) => {
    let parsed: any;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }

    const [model, payload] = parsed;

    // Config: contains available disciplines → join target sports
    if (model === 'config') {
      const disciplines: { id: string }[] = payload?.disciplines ?? [];
      const ids = disciplines
        .filter(d => TARGET_SPORTS.includes(d.id))
        .flatMap(d => [`2.${d.id}`, `1.${d.id}`]);
      if (ids.length > 0) {
        console.log(`Joining ${ids.length} discipline channels: ${ids.join(', ')}`);
        send(ws, ['join', 'discipline', ids]);
      }
      return;
    }

    if (model !== 'batch') return;

    for (const item of (payload as any[])) {
      const [entityName, entityId, , entityData] = item as [string, string, number, any];
      if (!entityData) continue;

      // Discipline → extract tournament IDs
      if (entityName === 'discipline') {
        const sportSlug: string = entityData?.id ?? entityId.split('.').slice(1).join('.');
        if (!TARGET_SPORTS.includes(sportSlug)) continue;

        const tIds: string[] = entityData?.tournamentIds ?? [];
        const newT = tIds.filter(t => !subscribedT.has(t));
        newT.forEach(t => { subscribedT.add(t); tournamentToSport.set(t, sportSlug); });
        if (newT.length > 0) send(ws, ['join', 'tournament', newT]);
      }

      // Tournament → extract event IDs
      if (entityName === 'tournament') {
        const sportSlug = tournamentToSport.get(entityId);
        if (!sportSlug) continue;

        const eIds: string[] = (entityData?.eventIds ?? []).filter(
          (e: string) => e && !e.startsWith('outright'),
        );
        const newE = eIds.filter(e => !subscribedE.has(e));
        newE.forEach(e => { subscribedE.add(e); eventToSport.set(e, sportSlug); });
        if (newE.length > 0) {
          for (const eid of newE) send(ws, ['join', 'event', eid]);
        }
      }

      // Event → log it
      if (entityName === 'event') {
        const sportSlug = eventToSport.get(entityId);
        if (!sportSlug || !entityData?.name) continue;

        const url = buildDexUrl(entityId, entityData.name, sportSlug);
        console.log('─'.repeat(70));
        console.log(`Event:    ${entityData.name}`);
        console.log(`Raw ID:   ${entityId}`);
        console.log(`Sport:    ${sportSlug}`);
        console.log(`Live:     ${entityId.startsWith('2.')}`);
        console.log(`URL:      ${url}`);

        found++;
        if (found >= 5) {
          console.log('\n✓ Done');
          ws.close();
          process.exit(0);
        }
      }
    }
  });

  ws.on('error', (err: Error) => console.error('WS error:', err.message));
  ws.on('close', () => console.log('WS closed'));

  setTimeout(() => {
    console.log(`\nTimeout. Found ${found} events.`);
    ws.close();
    process.exit(0);
  }, 20_000);
}

main().catch(console.error);
