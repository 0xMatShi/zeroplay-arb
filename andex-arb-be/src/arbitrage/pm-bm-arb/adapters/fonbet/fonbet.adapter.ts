/**
 * FonbetAdapter — HTTP delta-polling adapter for fon.bet.
 *
 * Protocol: versioned delta polling against line-lb54-w.bk6bba-resources.com
 *   GET /ma/events/list?version=0    → full snapshot (events + sports + customFactors)
 *   GET /ma/events/list?version={N}  → only changes since last response
 *
 * Markets:
 *   Regular moneyline (no draw):  921=П1, 923=П2
 *   "Итоговая победа" (with OT):  7035=П1, 7036=П2  — used when draw (922) is offered
 *
 * Inclusion logic:
 *   - No draw offered                   → include (921/923)
 *   - Draw offered + "Итоговая победа"  → include (7035/7036)
 *   - Draw offered, no "Итоговая победа"→ exclude
 *
 * Sports:  hockey, basketball, tennis, baseball, cs2, dota2, lol, valorant
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { DexSportsEvent, DexMarket, DexOutcome } from '../../interfaces/sports-arb.types';
import {
  FonbetSportEntry,
  FonbetEvent,
  FonbetCustomFactors,
  FonbetListResponse,
} from './fonbet.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const LINE_BASE         = 'https://line-lb54-w.bk6bba-resources.com';
const SCOPE_MARKET      = 1600;
const LANG              = 'en';
const POLL_INTERVAL_MS  = 1_000;
const EVENT_TTL_MS      = 5 * 60_000;
const EVICT_INTERVAL_MS = 60_000;

/**
 * Factor IDs tracked for market decisions.
 * 921=П1, 922=X(draw), 923=П2          — regular time 3-way / 2-way outcome
 * 7035=П1 winner OT, 7036=П2 winner OT — "Итоговая победа" (includes overtime/shootout)
 */
const TRACKED_FACTORS = new Set([921, 922, 923, 7035, 7036]);

/** esport sportKeys that have per-map sub-events (level=2) */
const ESPORT_SPORT_KEYS = new Set(['csgo', 'dota2', 'lol', 'valorant']);

/** Root sport IDs in the fonbet sports hierarchy */
const TARGET_ROOT_SPORT_IDS = new Set([2, 3, 4, 5]); // hockey, basketball, tennis, baseball
const ROOT_SPORT_KEY: Record<number, string> = {
  2: 'hockey',
  3: 'basketball',
  4: 'tennis',
  5: 'baseball',
};
const ESPORT_ROOT_ID = 29086;

// ── Adapter ───────────────────────────────────────────────────────────────────

@Injectable()
export class FonbetAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FonbetAdapter.name);

  // ── Contract (shared with all bookmaker adapters) ──────────────────────────
  onPriceUpdate: (() => void) | null = null;
  onAllMarketsReady: (() => void) | null = null;
  trackedMarketIds: Set<string> = new Set();

  // ── Internal state ─────────────────────────────────────────────────────────
  /** segmentId → sportKey — built from sports[] on first snapshot */
  private readonly segmentSportKey = new Map<number, string>();

  /** eventId → raw fonbet event */
  private readonly eventMeta = new Map<number, FonbetEvent>();

  /** eventId → { factorId → { v: decimal odds, pt: handicap/total line text } } */
  private readonly oddsCache = new Map<number, Map<number, { v: number; pt?: string }>>();

  /** eventId → DexSportsEvent (exposed to pipeline) */
  private readonly eventCache = new Map<string, DexSportsEvent>();

  /** eventId (string) → timestamp of last update */
  private readonly eventLastSeen = new Map<string, number>();

  private currentVersion = 0;
  private initialStateFired = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  // ── NestJS lifecycle ───────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.pollOnce(); // initial snapshot — fires onAllMarketsReady
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
    this.evictTimer = setInterval(() => this.evictStale(), EVICT_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer)  { clearInterval(this.pollTimer);  this.pollTimer = null; }
    if (this.evictTimer) { clearInterval(this.evictTimer); this.evictTimer = null; }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getEvents(): DexSportsEvent[] {
    return Array.from(this.eventCache.values());
  }

  /** Push-based — no per-market subscription needed */
  subscribeToMatchedMarkets(_entries: Array<{ eventId: string; marketId: string }>): void {}

  clearCache(): void {
    this.logger.log('Fonbet: clearing caches and restarting polling');
    this.segmentSportKey.clear();
    this.eventMeta.clear();
    this.oddsCache.clear();
    this.eventCache.clear();
    this.eventLastSeen.clear();
    this.currentVersion = 0;
    this.initialStateFired = false;
    // Next poll tick will do a full snapshot (version=0)
  }

  resetPhaseState(): void {
    this.clearCache();
  }

  /** No login needed — public endpoint */
  async login(): Promise<void> {}

  closeAll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Sport classification ───────────────────────────────────────────────────

  private buildSegmentMap(sports: FonbetSportEntry[]): void {
    const byId = new Map<number, FonbetSportEntry>();
    for (const s of sports) byId.set(s.id, s);

    const rootOf = (id: number): FonbetSportEntry | null => {
      let cur = byId.get(id);
      const visited = new Set<number>();
      while (cur && cur.kind !== 'sport') {
        if (visited.has(cur.id)) break;
        visited.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return cur ?? null;
    };

    for (const s of sports) {
      if (s.kind !== 'segment') continue;
      const root = rootOf(s.id);
      if (!root) continue;

      if (TARGET_ROOT_SPORT_IDS.has(root.id)) {
        this.segmentSportKey.set(s.id, ROOT_SPORT_KEY[root.id]);
      } else if (root.id === ESPORT_ROOT_ID) {
        const key = FonbetAdapter.classifyEsport(s.name);
        if (key) this.segmentSportKey.set(s.id, key);
      }
    }
  }

  private static classifyEsport(segmentName: string): string | null {
    if (/counter.strike|^cs2/i.test(segmentName)) return 'csgo';
    if (/dota\s*2/i.test(segmentName)) return 'dota2';
    if (/\blol\b|league of legends/i.test(segmentName)) return 'lol';
    if (/valorant/i.test(segmentName)) return 'valorant';
    return null;
  }

  private getSportKey(event: FonbetEvent): string | null {
    return this.segmentSportKey.get(event.sportId) ?? null;
  }

  /** Returns true for top-level match events in target sports */
  private isTargetMatch(e: FonbetEvent): boolean {
    if (e.level !== 1 || e.kind !== 1 || e.noEventView || this.getSportKey(e) === null) return false;
    // Exclude derived markets (e.g. "AWP Kills") where team names have a market suffix in parentheses
    if (/\(/.test(e.team1 ?? '')) return false;
    return true;
  }

  /**
   * Returns true for esport map sub-events (level=2, e.g. "1-я карта").
   * Only valid once parent event meta is already in eventMeta.
   */
  private isTargetMapEvent(e: FonbetEvent): boolean {
    if (e.level !== 2 || !e.parentId || e.noEventView) return false;
    const parent = this.eventMeta.get(e.parentId);
    if (!parent || !this.isTargetMatch(parent)) return false;
    const sportKey = this.getSportKey(parent);
    return ESPORT_SPORT_KEYS.has(sportKey ?? '') && FonbetAdapter.parseMapNumber(e.name) !== null;
  }

  /** Extracts map number from names like "1st map", "2nd map", "3rd map" (lang=en). */
  private static parseMapNumber(name: string): number | null {
    const m = name.match(/^(\d+)(?:st|nd|rd|th)\s+map$/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // ── HTTP polling ───────────────────────────────────────────────────────────

  private async pollOnce(): Promise<void> {
    if (this.destroyed) return;
    try {
      const data = await this.fetchList(this.currentVersion);

      if (data.sports?.length) this.buildSegmentMap(data.sports);
      if (data.events?.length) this.applyEvents(data.events);
      if (data.customFactors?.length) this.applyCustomFactors(data.customFactors);

      const wasFirst = this.currentVersion === 0;
      this.currentVersion = data.packetVersion;

      if (wasFirst) {
        const count = this.eventCache.size;
        this.logger.log(`Fonbet: initial snapshot — ${count} events, version=${data.packetVersion}`);
        this.initialStateFired = true;
        this.onAllMarketsReady?.();
      }
    } catch (err: any) {
      if (!this.destroyed) this.logger.warn(`Fonbet: poll error — ${err.message}`);
    }
  }

  private async fetchList(version: number): Promise<FonbetListResponse> {
    const res = await axios.get<FonbetListResponse>(`${LINE_BASE}/ma/events/list`, {
      params: { lang: LANG, version, scopeMarket: SCOPE_MARKET },
      timeout: 10_000,
      headers: { Accept: 'application/json', Referer: 'https://fon.bet/' },
    });
    return res.data;
  }

  // ── State updaters ─────────────────────────────────────────────────────────

  private applyEvents(events: FonbetEvent[]): void {
    for (const e of events) {
      this.eventMeta.set(e.id, e);
      if (this.isTargetMatch(e)) {
        if (!this.oddsCache.has(e.id)) this.oddsCache.set(e.id, new Map());
        this.syncEvent(e.id);
      } else if (this.isTargetMapEvent(e)) {
        if (!this.oddsCache.has(e.id)) this.oddsCache.set(e.id, new Map());
        this.syncMapEvent(e.id);
      }
    }
  }

  private applyCustomFactors(items: FonbetCustomFactors[]): void {
    for (const item of items) {
      const event = this.eventMeta.get(item.e);

      if (event && this.isTargetMatch(event)) {
        // ── Target main match ─────────────────────────────────────────────────
        // Store ALL factors (totals and handicaps use non-moneyline factor IDs).
        this.eventLastSeen.set(String(item.e), Date.now());

        const prevMap = this.oddsCache.get(item.e) ?? new Map<number, { v: number; pt?: string }>();
        let changed = false;
        for (const f of item.factors) {
          const prev = prevMap.get(f.f);
          if (f.v === 0) {
            if (prevMap.has(f.f)) { prevMap.delete(f.f); changed = true; }
          } else if (prev?.v !== f.v || prev?.pt !== f.pt) {
            prevMap.set(f.f, { v: f.v, pt: f.pt });
            changed = true;
          }
        }
        this.oddsCache.set(item.e, prevMap);
        if (changed) {
          this.syncEvent(item.e);
          if (this.initialStateFired) this.onPriceUpdate?.();
        }
      } else if (event && this.isTargetMapEvent(event)) {
        // ── Esport map sub-event (level=2) ────────────────────────────────────
        this.eventLastSeen.set(String(item.e), Date.now());

        const prevMap = this.oddsCache.get(item.e) ?? new Map<number, { v: number; pt?: string }>();
        let changed = false;
        for (const f of item.factors) {
          if (f.f !== 921 && f.f !== 923) continue; // only home/away for map outcomes
          const prev = prevMap.get(f.f);
          if (f.v === 0) {
            if (prevMap.has(f.f)) { prevMap.delete(f.f); changed = true; }
          } else if (prev?.v !== f.v) {
            prevMap.set(f.f, { v: f.v });
            changed = true;
          }
        }
        this.oddsCache.set(item.e, prevMap);
        if (changed) {
          this.syncMapEvent(item.e);
          if (this.initialStateFired) this.onPriceUpdate?.();
        }
      } else {
        // ── Non-target event: update odds cache only (event meta may arrive later) ──
        const map = this.oddsCache.get(item.e) ?? new Map<number, { v: number; pt?: string }>();
        for (const f of item.factors) {
          if (!TRACKED_FACTORS.has(f.f)) continue;
          if (f.v === 0) map.delete(f.f);
          else map.set(f.f, { v: f.v, pt: f.pt });
        }
        this.oddsCache.set(item.e, map);
      }
    }
  }

  // ── Event cache sync ───────────────────────────────────────────────────────

  private syncEvent(id: number): void {
    const event = this.eventMeta.get(id);
    if (!event || !this.isTargetMatch(event)) return;

    const sportKey = this.getSportKey(event)!;
    const odds = this.oddsCache.get(id);
    const now = Date.now();
    const eventId = String(id);

    const hasDraw     = !!(odds?.get(922));
    const hasWinnerOT = !!(odds?.get(7035));

    if (hasDraw && !hasWinnerOT) {
      this.eventCache.delete(eventId);
      return;
    }

    const moneylineMarket = this.buildMoneylineMarket(id, event, odds, hasDraw);
    const extraMarkets = this.buildTotalsAndHandicaps(id, event, odds);

    this.eventLastSeen.set(eventId, now);

    if (!moneylineMarket) {
      return;
    }

    const existing = this.eventCache.get(eventId);
    if (!existing) {
      this.eventCache.set(eventId, {
        eventId,
        name: this.buildEventName(event),
        sportKey,
        isLive: event.place === 'live',
        startTime: event.startTime,
        url: this.buildEventUrl(event, sportKey),
        markets: [moneylineMarket, ...extraMarkets],
        updatedAt: now,
      });
      return;
    }

    existing.isLive = event.place === 'live';
    existing.updatedAt = now;

    const prevMarket = existing.markets[0];
    if (prevMarket) {
      let priceChanged = false;

      for (let i = 0; i < Math.min(prevMarket.outcomes.length, moneylineMarket.outcomes.length); i++) {
        const np = moneylineMarket.outcomes[i].price;
        if (np !== prevMarket.outcomes[i].price) {
          if (this.trackedMarketIds.has(prevMarket.marketId)) {
            const arrow = np > prevMarket.outcomes[i].price ? '↑' : '↓';
            this.logger.log(
              `[Fonbet] ${existing.name}: ${prevMarket.outcomes[i].name} ` +
              `${prevMarket.outcomes[i].price?.toFixed(3)} → ${np.toFixed(3)} ${arrow}`,
            );
          }
          prevMarket.outcomes[i] = { ...prevMarket.outcomes[i], price: np };
          priceChanged = true;
        }
      }

      // Replace totals/handicap markets wholesale (indices 1+)
      existing.markets.splice(1, existing.markets.length - 1, ...extraMarkets);

      if (priceChanged && this.initialStateFired) this.onPriceUpdate?.();
    } else {
      existing.markets[0] = moneylineMarket;
      existing.markets.splice(1, existing.markets.length - 1, ...extraMarkets);
    }
  }

  private syncMapEvent(id: number): void {
    const event = this.eventMeta.get(id);
    if (!event || !this.isTargetMapEvent(event)) return;

    const parent = this.eventMeta.get(event.parentId!)!;
    const sportKey = this.getSportKey(parent)!;
    const mapN = FonbetAdapter.parseMapNumber(event.name)!;
    const odds = this.oddsCache.get(id);
    const p1 = odds?.get(921)?.v;
    const p2 = odds?.get(923)?.v;
    const now = Date.now();
    const eventId = String(id);

    this.eventLastSeen.set(eventId, now);

    if (!p1 || !p2) {
      return;
    }

    const mapMarket: DexMarket = {
      marketId: `fonbet_${id}_map${mapN}`,
      marketType: 'child_moneyline',
      name: `child_moneyline_map${mapN}`,
      outcomes: [
        { name: parent.team1, price: p1 },
        { name: parent.team2 ?? 'Team 2', price: p2 },
      ],
    };

    const existing = this.eventCache.get(eventId);
    if (!existing) {
      this.eventCache.set(eventId, {
        eventId,
        name: this.buildEventName(parent),
        sportKey,
        isLive: parent.place === 'live',
        startTime: parent.startTime,
        url: this.buildEventUrl(parent, sportKey),
        markets: [mapMarket],
        updatedAt: now,
      });
      return;
    }

    existing.isLive = parent.place === 'live';
    existing.updatedAt = now;

    const prevMarket = existing.markets[0];
    if (prevMarket) {
      let priceChanged = false;
      for (let i = 0; i < Math.min(prevMarket.outcomes.length, mapMarket.outcomes.length); i++) {
        const np = mapMarket.outcomes[i].price;
        if (np !== prevMarket.outcomes[i].price) {
          if (this.trackedMarketIds.has(prevMarket.marketId)) {
            const arrow = np > prevMarket.outcomes[i].price ? '↑' : '↓';
            this.logger.log(
              `[Fonbet Map${mapN}] ${existing.name}: ${prevMarket.outcomes[i].name} ` +
              `${prevMarket.outcomes[i].price?.toFixed(3)} → ${np.toFixed(3)} ${arrow}`,
            );
          }
          prevMarket.outcomes[i] = { ...prevMarket.outcomes[i], price: np };
          priceChanged = true;
        }
      }
      if (priceChanged && this.initialStateFired) this.onPriceUpdate?.();
    } else {
      existing.markets[0] = mapMarket;
    }
  }

  private buildEventName(event: FonbetEvent): string {
    if (event.team2) return `${event.team1} vs ${event.team2}`;
    return event.name || event.team1;
  }

  private buildEventUrl(event: FonbetEvent, sportKey: string): string {
    const ESPORT_CATEGORY: Record<string, string> = {
      csgo:     'cs',
      dota2:    'dota2',
      lol:      'lol',
      valorant: 'valorant',
    };
    const SPORT_SLUG: Record<string, string> = {
      hockey:     'hockey',
      basketball: 'basketball',
      tennis:     'tennis',
      baseball:   'baseball',
    };
    const esportCat = ESPORT_CATEGORY[sportKey];
    if (esportCat) {
      return `https://fon.bet/sports/esports/category/${esportCat}/${event.sportId}/${event.id}`;
    }
    const slug = SPORT_SLUG[sportKey];
    if (!slug) return '';
    return `https://fon.bet/sports/${slug}/${event.sportId}/${event.id}`;
  }

  private buildTotalsAndHandicaps(
    id: number,
    event: FonbetEvent,
    odds: Map<number, { v: number; pt?: string }> | undefined,
  ): DexMarket[] {
    if (!odds) return [];

    const markets: DexMarket[] = [];

    const totalsByPt      = new Map<string, Array<{ f: number; v: number }>>();
    const handicapsByAbs  = new Map<string, Array<{ f: number; v: number; pt: string }>>();

    for (const [factorId, entry] of odds) {
      if (!entry.pt || entry.v === 0) continue;
      const pt = entry.pt.trim();
      if (pt.startsWith('+') || pt.startsWith('-')) {
        const absVal = pt.replace(/^[+-]/, '');
        const arr = handicapsByAbs.get(absVal) ?? [];
        arr.push({ f: factorId, v: entry.v, pt });
        handicapsByAbs.set(absVal, arr);
      } else {
        const arr = totalsByPt.get(pt) ?? [];
        arr.push({ f: factorId, v: entry.v });
        totalsByPt.set(pt, arr);
      }
    }

    for (const [ptValue, factors] of totalsByPt) {
      if (factors.length !== 2) continue;
      factors.sort((a, b) => a.f - b.f);
      const [over, under] = factors;
      markets.push({
        marketId:   `fonbet_${id}_total_${ptValue}`,
        marketType: 'totals',
        name:       'Total',
        outcomes: [
          { name: `Over ${ptValue}`,  price: over.v },
          { name: `Under ${ptValue}`, price: under.v },
        ],
      });
    }

    for (const [, factors] of handicapsByAbs) {
      if (factors.length !== 2) continue;
      factors.sort((a, b) => a.f - b.f);
      const [t1, t2] = factors;
      markets.push({
        marketId:   `fonbet_${id}_hcp_${t1.pt}`,
        marketType: 'spreads',
        name:       'Handicap',
        outcomes: [
          { name: `${event.team1} ${t1.pt}`,             price: t1.v },
          { name: `${event.team2 ?? 'Team 2'} ${t2.pt}`, price: t2.v },
        ],
      });
    }

    return markets;
  }

  private buildMoneylineMarket(
    id: number,
    event: FonbetEvent,
    odds: Map<number, { v: number; pt?: string }> | undefined,
    hasDraw: boolean,
  ): DexMarket | null {
    if (!odds) return null;

    const [f1, f2] = hasDraw ? [7035, 7036] : [921, 923];
    const p1 = odds.get(f1)?.v;
    const p2 = odds.get(f2)?.v;
    if (!p1 || !p2) return null;

    const marketSuffix = hasDraw ? '_winner_ot' : '_moneyline';
    const outcomes: DexOutcome[] = [
      { name: event.team1, price: p1 },
      { name: event.team2 ?? 'Team 2', price: p2 },
    ];

    return {
      marketId: `fonbet_${id}${marketSuffix}`,
      marketType: 'moneyline',
      name: 'moneyline',
      outcomes,
    };
  }

  // ── TTL eviction ───────────────────────────────────────────────────────────

  private evictStale(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    let evicted = 0;
    for (const [id, lastSeen] of this.eventLastSeen) {
      if (lastSeen < cutoff) {
        this.eventCache.delete(id);
        this.eventLastSeen.delete(id);
        this.eventMeta.delete(Number(id));
        this.oddsCache.delete(Number(id));
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Fonbet: evicted ${evicted} stale events (${this.eventCache.size} remaining)`);
    }
  }
}
