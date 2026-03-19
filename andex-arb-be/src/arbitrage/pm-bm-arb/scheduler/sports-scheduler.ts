import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import { PinnacleAdapter } from '../adapters/pinnacle/pinnacle.adapter';
import { StakeAdapter } from '../adapters/stake/stake.adapter';
import { CloudbetAdapter } from '../adapters/cloudbet/cloudbet.adapter';
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

  /** Track which adapters have completed at least one full fetch */
  private dexReady = false;
  private pinnacleReady = false;
  private stakeReady = false;
  private cloudbetReady = false;
  private pmReady = false;

  /**
   * PM token IDs for currently matched markets (updated after each match cycle).
   * Used for WS subscription and REST books — covers ALL matched market types,
   * not just main ones.
   */
  private matchedPmTokenIds: string[] = [];

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
    private readonly pinnacleAdapter: PinnacleAdapter,
    private readonly stakeAdapter: StakeAdapter,
    private readonly cloudbetAdapter: CloudbetAdapter,
    private readonly matcher: SportsMatcher,
    private readonly scanner: SportsArbScanner,
    @Optional() private readonly gateway: SportsArbGateway | null = null,
  ) {}

  onModuleInit(): void {
    // Reactive price change handlers — any price update from any source triggers re-scan
    const priceHandler = () => this.scheduleScan();
    this.polyAdapter.onPriceUpdate = priceHandler;
    this.dexAdapter.onPriceUpdate = priceHandler;
    this.pinnacleAdapter.onPriceUpdate = priceHandler;
    this.stakeAdapter.onPriceUpdate = priceHandler;
    this.cloudbetAdapter.onPriceUpdate = priceHandler;

    // If Pinnacle credentials are missing it will never fire onAllMarketsReady,
    // so mark it ready immediately to avoid blocking dex + stake.
    if (!process.env.PINNACLE_USERNAME || !process.env.PINNACLE_PASSWORD) {
      this.logger.warn('Pinnacle credentials not set — treating Pinnacle as ready (no events)');
      this.pinnacleReady = true;
    }

    // If Cloudbet API key is missing it will never fire onAllMarketsReady (fires instantly with no events).
    // Mark ready immediately to not block other adapters.
    if (!process.env.CLOUDBET_API_KEY) {
      this.logger.warn('CLOUDBET_API_KEY not set — treating Cloudbet as ready (no events)');
      this.cloudbetReady = true;
    }

    // Start fetching PM events immediately — in parallel with bookmaker WS initialisation.
    // By the time all bookmakers signal ready, PM data will already be available.
    this.startPmFetch();

    // Fire match cycle once all bookmaker adapters AND PM have signalled ready.
    this.dexAdapter.onAllMarketsReady = () => {
      this.dexReady = true;
      this.checkAndTriggerMatchCycle('dexsport');
    };
    this.pinnacleAdapter.onAllMarketsReady = () => {
      this.pinnacleReady = true;
      this.checkAndTriggerMatchCycle('pinnacle');
    };
    this.stakeAdapter.onAllMarketsReady = () => {
      this.stakeReady = true;
      this.checkAndTriggerMatchCycle('stake');
    };
    this.cloudbetAdapter.onAllMarketsReady = () => {
      this.cloudbetReady = true;
      this.checkAndTriggerMatchCycle('cloudbet');
    };
  }

  onModuleDestroy(): void {
    if (this.scanDebounceTimer) { clearTimeout(this.scanDebounceTimer); this.scanDebounceTimer = null; }
    this.polyAdapter.onPriceUpdate = null;
    this.dexAdapter.onPriceUpdate = null;
    this.dexAdapter.onAllMarketsReady = null;
    this.pinnacleAdapter.onPriceUpdate = null;
    this.pinnacleAdapter.onAllMarketsReady = null;
    this.stakeAdapter.onPriceUpdate = null;
    this.stakeAdapter.onAllMarketsReady = null;
    this.cloudbetAdapter.onPriceUpdate = null;
    this.cloudbetAdapter.onAllMarketsReady = null;
  }

  // ── Cron: hourly discovery reset ──────────────────────────────

  /**
   * Every hour: reset both bookmaker adapters to restart market discovery.
   * Each adapter will re-fetch and fire onAllMarketsReady → match cycle runs
   * once both are ready again.
   */
  @Cron('0 */10 * * * *')
  async handleHourlyCron(): Promise<void> {
    this.logger.log('10-minute cycle: clearing all caches and restarting full discovery');

    // Expire all current opportunities on the frontend before resetting state
    if (this.gateway) {
      for (const opp of this.currentOpportunities) {
        this.gateway.emitExpired(opp.id);
      }
    }

    // Reset scheduler state
    this.currentMatches = [];
    this.currentOpportunities = [];
    this.firstSeenMap.clear();
    this.matchedPmTokenIds = [];

    // Reset readiness flags before adapters start re-fetching
    this.dexReady = false;
    this.pinnacleReady = false;
    this.stakeReady = false;
    this.cloudbetReady = false;
    this.pmReady = false;

    // If Pinnacle credentials are missing it will never fire onAllMarketsReady — skip it
    if (!process.env.PINNACLE_USERNAME || !process.env.PINNACLE_PASSWORD) {
      this.pinnacleReady = true;
    }
    if (!process.env.CLOUDBET_API_KEY) {
      this.cloudbetReady = true;
    }

    // Clear all adapter caches (as if just started)
    this.polyAdapter.clearCache();
    this.pinnacleAdapter.clearCache();
    this.dexAdapter.clearCache(); // also triggers WS reconnect → full rediscovery

    // Start PM fetch immediately — runs in parallel with the slow bookmaker re-logins below.
    this.startPmFetch();

    // Close existing Pinnacle + Stake WS connections BEFORE login so they don't
    // receive messages against a cleared cache during the Chrome login window.
    this.pinnacleAdapter.closeAll();
    this.stakeAdapter.closeAll();

    // Re-login: Pinnacle needs fresh session + WS URL; Stake needs fresh cf_clearance.
    // Run in parallel to save time.
    await Promise.all([
      this.pinnacleAdapter.login(),
      this.stakeAdapter.login(),
    ]);

    // Pinnacle: reconnect WS with fresh session
    this.pinnacleAdapter.resetPhaseState();

    // Stake: full reset — clear caches, re-fetch fixtures + initial odds, reconnect WS
    // clearCache() handles the full async chain internally
    this.stakeAdapter.clearCache();

    // Cloudbet: full reset — re-fetch events and reconnect WS
    this.cloudbetAdapter.clearCache();
  }

  // ── Cron: Snapshot every 5 seconds ───────────────────────────

  @Cron('*/5 * * * * *')
  handleSnapshotCron(): void {
    if (!this.gateway || this.currentOpportunities.length === 0) return;
    const matchMap = new Map(this.currentMatches.map((m) => [m.id, m]));
    this.gateway.emitSnapshot(this.currentOpportunities, matchMap);
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
   * Called when both bookmaker adapters have signalled they are ready.
   * Fetches fresh PM events and runs a full match cycle.
   */
  private startPmFetch(): void {
    this.polyAdapter.forceFetch()
      .then(() => {
        this.pmReady = true;
        this.logger.log('PM events fetch complete');
        this.checkAndTriggerMatchCycle('polymarket');
      })
      .catch((err: any) => this.logger.error(`PM events fetch failed: ${err.message}`));
  }

  private checkAndTriggerMatchCycle(source: string): void {
    if (this.dexReady && this.pinnacleReady && this.stakeReady && this.cloudbetReady && this.pmReady) {
      this.onBookmakerMarketsReady(source);
    }
  }

  private async onBookmakerMarketsReady(source: string): Promise<void> {
    if (this.matchingInProgress) {
      this.logger.warn(`${source} ready signal received but match cycle already in progress, skipping`);
      return;
    }
    this.matchingInProgress = true;
    try {
      this.logger.log(`All bookmakers + PM ready (triggered by ${source}) — running match cycle`);
      await this.runMatchCycle();
    } catch (err: any) {
      this.logger.error(`Match cycle failed after ${source} ready signal: ${err.message}`);
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

      // Collect PM token IDs and bookmaker market IDs for ALL matched market types
      // (moneyline, totals, handicap, map N — everything the matcher found)
      const pmTokenSet = new Set<string>();
      const dexEntries: Array<{ eventId: string; marketId: string }> = [];
      const pinnacleEntries: Array<{ eventId: string; marketId: string }> = [];
      const stakeEntries: Array<{ eventId: string; marketId: string }> = [];
      const cloudbetEntries: Array<{ eventId: string; marketId: string }> = [];
      const dexTracked = new Set<string>();
      const pinnacleTracked = new Set<string>();
      const stakeTracked = new Set<string>();
      const cloudbetTracked = new Set<string>();

      for (const m of this.currentMatches) {
        for (const mp of m.matchedMarkets) {
          for (const tokenId of mp.pmMarket.tokenIds) pmTokenSet.add(tokenId);
          if (m.bookmakerPlatform === 'dexsport') {
            dexEntries.push({ eventId: m.dexEvent.eventId, marketId: mp.dexMarket.marketId });
            dexTracked.add(mp.dexMarket.marketId);
          } else if (m.bookmakerPlatform === 'stake') {
            stakeEntries.push({ eventId: m.dexEvent.eventId, marketId: mp.dexMarket.marketId });
            stakeTracked.add(mp.dexMarket.marketId);
          } else if (m.bookmakerPlatform === 'cloudbet') {
            cloudbetEntries.push({ eventId: m.dexEvent.eventId, marketId: mp.dexMarket.marketId });
            cloudbetTracked.add(mp.dexMarket.marketId);
          } else {
            pinnacleEntries.push({ eventId: m.dexEvent.eventId, marketId: mp.dexMarket.marketId });
            pinnacleTracked.add(mp.dexMarket.marketId);
          }
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
        this.dexAdapter.subscribeToMatchedMarkets(dexEntries);
      }
      if (pinnacleEntries.length > 0) {
        this.pinnacleAdapter.subscribeToMatchedMarkets(pinnacleEntries);
      }
      // Stake/Cloudbet: subscribeToMatchedMarkets is a no-op (push-based)
      if (stakeEntries.length > 0) {
        this.stakeAdapter.subscribeToMatchedMarkets(stakeEntries);
      }
      if (cloudbetEntries.length > 0) {
        this.cloudbetAdapter.subscribeToMatchedMarkets(cloudbetEntries);
      }

      // Update tracked market IDs for debug logging
      this.dexAdapter.trackedMarketIds = dexTracked;
      this.pinnacleAdapter.trackedMarketIds = pinnacleTracked;
      this.stakeAdapter.trackedMarketIds = stakeTracked;
      this.cloudbetAdapter.trackedMarketIds = cloudbetTracked;

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

    try {
      const scanned = this.scanner.scan(this.currentMatches);
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
            this.gateway.emitNew(opp, matchMap);
          } else {
            const prev = prevById.get(opp.id)!;
            const profitChanged = Math.abs(prev.profitPercent - opp.profitPercent) > 0.001;
            const oddsChanged = opp.legs.some((leg, i) => {
              const prevLeg = prev.legs[i];
              return prevLeg && Math.abs(prevLeg.decimalOdds - leg.decimalOdds) > 0.001;
            });
            if (profitChanged || oddsChanged) {
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
