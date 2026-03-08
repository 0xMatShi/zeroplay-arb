import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import { SportsMatcher } from '../services/sports-matcher.service';
import { SportsArbScanner } from '../services/sports-arb-scanner.service';
import { SportsMatch, SportsArbitrageOpportunity } from '../interfaces/sports-arb.types';

/**
 * Sports Arbitrage pipeline:
 *
 *  Cron (every 5 min): Re-match Polymarket sports events with DexSport events.
 *  Reactive:           On any price change from either WS, immediate re-scan
 *                      of all matched pairs for arbitrage.
 *
 * Both adapters maintain persistent WS connections. Prices are updated
 * in-place on the cached event objects, so the scanner always reads fresh data.
 */
@Injectable()
export class SportsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SportsScheduler.name);

  /** Current matched pairs — updated by cron, read by reactive scan */
  private currentMatches: SportsMatch[] = [];

  /** Latest detected opportunities */
  private currentOpportunities: SportsArbitrageOpportunity[] = [];

  /** Tracks when each opportunity was first detected (by stable ID) */
  private firstSeenMap: Map<string, number> = new Map();

  /** Initial delay timer */
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounce timer for reactive price-update scans */
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SCAN_DEBOUNCE_MS = 200;

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
    private readonly matcher: SportsMatcher,
    private readonly scanner: SportsArbScanner,
  ) {}

  onModuleInit(): void {
    // Register reactive price change handlers on both adapters (debounced)
    const handler = () => this.scheduleScan();
    this.polyAdapter.onPriceUpdate = handler;
    this.dexAdapter.onPriceUpdate = handler;

    // Wait for WS adapters to receive initial data, then run first match cycle
    this.initTimer = setTimeout(() => this.runMatchCycle(), 30_000);
  }

  onModuleDestroy(): void {
    if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null; }
    if (this.scanDebounceTimer) { clearTimeout(this.scanDebounceTimer); this.scanDebounceTimer = null; }
    this.polyAdapter.onPriceUpdate = null;
    this.dexAdapter.onPriceUpdate = null;
  }

  // ── Cron: Re-match events every 5 minutes ─────────────────────

  @Cron('0 */5 * * * *')
  async handleMatchCron(): Promise<void> {
    await this.runMatchCycle();
  }

  async runMatchCycle(): Promise<void> {
    try {
      this.currentMatches = this.matcher.findMatches();
      this.logger.log(`Sports match cycle: ${this.currentMatches.length} matched pairs`);

      // Subscribe PM WS only to live events (pre-match markets have very low WS activity)
      const liveMatches = this.currentMatches.filter((m) => m.dexEvent.isLive);
      const liveEventIds = [...new Set(liveMatches.map((m) => m.pmEvent.id))];
      this.logger.log(`Sports match cycle: ${liveMatches.length} live matches out of ${this.currentMatches.length} total`);
      if (liveEventIds.length > 0) {
        this.polyAdapter.subscribeToMatchedEvents(liveEventIds);
      } else {
        this.logger.warn('No live matched events found — PM WS not subscribed');
      }

      // Immediately scan after fresh match (no debounce — explicit trigger)
      this.runScanNow();
    } catch (err: any) {
      this.logger.error(`Sports match cycle failed: ${err.message}`);
    }
  }

  /** Debounce reactive scans: coalesce rapid price updates into a single scan */
  private scheduleScan(): void {
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null;
      this.runScanNow();
    }, this.SCAN_DEBOUNCE_MS);
  }

  private runScanNow(): void {
    if (this.currentMatches.length === 0) return;

    try {
      const scanned = this.scanner.scan(this.currentMatches);

      // Preserve firstDetectedAt for opportunities seen in previous scans
      const now = Date.now();
      const activeIds = new Set<string>();
      for (const opp of scanned) {
        const first = this.firstSeenMap.get(opp.id) ?? now;
        this.firstSeenMap.set(opp.id, first);
        opp.firstDetectedAt = first;
        activeIds.add(opp.id);
      }

      // Remove IDs that are no longer active
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
