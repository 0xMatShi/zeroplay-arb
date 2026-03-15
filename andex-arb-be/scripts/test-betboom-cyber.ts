/**
 * Тест BetBoom — многоуровневая подписка на матчи.
 *
 * Протокол (из анализа widget.js / vendor.js):
 *   TreeType: 1=LIVE, 2=PREMATCH (НЕ sport/cyber как написано в адаптере!)
 *
 * Правильный flow:
 *   1. STATE_SUBSCRIBE_BY_SPORTS (type=LIVE) → field-5 ответ со списком видов спорта
 *   2. Из state-ответа или newsletters (field 25/27) берём tournament IDs
 *   3. Подписываемся на матчи: MatchesSubscribeRequest с match IDs
 *   4. Получаем NEWSLETTERS_MATCH (field 29/30) и NEWSLETTERS_STAKE (field 31)
 *
 * Запуск: npx ts-node scripts/test-betboom-cyber.ts
 */

import * as Ws from 'ws';
import { randomUUID } from 'crypto';

// ── Constants ───────────────────────────────────────────────────

const FEED_WS_URL = 'wss://ru-ws2.sporthub.bet:444/api/tree_ws/v1';
const PING_INTERVAL_MS = 25_000;
const TIMEOUT_MS = 5 * 60_000;

// Реальные значения из vendor JS виджета:
// wr = {UNSPECIFIED:0, LIVE:1, PREMATCH:2, TOP:3, SUPER_TOP:4}
const TreeType = { LIVE: 1, PREMATCH: 2 } as const;
const Language = { EN: 1 } as const;

// REQ field numbers (MainRequest oneof)
const REQ = {
  PING: 1,
  SETTINGS_SET: 3,
  STATE_SUBSCRIBE_BY_SPORTS: 4,
  // STATE_SUBSCRIBE_TOURNAMENTS: предположительно поблизости от 4
  // Из widget limits: MAX_STATE_SUBSCRIBE_TOURNAMENTS_ITEMS_LIMIT=10
  MATCHES_SUBSCRIBE: 14,      // MatchesSubscribeRequest (попытка)
  MATCHES_SUBSCRIBE_FULL: 16, // MatchesSubscribeFullRequest
} as const;

// RESP field numbers (MainResponse oneof)
const RESP = {
  SETTINGS_SET_RESP: 4,
  STATE_SUBSCRIBE_RESP: 5,
  NEWSLETTERS_STATE_READY: 24,
  NEWSLETTERS_SPORT: 25,
  NEWSLETTERS_TOURNAMENT: 27,
  NEWSLETTERS_MATCH: 29,
  NEWSLETTERS_FULL_MATCH: 30,
  NEWSLETTERS_STAKE: 31,
} as const;

// ── Protobuf helpers ────────────────────────────────────────────

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  while (n > 0x7f) { bytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function decodeVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return [result, offset];
}

function tagBuf(f: number, w: number): Buffer { return encodeVarint((f << 3) | w); }
function lenDelim(f: number, d: Buffer): Buffer { return Buffer.concat([tagBuf(f, 2), encodeVarint(d.length), d]); }
function stringField(f: number, s: string): Buffer { return lenDelim(f, Buffer.from(s, 'utf8')); }
function varintField(f: number, n: number): Buffer { return Buffer.concat([tagBuf(f, 0), encodeVarint(n)]); }
function msgField(f: number, m: Buffer): Buffer { return lenDelim(f, m); }

function parseMsg(buf: Buffer): Record<number, any> {
  const result: Record<number, any> = {};
  let offset = 0;
  const set = (k: number, v: any) => {
    if (k in result) { if (!Array.isArray(result[k])) result[k] = [result[k]]; result[k].push(v); }
    else result[k] = v;
  };
  while (offset < buf.length) {
    let tag: number;
    [tag, offset] = decodeVarint(buf, offset);
    const fieldNo = tag >> 3, wireType = tag & 0x7;
    if (wireType === 0) { let val: number; [val, offset] = decodeVarint(buf, offset); set(fieldNo, val); }
    else if (wireType === 1) { set(fieldNo, buf.slice(offset, offset + 8)); offset += 8; }
    else if (wireType === 2) { let len: number; [len, offset] = decodeVarint(buf, offset); set(fieldNo, buf.slice(offset, offset + len)); offset += len; }
    else if (wireType === 5) { set(fieldNo, buf.slice(offset, offset + 4)); offset += 4; }
    else break;
  }
  return result;
}

function str(raw: Buffer | undefined): string { return raw ? raw.toString('utf8') : ''; }
function toDouble(raw: Buffer | undefined): number {
  if (!raw || raw.length < 8) return 0;
  return raw.readDoubleLE(0);
}

// ── Message builders ────────────────────────────────────────────

function buildSubscribe(uid: string, treeType: number): Buffer {
  return msgField(REQ.STATE_SUBSCRIBE_BY_SPORTS, Buffer.concat([
    stringField(1, uid),
    varintField(2, treeType),
  ]));
}

function buildPing(uid: string): Buffer {
  return msgField(REQ.PING, stringField(1, uid));
}

// MatchesSubscribeFullRequest: {uid(1), full_matches(2): repeated {match_id(1,i64)}}
function buildMatchesSubscribeFull(uid: string, matchIds: number[]): Buffer {
  const matchBufs = matchIds.map(id => msgField(2, varintField(1, id)));
  return msgField(REQ.MATCHES_SUBSCRIBE_FULL, Buffer.concat([
    stringField(1, uid),
    ...matchBufs,
  ]));
}

// ── Parsing ─────────────────────────────────────────────────────

function parseTeam(buf: Buffer): string {
  const f = parseMsg(buf);
  return str(f[3]) || str(f[4]) || '?';
}

function parseMatchInfo(buf: Buffer) {
  const f = parseMsg(buf);
  let home = '?', away = '?';
  if (f[16]) { const teams = parseMsg(f[16] as Buffer); if (teams[1]) home = parseTeam(teams[1]); if (teams[3]) away = parseTeam(teams[3]); }
  return { id: f[1] ?? 0, isActive: f[6] === 1, sportId: f[8] ?? 0, tournamentId: f[10] ?? 0, startDttm: str(f[13]), home, away };
}

function parseStake(buf: Buffer) {
  const f = parseMsg(buf);
  return { stakeId: str(f[1]), matchId: f[2] ?? 0, isActive: f[3] === 1, isLive: f[4] === 1,
    name: str(f[5]), factor: toDouble(f[10]), marketName: str(f[14]), groupName: str(f[18]), periodName: str(f[20]) };
}

// ── State response deep parser ──────────────────────────────────
// Парсим state response чтобы извлечь sport → tournament → matchId структуру

interface TournamentEntry { id: number; name: string; sportId: number; matchIds: number[] }
interface SportEntry { id: number; name: string; tournaments: TournamentEntry[] }

function parseStateTree(treeBuf: Buffer): SportEntry[] {
  const tree = parseMsg(treeBuf);
  const treeType = tree[1];
  console.log(`[state_tree] type=${treeType} (${treeType === 1 ? 'LIVE' : treeType === 2 ? 'PREMATCH' : '?'})`);

  const sportBufs: Buffer[] = tree[2] ? (Array.isArray(tree[2]) ? tree[2] : [tree[2]]) : [];
  const sports: SportEntry[] = [];

  for (const sportBuf of sportBufs) {
    // ModelsSport: {info(1), tournaments(?) or matchIds(?)}
    const s = parseMsg(sportBuf as Buffer);
    const sportFields = Object.keys(s).map(Number).sort((a,b) => a-b);

    let sportId = 0, sportName = '?';
    if (s[1]) {
      const si = parseMsg(s[1] as Buffer);
      sportId = si[1] ?? 0;
      sportName = si[2] ? str(si[2] as Buffer) : `sport#${sportId}`;
    }

    const entry: SportEntry = { id: sportId, name: sportName, tournaments: [] };

    // Ищем турниры/матчи в остальных полях (кроме field 1 = SportInfo)
    for (const fNo of sportFields) {
      if (fNo === 1) continue;
      const vals = s[fNo];
      const bufs: Buffer[] = Array.isArray(vals) ? vals : (Buffer.isBuffer(vals) ? [vals] : []);
      for (const tb of bufs) {
        // Пробуем распарсить как ModelsTournament
        try {
          const t = parseMsg(tb as Buffer);
          const tFields = Object.keys(t).map(Number).sort((a,b) => a-b);

          let tId = 0, tName = '?';
          if (t[1]) {
            const ti = parseMsg(t[1] as Buffer);
            tId = ti[1] ?? 0;
            tName = ti[2] ? str(ti[2] as Buffer) : `t#${tId}`;
          }

          // matchIds — повторяющееся поле с varint (i64)
          const matchIds: number[] = [];
          for (const tf of tFields) {
            if (tf === 1) continue;
            const mv = t[tf];
            const ms: any[] = Array.isArray(mv) ? mv : [mv];
            for (const m of ms) {
              if (typeof m === 'number' && m > 0) matchIds.push(m);
            }
          }

          if (tId || matchIds.length) {
            entry.tournaments.push({ id: tId, name: tName, sportId, matchIds });
          }
        } catch {}
      }
    }

    sports.push(entry);
  }

  return sports;
}

// ── Event cache ─────────────────────────────────────────────────

const sportIdToName = new Map<number, string>();
const eventCache = new Map<number, {
  name: string; sportName: string; isLive: boolean; startDttm: string;
  markets: Map<string, { name: string; outcomes: Map<string, number> }>;
}>();

let matchCount = 0, stakeCount = 0, msgCount = 0;
const seenTopFields = new Set<number>();

function printEvent(matchId: number) {
  const ev = eventCache.get(matchId);
  if (!ev) return;
  console.log(`\n┌── [${ev.sportName}] ${ev.name}${ev.isLive ? ' 🔴 LIVE' : ''}`);
  console.log(`│   start: ${ev.startDttm}  id: ${matchId}`);
  for (const [, mkt] of ev.markets) {
    console.log(`│   [${mkt.name}]`);
    for (const [name, factor] of mkt.outcomes) console.log(`│     ${name.padEnd(22)} ${factor.toFixed(3)}`);
  }
  console.log('└' + '─'.repeat(60));
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  console.log('[bb] Подключаемся... LIVE tree (type=1)\n');

  const ws = new Ws.WebSocket(FEED_WS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Origin: 'https://betboom.ru',
    },
  });
  ws.binaryType = 'nodebuffer';

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let subscribedToMatches = false;

  const send = (data: Buffer) => { if (ws.readyState === Ws.WebSocket.OPEN) ws.send(data); };

  ws.on('open', () => console.log('[bb] WS открыт'));

  ws.on('message', (data: Buffer) => {
    msgCount++;
    const outer = parseMsg(data);

    for (const f of Object.keys(outer).map(Number)) {
      if (!seenTopFields.has(f)) { seenTopFields.add(f); console.log(`[new field ${f}] ${Buffer.isBuffer(outer[f]) ? outer[f].length + 'b' : outer[f]}`); }
    }

    // ── state_ready ──
    if (RESP.NEWSLETTERS_STATE_READY in outer) {
      console.log('[bb] state_ready → подписываемся на LIVE');
      send(buildSubscribe(randomUUID(), TreeType.LIVE));
      pingTimer = setInterval(() => send(buildPing(randomUUID())), PING_INTERVAL_MS);
      return;
    }

    // ── state resp (field 5): начальный стейт ──
    if (RESP.STATE_SUBSCRIBE_RESP in outer) {
      const raw = outer[RESP.STATE_SUBSCRIBE_RESP] as Buffer;
      const f = parseMsg(raw);
      console.log(`\n[state_resp] code=${f[1]} size=${raw.length}b fields=[${Object.keys(f).join(',')}]`);
      if (!f[5]) return;

      const sports = parseStateTree(f[5] as Buffer);

      let totalTournaments = 0, totalMatchIds = 0;
      const allMatchIds: number[] = [];

      for (const sport of sports) {
        sportIdToName.set(sport.id, sport.name);
        if (sport.tournaments.length) {
          console.log(`  [sport] id=${sport.id} "${sport.name}" → ${sport.tournaments.length} турниров`);
          for (const t of sport.tournaments.slice(0, 3)) {
            console.log(`    [tournament] id=${t.id} "${t.name}" → matchIds: ${t.matchIds.slice(0, 5).join(', ')}`);
            allMatchIds.push(...t.matchIds);
            totalMatchIds += t.matchIds.length;
          }
          totalTournaments += sport.tournaments.length;
        }
      }

      console.log(`\n[state_tree] ${sports.length} видов спорта, ${totalTournaments} турниров, ${totalMatchIds} матчей`);

      // Если нашли match IDs — подписываемся на первые 50
      if (allMatchIds.length && !subscribedToMatches) {
        subscribedToMatches = true;
        const toSubscribe = [...new Set(allMatchIds)].slice(0, 50);
        console.log(`[subscribe] Подписываемся на ${toSubscribe.length} матчей: ${toSubscribe.slice(0, 5).join(', ')}...`);
        send(buildMatchesSubscribeFull(randomUUID(), toSubscribe));
      }
      return;
    }

    // ── sport newsletter ──
    if (RESP.NEWSLETTERS_SPORT in outer) {
      const f = parseMsg(outer[RESP.NEWSLETTERS_SPORT] as Buffer);
      if (f[6]) {
        const sport = parseMsg(f[6] as Buffer);
        if (sport[1]) {
          const si = parseMsg(sport[1] as Buffer);
          const id = si[1] ?? 0, name = si[2] ? str(si[2] as Buffer) : '?';
          if (id && !sportIdToName.has(id)) { sportIdToName.set(id, name); console.log(`[sport] id=${id} "${name}"`); }
        }
      }
      return;
    }

    // ── tournament newsletter ──
    if (RESP.NEWSLETTERS_TOURNAMENT in outer) {
      const f = parseMsg(outer[RESP.NEWSLETTERS_TOURNAMENT] as Buffer);
      if (f[6]) {
        const t = parseMsg(f[6] as Buffer);
        if (t[1]) {
          const ti = parseMsg(t[1] as Buffer);
          const id = ti[1] ?? 0, name = str(ti[2] as Buffer), sportId = ti[8] ?? 0;
          const sportName = sportIdToName.get(sportId) ?? `sport#${sportId}`;
          // matchIds из tournament (field 2)
          const rawIds = t[2];
          const ids: number[] = rawIds ? (Array.isArray(rawIds) ? rawIds : [rawIds]).filter((x: any) => typeof x === 'number') : [];
          console.log(`[tournament] "${name}" sport="${sportName}" matchIds=${ids.length}`);

          if (ids.length && !subscribedToMatches) {
            subscribedToMatches = true;
            const toSub = ids.slice(0, 50);
            console.log(`[subscribe] Подписываемся на ${toSub.length} матчей из турнира`);
            send(buildMatchesSubscribeFull(randomUUID(), toSub));
          }
        }
      }
      return;
    }

    // ── match newsletter ──
    if (RESP.NEWSLETTERS_MATCH in outer || RESP.NEWSLETTERS_FULL_MATCH in outer) {
      const raw = (outer[RESP.NEWSLETTERS_MATCH] ?? outer[RESP.NEWSLETTERS_FULL_MATCH]) as Buffer;
      const f = parseMsg(raw);
      if (!f[6]) return;
      const mf = parseMsg(f[6] as Buffer);
      const info = mf[1] ? parseMatchInfo(mf[1] as Buffer) : null;
      if (!info || !info.id) return;
      if (!info.isActive) { eventCache.delete(info.id as number); return; }

      const sportName = sportIdToName.get(info.sportId as number) ?? `sport#${info.sportId}`;
      const rawStakes = mf[2];
      const stakesBufs: Buffer[] = rawStakes ? (Array.isArray(rawStakes) ? rawStakes : [rawStakes]) : [];

      const markets = new Map<string, { name: string; outcomes: Map<string, number> }>();
      for (const sb of stakesBufs) {
        const stake = parseStake(sb);
        if (!stake.isActive || stake.factor <= 1) continue;
        const key = `${info.id}_${stake.groupName || stake.marketName}`;
        if (!markets.has(key)) markets.set(key, { name: stake.marketName || stake.groupName, outcomes: new Map() });
        markets.get(key)!.outcomes.set(stake.name, stake.factor);
      }
      if (!markets.size) return;

      const isNew = !eventCache.has(info.id as number);
      eventCache.set(info.id as number, {
        name: `${info.home} vs ${info.away}`, sportName,
        isLive: stakesBufs.some(sb => parseStake(sb).isLive),
        startDttm: info.startDttm, markets,
      });
      if (isNew) { matchCount++; printEvent(info.id as number); }
      return;
    }

    // ── stake newsletter ──
    if (RESP.NEWSLETTERS_STAKE in outer) {
      const f = parseMsg(outer[RESP.NEWSLETTERS_STAKE] as Buffer);
      if (!f[5]) return;
      const stake = parseStake(f[5] as Buffer);
      const ev = eventCache.get(stake.matchId as number);
      if (!ev) return;
      const key = `${stake.matchId}_${stake.groupName || stake.marketName}`;
      const mkt = ev.markets.get(key);
      if (!mkt) return;
      const old = mkt.outcomes.get(stake.name);
      if (old === stake.factor) return;
      mkt.outcomes.set(stake.name, stake.factor);
      stakeCount++;
      const arrow = old !== undefined ? (stake.factor > old ? '↑' : '↓') : '';
      console.log(`[~odds] ${ev.name} | ${mkt.name} | ${stake.name}: ${old?.toFixed(3) ?? '?'} → ${stake.factor.toFixed(3)} ${arrow}`);
      return;
    }
  });

  ws.on('error', err => console.error('[bb] error:', err.message));
  ws.on('close', code => {
    if (pingTimer) clearInterval(pingTimer);
    if (statusTimer) clearInterval(statusTimer);
    console.log(`\n[bb] closed code=${code}`);
    console.log(`\n── Итоги ───────────────────────────────────────`);
    console.log(`Спортов: ${sportIdToName.size}  Матчей: ${eventCache.size}  Обновлений: ${stakeCount}`);
    console.log(`Top-level поля: [${[...seenTopFields].sort((a,b) => a-b).join(', ')}]`);
    console.log(`Все спорты: ${[...sportIdToName.entries()].map(([id,n]) => `${id}=${n}`).join(', ')}`);
    process.exit(0);
  });

  statusTimer = setInterval(() => {
    console.log(`[status] msgs=${msgCount} sports=${sportIdToName.size} matches=${eventCache.size} odds=${stakeCount}`);
  }, 30_000);

  setTimeout(() => { console.log('\n[timeout] завершаем'); ws.close(); }, TIMEOUT_MS);
  process.on('SIGINT', () => { ws.close(); });
}

main();
