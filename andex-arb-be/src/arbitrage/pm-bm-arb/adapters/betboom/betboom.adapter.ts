import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as Ws from 'ws';
import { randomUUID } from 'crypto';
import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import { BbStake, BbMatchInfo, BbMatch } from './betboom.types';

// ── Constants ────────────────────────────────────────────────────

const FEED_WS_URL = 'wss://ru-ws2.sporthub.bet:444/api/tree_ws/v1';
const PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 5_000;
const EVENT_TTL_MS = 5 * 60_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

/**
 * bb.sport_ws.v1.common.TreeTypes enum values.
 * 1 = SPORT (regular sports), 2 = CYBER (esports).
 */
const TreeType = { SPORT: 1, CYBER: 2 } as const;

/**
 * bb.sport_ws.v1.common.Languages enum values.
 * 0 = UNSPECIFIED, 1 = EN, others are locales — we use EN for stable sport names.
 */
const Language = { UNSPECIFIED: 0, EN: 1 } as const;

/**
 * MainRequest field numbers (each is a oneof branch).
 */
const REQ = {
  PING: 1,
  SETTINGS_SET: 3,
  STATE_SUBSCRIBE_BY_SPORTS: 4,
  MATCHES_SUBSCRIBE_FULL: 16,
} as const;

/**
 * MainResponse field numbers (each is a oneof branch).
 * Field 24 = newsletters_state_ready (server hello on connect).
 * Field 25 = newsletters_sport.
 * Field 27 = newsletters_tournament.
 * Field 29 = newsletters_match (full match with stakes).
 * Field 31 = newsletters_stake (single stake/odds update).
 */
const RESP = {
  SETTINGS_SET: 4,
  NEWSLETTERS_STATE_READY: 24,
  NEWSLETTERS_SPORT: 25,
  NEWSLETTERS_TOURNAMENT: 27,
  NEWSLETTERS_MATCH: 29,
  NEWSLETTERS_FULL_MATCH: 30,
  NEWSLETTERS_STAKE: 31,
} as const;

/**
 * BetBoom English sport name → internal sportKey.
 * Only sports present in SPORTS (sports-constants.ts) are listed — others are skipped.
 */
const SPORT_NAME_MAP: Record<string, string> = {
  Basketball:          'basketball',
  Tennis:              'tennis',
  'Ice Hockey':        'hockey',
  Hockey:              'hockey',
  Baseball:            'baseball',
  Boxing:              'boxing',
  'Counter-Strike':    'csgo',
  'CS2':               'csgo',
  'Dota 2':            'dota2',
  'League of Legends': 'lol',
  Valorant:            'valorant',
};

// ── Protobuf binary helpers ──────────────────────────────────────
//
// We need to send only 3 small message types and decode the server's
// binary responses. We handle this without an external proto library.
// Wire types: 0=varint, 1=64-bit fixed, 2=length-delimited, 5=32-bit fixed.

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  // Use unsigned right-shift; safe for values up to ~2^53 via this loop.
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128); // equivalent to logical >> 7 for large numbers
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

/** Decode a varint starting at buf[offset]. Returns [value, newOffset]. */
function decodeVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return [result, offset];
}

function tagBuf(fieldNo: number, wireType: number): Buffer {
  return encodeVarint((fieldNo << 3) | wireType);
}

function lenDelim(fieldNo: number, data: Buffer): Buffer {
  return Buffer.concat([tagBuf(fieldNo, 2), encodeVarint(data.length), data]);
}

function stringField(fieldNo: number, s: string): Buffer {
  return lenDelim(fieldNo, Buffer.from(s, 'utf8'));
}

function varintField(fieldNo: number, n: number): Buffer {
  return Buffer.concat([tagBuf(fieldNo, 0), encodeVarint(n)]);
}

function msgField(fieldNo: number, msg: Buffer): Buffer {
  return lenDelim(fieldNo, msg);
}

/**
 * Parse a protobuf-encoded buffer into a plain map of fieldNo → raw value.
 * - wire 0 (varint): returns number
 * - wire 1 (64-bit): returns Buffer(8)
 * - wire 2 (len-delim): returns Buffer
 * - wire 5 (32-bit): returns Buffer(4)
 * Repeated fields are accumulated into arrays.
 */
function parseMsg(buf: Buffer): Record<number, any> {
  const result: Record<number, any> = {};
  let offset = 0;

  const set = (k: number, v: any) => {
    if (k in result) {
      if (!Array.isArray(result[k])) result[k] = [result[k]];
      result[k].push(v);
    } else {
      result[k] = v;
    }
  };

  while (offset < buf.length) {
    let tag: number;
    [tag, offset] = decodeVarint(buf, offset);
    const fieldNo = tag >> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      let val: number;
      [val, offset] = decodeVarint(buf, offset);
      set(fieldNo, val);
    } else if (wireType === 1) {
      set(fieldNo, buf.slice(offset, offset + 8));
      offset += 8;
    } else if (wireType === 2) {
      let len: number;
      [len, offset] = decodeVarint(buf, offset);
      set(fieldNo, buf.slice(offset, offset + len));
      offset += len;
    } else if (wireType === 5) {
      set(fieldNo, buf.slice(offset, offset + 4));
      offset += 4;
    } else {
      // Unknown wire type — cannot continue safely
      break;
    }
  }

  return result;
}

function str(raw: Buffer | undefined): string {
  return raw ? raw.toString('utf8') : '';
}

/** Read a little-endian double from an 8-byte Buffer (wire type 1). */
function toDouble(raw: Buffer | undefined): number {
  if (!raw || raw.length < 8) return 0;
  return raw.readDoubleLE(0);
}

// ── Message builders ─────────────────────────────────────────────

function buildSettingsSet(uid: string): Buffer {
  // SettingsSetRequest: {uid(1,str), time_filter(2,str), language(3,enum)}
  const inner = Buffer.concat([
    stringField(1, uid),
    stringField(2, 'ALL'),
    varintField(3, Language.EN),
  ]);
  // Wrap in MainRequest.settings_set (field 3, length-delimited)
  return msgField(REQ.SETTINGS_SET, inner);
}

function buildSubscribeBySpors(uid: string): Buffer {
  // StateSubscribeBySportsRequest: {uid(1,str), types(2,enum TreeTypes)}
  // Send SPORT type — subscribe to full regular-sports state tree.
  const inner = Buffer.concat([
    stringField(1, uid),
    varintField(2, TreeType.SPORT),
  ]);
  return msgField(REQ.STATE_SUBSCRIBE_BY_SPORTS, inner);
}

function buildPing(uid: string): Buffer {
  // PingRequest: {uid(1,str)}
  const inner = stringField(1, uid);
  return msgField(REQ.PING, inner);
}

// ── Data extraction helpers ──────────────────────────────────────

/**
 * Decode ModelsStake from a raw buffer.
 * Fields: stake_id(1,str), match_id(2,i64), is_active(3,bool),
 *   is_live(4,bool), name(5,str), factor(10,f64/wire1),
 *   market_name(14,str), group_name(18,str), period_name(20,str).
 */
function parseStake(buf: Buffer): BbStake {
  const f = parseMsg(buf);
  return {
    stakeId: str(f[1]),
    matchId: String(f[2] ?? 0),
    isActive: f[3] === 1,
    isLive: f[4] === 1,
    name: str(f[5]),
    factor: toDouble(f[10]),
    marketName: str(f[14]),
    groupName: str(f[18]),
    periodName: str(f[20]),
  };
}

/**
 * Decode ModelsMatch.MatchInfo.Teams.Team: {id(1), name(3), short_name(4)}.
 */
function parseTeam(buf: Buffer): string {
  const f = parseMsg(buf);
  return str(f[3]) || str(f[4]) || '?';
}

/**
 * Decode MatchInfo:
 *   id(1,i64), is_active(6,bool), sport_id(8,i64), tournament_id(10,i64),
 *   start_dttm(13,str), teams(16,msg).
 */
function parseMatchInfo(buf: Buffer): BbMatchInfo {
  const f = parseMsg(buf);

  let home = '?';
  let away = '?';
  if (f[16]) {
    const teams = parseMsg(f[16] as Buffer);
    if (teams[1]) home = parseTeam(teams[1] as Buffer);
    if (teams[3]) away = parseTeam(teams[3] as Buffer);
  }

  return {
    id: String(f[1] ?? 0),
    isActive: f[6] === 1,
    sportId: f[8] ?? 0,
    tournamentId: String(f[10] ?? 0),
    startDttm: str(f[13]),
    home,
    away,
  };
}

/**
 * Decode ModelsMatch: {info(1,msg), stakes(2,msg[])}
 */
function parseMatch(buf: Buffer): BbMatch {
  const f = parseMsg(buf);
  const info = f[1] ? parseMatchInfo(f[1] as Buffer) : ({} as BbMatchInfo);

  const rawStakes = f[2];
  const stakesBufs: Buffer[] = rawStakes
    ? Array.isArray(rawStakes) ? rawStakes : [rawStakes]
    : [];
  const stakes = stakesBufs.map(parseStake);

  return { info, stakes };
}

/**
 * Decode SportInfo: {id(1,i64), name(2,str)}.
 */
function parseSportInfo(buf: Buffer): { id: number; name: string } {
  const f = parseMsg(buf);
  return { id: f[1] ?? 0, name: str(f[2]) };
}

// ── Build DexMarket list from stakes ────────────────────────────

function stakesToMarkets(stakes: BbStake[], matchId: string): DexMarket[] {
  // Group active stakes by marketId (group_id encoded as string marketId).
  // We use `${matchId}_${groupName}_${marketName}` as stable marketId.
  const groups = new Map<string, { name: string; outcomes: DexOutcome[] }>();

  for (const stake of stakes) {
    if (!stake.isActive || stake.factor <= 1) continue;

    const marketKey = `${matchId}_${stake.groupName || stake.marketName}`;
    if (!groups.has(marketKey)) {
      groups.set(marketKey, {
        name: stake.marketName || stake.groupName,
        outcomes: [],
      });
    }
    groups.get(marketKey)!.outcomes.push({
      name: stake.name,
      price: stake.factor,
    });
  }

  const markets: DexMarket[] = [];
  for (const [marketId, group] of groups) {
    if (group.outcomes.length < 2) continue; // skip single-outcome markets
    const lc = group.name.toLowerCase();
    const marketType = lc.includes('тотал') || lc.includes('total')
      ? 'totals'
      : lc.includes('фора') || lc.includes('handicap')
      ? 'spreads'
      : 'moneyline';
    markets.push({ marketId, name: group.name, marketType, outcomes: group.outcomes });
  }

  return markets;
}

// ── Adapter ──────────────────────────────────────────────────────

@Injectable()
export class BetBoomAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BetBoomAdapter.name);

  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;
  trackedMarketIds: Set<string> = new Set();

  private ws: Ws.WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  private destroyed = false;
  private initialDataReceived = false;

  /** sportId → internal sportKey (populated on first newsletters_sport push) */
  private sportIdToKey = new Map<number, string>();

  /** Stable event cache — updated in-place on each newsletter push */
  private readonly eventCache = new Map<string, DexSportsEvent>();
  private readonly eventLastSeen = new Map<string, number>();

  async onModuleInit(): Promise<void> {
    this.connect();
    this.staleTimer = setInterval(() => this.evictStale(), STALE_CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.cleanup();
  }

  getEvents(): DexSportsEvent[] {
    return [...this.eventCache.values()];
  }

  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  clearCache(): void {
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.sportIdToKey.clear();
    this.initialDataReceived = false;
  }

  resetPhaseState(): void {}

  // ── WebSocket lifecycle ─────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;

    this.logger.log('BetBoom: connecting to feed WS…');

    this.ws = new Ws.WebSocket(FEED_WS_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://betboom.ru',
      },
    });

    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      this.logger.log('BetBoom: WS connected');
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        this.handleMessage(data);
      } catch (err: any) {
        this.logger.warn(`BetBoom: message parse error — ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`BetBoom: WS closed code=${code} reason=${reason?.toString()}`);
      this.stopPing();
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.warn(`BetBoom: WS error — ${err.message}`);
    });
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send(buildPing(randomUUID()));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(data: Buffer): void {
    if (this.ws?.readyState === Ws.WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ── Message handling ───────────────────────────────────────────

  private handleMessage(data: Buffer): void {
    // Parse outer MainResponse (oneof field identifies message type)
    const outer = parseMsg(data);

    if (RESP.NEWSLETTERS_STATE_READY in outer) {
      // Server hello — subscribe now
      this.logger.log('BetBoom: state_ready received, sending settings + subscription');
      const uid1 = randomUUID();
      const uid2 = randomUUID();
      this.send(buildSettingsSet(uid1));
      this.send(buildSubscribeBySpors(uid2));
      this.startPing();
      return;
    }

    if (RESP.NEWSLETTERS_SPORT in outer) {
      this.handleSportNewsletter(outer[RESP.NEWSLETTERS_SPORT] as Buffer);
      return;
    }

    if (RESP.NEWSLETTERS_MATCH in outer || RESP.NEWSLETTERS_FULL_MATCH in outer) {
      const raw = (outer[RESP.NEWSLETTERS_MATCH] ?? outer[RESP.NEWSLETTERS_FULL_MATCH]) as Buffer;
      this.handleMatchNewsletter(raw);
      return;
    }

    if (RESP.NEWSLETTERS_STAKE in outer) {
      this.handleStakeNewsletter(outer[RESP.NEWSLETTERS_STAKE] as Buffer);
      return;
    }
  }

  // ── Newsletter handlers ─────────────────────────────────────────

  /**
   * NewslettersSportResponse: {code(1), status(2), error(3), type(4), action(5), sport(6)}
   * ModelsSport: {info(1), tournaments(2,repeated)}
   * SportInfo: {id(1), name(2)}
   */
  private handleSportNewsletter(raw: Buffer): void {
    const f = parseMsg(raw);
    if (!f[6]) return;
    const sport = parseMsg(f[6] as Buffer);
    if (!sport[1]) return;
    const info = parseSportInfo(sport[1] as Buffer);
    if (!info.name || !info.id) return;

    const sportKey = SPORT_NAME_MAP[info.name];
    if (sportKey) {
      this.sportIdToKey.set(info.id, sportKey);
    }
  }

  /**
   * NewslettersMatchResponse: {code(1), status(2), error(3), type(4), action(5), match(6)}
   * Carries the full match data including all active stakes.
   */
  private handleMatchNewsletter(raw: Buffer): void {
    const f = parseMsg(raw);
    if (!f[6]) return;

    const { info, stakes } = parseMatch(f[6] as Buffer);
    if (!info.id || info.id === '0') return;

    const sportKey = this.sportIdToKey.get(info.sportId) ?? null;
    if (!sportKey) return; // skip sports we don't track

    if (!info.isActive) {
      this.eventCache.delete(info.id);
      this.eventLastSeen.delete(info.id);
      return;
    }

    const markets = stakesToMarkets(stakes, info.id);
    if (!markets.length) return;

    const name = `${info.home} vs ${info.away}`;
    const startTime = info.startDttm ? Math.floor(new Date(info.startDttm).getTime() / 1000) : undefined;
    const isLive = stakes.some((s) => s.isLive);
    const now = Date.now();

    const existing = this.eventCache.get(info.id);
    if (!existing) {
      this.eventCache.set(info.id, {
        eventId: info.id,
        name,
        sportKey,
        isLive,
        startTime,
        tournamentName: info.tournamentId,
        markets,
        updatedAt: now,
      });
    } else {
      existing.name = name;
      existing.isLive = isLive;
      existing.markets = markets;
      existing.updatedAt = now;
      if (startTime) existing.startTime = startTime;
    }

    this.eventLastSeen.set(info.id, now);

    if (!this.initialDataReceived) {
      this.initialDataReceived = true;
      this.logger.log('BetBoom: first match received — signaling markets ready');
      this.onAllMarketsReady?.();
    } else {
      this.onPriceUpdate?.();
    }
  }

  /**
   * NewslettersStakeResponse: {code(1), status(2), error(3), action(4), stake(5)}
   * Updates a single stake (odds change) in an existing event.
   */
  private handleStakeNewsletter(raw: Buffer): void {
    const f = parseMsg(raw);
    if (!f[5]) return;

    const stake = parseStake(f[5] as Buffer);
    if (!stake.matchId || stake.matchId === '0') return;

    const event = this.eventCache.get(stake.matchId);
    if (!event) return;

    // Find and update the specific outcome in the matching market
    const marketKey = `${stake.matchId}_${stake.groupName || stake.marketName}`;
    const market = event.markets.find((m) => m.marketId === marketKey);
    if (market) {
      const outcome = market.outcomes.find((o) => o.name === stake.name);
      if (outcome && outcome.price !== stake.factor) {
        outcome.price = stake.factor;
        event.updatedAt = Date.now();
        this.eventLastSeen.set(stake.matchId, Date.now());
        this.onPriceUpdate?.();
      }
    }
  }

  // ── Stale eviction ──────────────────────────────────────────────

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
      }
    }
  }
}
