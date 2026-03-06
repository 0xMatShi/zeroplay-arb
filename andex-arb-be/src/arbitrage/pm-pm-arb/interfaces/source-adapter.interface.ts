import { NormalizedEvent, PlatformInfo, ArbitrageLeg, OrderBook } from './types';

/**
 * Interface that every source adapter must implement.
 *
 * To add a new prediction market / bookmaker:
 * 1. Create a new class implementing ISourceAdapter
 * 2. Add it to providers in ArbitrageModule
 * 3. Inject AdapterRegistry and call register(this) in onModuleInit
 *
 * That's it — the engine will automatically start polling it.
 */
export interface ISourceAdapter {
  /** Unique slug identifier, e.g. "polymarket", "kalshi" */
  readonly platformSlug: string;

  /** Human-readable name, e.g. "Polymarket" */
  readonly platformName: string;

  /** Static platform info for DB seeding */
  getPlatformInfo(): PlatformInfo;

  /**
   * Fetch all active events with their current outcome prices.
   * This is the main polling method called on each cycle.
   * Should handle its own pagination and rate limiting.
   */
  fetchEvents(): Promise<NormalizedEvent[]>;

  /**
   * Fetch the order book (bids/asks) for a specific arbitrage leg.
   * Uses leg.metadata for platform-specific params (e.g. yesPos, questionId).
   *
   * Optional — not all platforms expose order book data.
   * Returns null if not supported or data unavailable.
   */
  fetchOrderBook?(leg: ArbitrageLeg): Promise<OrderBook | null>;

  /**
   * Quick health check — is the source API reachable?
   */
  healthCheck(): Promise<boolean>;
}
