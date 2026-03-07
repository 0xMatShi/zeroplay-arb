import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PolymarketSportsAdapter } from '../adapters/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../adapters/dexsport/dexsport.adapter';
import { SportsMatcher } from '../services/sports-matcher.service';
import { SportsArbScanner } from '../services/sports-arb-scanner.service';
import { SportsMatch, SportsArbitrageOpportunity } from '../interfaces/sports-arb.types';

/** Debounce delay for reactive scans (ms). Prevents scanning on every single WS tick. */
const SCAN_DEBOUNCE_MS = 200;

/**
 * Sports Arbitrage pipeline:
 *
 *  Cron (every 5 min): Re-match Polymarket sports events with DexSport events.
 *  Reactive:           On any price change from either WS, debounced re-scan
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

  /** Debounce timer for reactive scans */
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Initial delay timer */
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
    private readonly matcher: SportsMatcher,
    private readonly scanner: SportsArbScanner,
  ) {}

  onModuleInit(): void {
    // Register reactive price change handlers on both adapters
    const handler = () => this.scheduleScan();
    this.polyAdapter.onPriceUpdate = handler;
    this.dexAdapter.onPriceUpdate = handler;

    // Wait for WS adapters to receive initial data, then run first match cycle
    this.initTimer = setTimeout(() => this.runMatchCycle(), 30_000);
  }

  onModuleDestroy(): void {
    if (this.scanDebounceTimer) { clearTimeout(this.scanDebounceTimer); this.scanDebounceTimer = null; }
    if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null; }
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

      // Immediately scan after fresh match
      this.runScanNow();
    } catch (err: any) {
      this.logger.error(`Sports match cycle failed: ${err.message}`);
    }
  }

  // ── Reactive scan (debounced, triggered by WS price changes) ──

  /**
   * Called by adapter price change callbacks.
   * Debounces to avoid scanning on every WS tick.
   */
  private scheduleScan(): void {
    if (this.scanDebounceTimer) return; // already scheduled
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null;
      this.runScanNow();
    }, SCAN_DEBOUNCE_MS);
  }

  private runScanNow(): void {
    if (this.currentMatches.length === 0) return;

    try {
      this.currentOpportunities = this.scanner.scan(this.currentMatches);
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
