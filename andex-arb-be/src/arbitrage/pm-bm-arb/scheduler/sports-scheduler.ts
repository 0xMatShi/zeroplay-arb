import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import { SportsMatcher } from '../services/sports-matcher.service';
import { SportsArbScanner } from '../services/sports-arb-scanner.service';
import { SportsMatch, SportsArbitrageOpportunity } from '../interfaces/sports-arb.types';
import { SportsArbGateway } from '../gateways/sports-arb.gateway';

/**
 * Sports Arbitrage pipeline (phased discovery):
 *
 *  Phase 1 (DEX): Subscribe to disciplines → tournaments → events → mainMarketIds.
 *                 Wait until every event has a Match Winner market confirmed.
 *  Phase 2 (DEX): Subscribe to remaining marketIds per event (Totals, Handicap, Map N, ...).
 *                 Wait until market data received or 15s timeout.
 *  Match cycle:   Fetch fresh PM events → text+startTime matching → subscribe WS to
 *                 matched events on both platforms.
 *  Hourly reset:  Reset DEX phase state → repeat discovery.
 *
 *  Cron (every 10s): Refresh PM order books via REST → immediate re-scan.
 *  Reactive:         On any price change from either WS, throttled re-scan (200ms).
 */
@Injectable()
export class SportsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SportsScheduler.name);

  /** Current matched pairs — updated by match cycle, read by reactive scan */
  private currentMatches: SportsMatch[] = [];

  /** Latest detected opportunities */
  private currentOpportunities: SportsArbitrageOpportunity[] = [];

  /** Tracks when each opportunity was first detected (by stable ID) */
  private firstSeenMap: Map<string, number> = new Map();

  /** Debounce timer for reactive price-update scans */
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SCAN_DEBOUNCE_MS = 200;

  /** Guard against concurrent match cycles */
  private matchingInProgress = false;

  /** Guard against concurrent books fetches */
  private booksFetchInProgress = false;

  /**
   * PM token IDs for currently matched markets (updated after each match cycle).
   * Used for WS subscription and REST books — covers ALL matched market types,
   * not just main ones.
   */
  private matchedPmTokenIds: string[] = [];

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
    private readonly matcher: SportsMatcher,
    private readonly scanner: SportsArbScanner,
    @Optional() private readonly gateway: SportsArbGateway | null = null,
  ) {}

  onModuleInit(): void {
    // Register reactive price change handlers on both adapters (debounced)
    const handler = () => this.scheduleScan();
    this.polyAdapter.onPriceUpdate = handler;
    this.dexAdapter.onPriceUpdate = handler;

    // When DEX signals all markets are ready, run a full match cycle
    this.dexAdapter.onAllMarketsReady = () => this.onDexMarketsReady();
  }

  onModuleDestroy(): void {
    if (this.scanDebounceTimer) { clearTimeout(this.scanDebounceTimer); this.scanDebounceTimer = null; }
    this.polyAdapter.onPriceUpdate = null;
    this.dexAdapter.onPriceUpdate = null;
    this.dexAdapter.onAllMarketsReady = null;
  }

  // ── Cron: hourly discovery reset ──────────────────────────────

  /**
   * Every hour: reset DEX phase state to restart market discovery.
   * DEX will re-check cached data and fire onAllMarketsReady → match cycle runs.
   */
  @Cron('0 0 * * * *')
  async handleHourlyCron(): Promise<void> {
    this.logger.log('Hourly cycle: resetting DEX discovery phase');
    this.dexAdapter.resetPhaseState();
    // resetPhaseState → checkPhase1Complete → startPhase2 → fireAllMarketsReady
    // → onDexMarketsReady (if cache is hot, this happens synchronously)
  }

  // ── Cron: Refresh PM order books every second ─────────────────

  @Cron('* * * * * *')
  async handleBooksCron(): Promise<void> {
    if (this.matchedPmTokenIds.length === 0) return;
    if (this.booksFetchInProgress) return;
    this.booksFetchInProgress = true;
    try {
      await this.polyAdapter.fetchBooksForTokens(this.matchedPmTokenIds);
      this.runScanNow();
    } finally {
      this.booksFetchInProgress = false;
    }
  }

  // ── DEX ready callback ────────────────────────────────────────

  /**
   * Called by DexsportAdapter once all events have Match Winner and phase 2 is done.
   * Fetches fresh PM events and runs a full match cycle.
   */
  private async onDexMarketsReady(): Promise<void> {
    if (this.matchingInProgress) {
      this.logger.warn('DEX ready signal received but match cycle already in progress, skipping');
      return;
    }
    this.matchingInProgress = true;
    try {
      this.logger.log('DEX markets ready — fetching PM events and running match cycle');
      await this.polyAdapter.forceFetch();
      await this.runMatchCycle();
    } catch (err: any) {
      this.logger.error(`Match cycle failed after DEX ready signal: ${err.message}`);
    } finally {
      this.matchingInProgress = false;
    }
  }

  // ── Match cycle ───────────────────────────────────────────────

  async runMatchCycle(): Promise<void> {
    try {
      this.currentMatches = this.matcher.findMatches();

      const liveCount = this.currentMatches.filter((m) => m.dexEvent.isLive).length;
      const totalMarkets = this.currentMatches.reduce((s, m) => s + m.matchedMarkets.length, 0);
      this.logger.log(
        `Sports match cycle: ${this.currentMatches.length} pairs (${liveCount} live), ${totalMarkets} matched markets`,
      );

      // Collect PM token IDs and DEX market IDs for ALL matched market types
      // (moneyline, totals, handicap, map N — everything the matcher found)
      const pmTokenSet = new Set<string>();
      const dexEntries: Array<{ eventId: string; marketId: string }> = [];
      const dexTracked = new Set<string>();

      for (const m of this.currentMatches) {
        for (const mp of m.matchedMarkets) {
          // PM: collect tokens for this specific market (not all event tokens)
          for (const tokenId of mp.pmMarket.tokenIds) pmTokenSet.add(tokenId);
          // DEX: collect market entries for explicit post-match subscription
          dexEntries.push({ eventId: m.dexEvent.eventId, marketId: mp.dexMarket.marketId });
          dexTracked.add(mp.dexMarket.marketId);
        }
      }

      this.matchedPmTokenIds = [...pmTokenSet];

      if (this.matchedPmTokenIds.length > 0) {
        // Subscribe PM CLOB WS to matched market tokens only
        this.polyAdapter.subscribeToMatchedTokens(this.matchedPmTokenIds);
      } else {
        this.logger.warn('No matched markets found — PM WS not subscribed');
      }

      if (dexEntries.length > 0) {
        // Ensure all matched DEX markets are subscribed (safety net for any missed in phase 2)
        this.dexAdapter.subscribeToMatchedMarkets(dexEntries);
      }

      // Update DEX tracked market IDs for debug logging
      this.dexAdapter.trackedMarketIds = dexTracked;

      // Immediately scan after fresh match (no debounce — explicit trigger)
      this.runScanNow();
    } catch (err: any) {
      this.logger.error(`Sports match cycle failed: ${err.message}`);
    }
  }

  // ── Reactive scanning ─────────────────────────────────────────

  /** Throttle reactive scans: run at most once per SCAN_DEBOUNCE_MS */
  private scheduleScan(): void {
    if (this.scanDebounceTimer) return;
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null;
      this.runScanNow();
    }, this.SCAN_DEBOUNCE_MS);
  }

  private runScanNow(): void {
    if (this.currentMatches.length === 0) return;
    this.logger.debug(`[SCAN] running, matches=${this.currentMatches.length}`);

    try {
      const scanned = this.scanner.scan(this.currentMatches);
      this.logger.debug(`[SCAN] result: ${scanned.length} opportunities`);
      const matchMap = new Map(this.currentMatches.map((m) => [m.id, m]));

      const now = Date.now();
      const prevById = new Map(this.currentOpportunities.map((o) => [o.id, o]));
      const activeIds = new Set<string>();

      for (const opp of scanned) {
        const first = this.firstSeenMap.get(opp.id) ?? now;
        this.firstSeenMap.set(opp.id, first);
        opp.firstDetectedAt = first;
        activeIds.add(opp.id);

        if (this.gateway) {
          if (!prevById.has(opp.id)) {
            this.logger.debug(`[SCAN] emitNew: ${opp.id} profit=${opp.profitPercent.toFixed(2)}%`);
            this.gateway.emitNew(opp, matchMap);
          } else {
            const prev = prevById.get(opp.id)!;
            const delta = Math.abs(prev.profitPercent - opp.profitPercent);
            if (delta > 0.01) {
              this.logger.debug(`[SCAN] emitUpdated: ${opp.id}`);
              this.gateway.emitUpdated(opp, matchMap);
            }
          }
        }
      }

      if (this.gateway) {
        for (const id of prevById.keys()) {
          if (!activeIds.has(id)) {
            this.gateway.emitExpired(id);
          }
        }
      }

      for (const id of this.firstSeenMap.keys()) {
        if (!activeIds.has(id)) this.firstSeenMap.delete(id);
      }

      this.currentOpportunities = scanned;
    } catch (err: any) {
      this.logger.error(`Sports scan cycle failed: ${err.message}`);
    }
  }

  // ── Public API (for controller/gateway) ────────────────────────

  getMatches(): SportsMatch[] {
    return this.currentMatches;
  }

  getOpportunities(): SportsArbitrageOpportunity[] {
    return this.currentOpportunities;
  }
}
