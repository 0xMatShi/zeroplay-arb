import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Platform } from '../entities/platform.entity';
import { PlatformEvent } from '../entities/platform-event.entity';
import { Outcome } from '../entities/outcome.entity';
import { EventMatch } from '../entities/event-match.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { ISourceAdapter } from '../interfaces/source-adapter.interface';
import { NormalizedEvent, ArbitrageLeg } from '../interfaces/types';

/**
 * Orchestrates fetching events from source adapters and storing them in DB.
 *
 * Flow:
 * 1. Gets adapter for a platform
 * 2. Calls adapter.fetchEvents() to get normalized data
 * 3. Upserts events and outcomes into DB
 * 4. Marks stale events as inactive
 */
@Injectable()
export class EventFetcherService {
  private readonly logger = new Logger(EventFetcherService.name);

  constructor(
    @InjectRepository(Platform)
    private readonly platformRepo: Repository<Platform>,
    @InjectRepository(PlatformEvent)
    private readonly eventRepo: Repository<PlatformEvent>,
    @InjectRepository(Outcome)
    private readonly outcomeRepo: Repository<Outcome>,
    private readonly adapterRegistry: AdapterRegistry,
  ) {}

  /**
   * Ensure all registered adapters have a Platform record in DB.
   * Called on app startup.
   */
  async seedPlatforms(): Promise<void> {
    const adapters = this.adapterRegistry.getAllAdapters();

    for (const adapter of adapters) {
      const info = adapter.getPlatformInfo();
      let platform = await this.platformRepo.findOne({
        where: { slug: info.slug },
      });

      if (!platform) {
        platform = this.platformRepo.create({
          slug: info.slug,
          name: info.name,
          baseUrl: info.baseUrl,
          pollIntervalMs: info.defaultPollIntervalMs,
          isActive: true,
        });
        await this.platformRepo.save(platform);
        this.logger.log(`Seeded platform: ${info.name}`);
      }
    }
  }

  /**
   * Fetch events from a specific platform and store in DB.
   * Returns the list of upserted PlatformEvent IDs.
   */
  async fetchAndStore(platformSlug: string): Promise<string[]> {
    const adapter = this.adapterRegistry.getAdapter(platformSlug);
    if (!adapter) {
      this.logger.warn(`No adapter registered for "${platformSlug}"`);
      return [];
    }

    const platform = await this.platformRepo.findOne({
      where: { slug: platformSlug, isActive: true },
    });
    if (!platform) {
      this.logger.warn(`Platform "${platformSlug}" not found or inactive`);
      return [];
    }

    let normalizedEvents: NormalizedEvent[];
    try {
      normalizedEvents = await adapter.fetchEvents();
    } catch (error) {
      this.logger.error(`Failed to fetch events from ${platformSlug}: ${error.message}`);
      return [];
    }

    this.logger.log(`Fetched ${normalizedEvents.length} events from ${platformSlug}`);

    const upsertedIds = await this.upsertEvents(platform, normalizedEvents);

    // Update platform last polled timestamp
    platform.lastPolledAt = new Date();
    await this.platformRepo.save(platform);

    return upsertedIds;
  }

  /**
   * Fetch from all active platforms.
   */
  async fetchAll(): Promise<Map<string, string[]>> {
    const results = new Map<string, string[]>();
    const platforms = await this.platformRepo.find({ where: { isActive: true } });

    // Fetch from all platforms in parallel
    const promises = platforms.map(async (platform) => {
      if (!this.adapterRegistry.hasAdapter(platform.slug)) {
        this.logger.warn(`No adapter for platform "${platform.slug}", skipping`);
        return;
      }

      const ids = await this.fetchAndStore(platform.slug);
      results.set(platform.slug, ids);
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Upsert normalized events into DB.
   * Uses bulk operations where possible for performance.
   */
  private async upsertEvents(
    platform: Platform,
    normalizedEvents: NormalizedEvent[],
  ): Promise<string[]> {
    const upsertedIds: string[] = [];
    const now = new Date();

    // Load existing events for this platform in one query
    const existingExternalIds = normalizedEvents.map((e) => e.externalId);
    const existingEvents = await this.eventRepo.find({
      where: {
        platformId: platform.id,
        externalId: In(existingExternalIds),
      },
      relations: ['outcomes'],
    });

    const existingMap = new Map(existingEvents.map((e) => [e.externalId, e]));

    for (const normalized of normalizedEvents) {
      try {
        let event = existingMap.get(normalized.externalId);

        if (event) {
          // Update existing event
          event.title = normalized.title;
          event.description = normalized.description || event.description;
          event.category = normalized.category || event.category;
          event.subcategory = normalized.subcategory || event.subcategory;
          event.endDate = normalized.endDate || event.endDate;
          event.status = normalized.status;
          event.url = normalized.url || event.url;
          event.rawData = normalized.metadata || event.rawData;
          event.lastFetchedAt = now;
        } else {
          // Create new event
          event = this.eventRepo.create({
            platformId: platform.id,
            externalId: normalized.externalId,
            title: normalized.title,
            description: normalized.description,
            category: normalized.category,
            subcategory: normalized.subcategory,
            endDate: normalized.endDate,
            status: normalized.status,
            outcomeType: normalized.outcomeType,
            url: normalized.url,
            rawData: normalized.metadata || {},
            lastFetchedAt: now,
          });
        }

        const savedEvent = await this.eventRepo.save(event);

        // Upsert outcomes
        await this.upsertOutcomes(savedEvent, normalized.outcomes);

        upsertedIds.push(savedEvent.id);
      } catch (error) {
        this.logger.warn(`Failed to upsert event "${normalized.title}": ${error.message}`);
      }
    }

    return upsertedIds;
  }

  /**
   * Upsert outcomes for an event.
   */
  private async upsertOutcomes(
    event: PlatformEvent,
    normalizedOutcomes: Array<{
      externalId: string;
      name: string;
      price: number;
      volume24h?: number;
      metadata?: Record<string, any>;
    }>,
  ): Promise<void> {
    const now = new Date();
    const existingOutcomes = event.outcomes || [];
    const existingMap = new Map(existingOutcomes.map((o) => [o.externalId, o]));

    for (const normalized of normalizedOutcomes) {
      const existing = existingMap.get(normalized.externalId);

      if (existing) {
        // Track price movement
        if (Number(existing.price) !== normalized.price) {
          existing.previousPrice = existing.price;
          existing.price = normalized.price;
        }
        existing.volume24h = normalized.volume24h ?? existing.volume24h;
        existing.metadata = normalized.metadata || existing.metadata;
        existing.lastUpdatedAt = now;
        await this.outcomeRepo.save(existing);
      } else {
        const outcome = this.outcomeRepo.create({
          eventId: event.id,
          externalId: normalized.externalId,
          name: normalized.name,
          price: normalized.price,
          volume24h: normalized.volume24h,
          metadata: normalized.metadata || {},
          lastUpdatedAt: now,
        });
        await this.outcomeRepo.save(outcome);
      }
    }
  }

  // ───────────────────────── Live Price Refresh ─────────────────────────

  /**
   * Refresh prices for all verified match pairs via fetchOrderBook.
   *
   * Processes each matched pair sequentially to respect per-platform rate limits.
   * Within a pair, all outcome fetches run in parallel (they hit different platform APIs).
   * A configurable delay is inserted between pairs (ARB_PAIR_REFRESH_DELAY_MS, default 260ms).
   *
   * Adapters without fetchOrderBook are skipped silently.
   */
  async refreshPricesViaOrderBooks(matches: EventMatch[]): Promise<number> {
    if (matches.length === 0) return 0;

    const delayMs = parseInt(process.env.ARB_PAIR_REFRESH_DELAY_MS ?? '260', 10);
    let updatedCount = 0;
    const now = new Date();

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];

      // Build fetch tasks for every outcome in every event of this pair
      const tasks: Array<{ adapter: ISourceAdapter; outcome: Outcome; leg: ArbitrageLeg }> = [];

      for (const event of match.events || []) {
        const slug = event.platform?.slug;
        if (!slug) continue;

        const adapter = this.adapterRegistry.getAdapter(slug);
        if (!adapter?.fetchOrderBook) continue;

        for (const outcome of event.outcomes || []) {
          const leg: ArbitrageLeg = {
            platformSlug: slug,
            platformName: event.platform?.name || slug,
            eventExternalId: event.externalId,
            eventTitle: event.title,
            outcomeExternalId: outcome.externalId,
            outcomeName: outcome.name,
            price: Number(outcome.price),
            url: event.url,
            metadata: outcome.metadata,
          };
          tasks.push({ adapter, outcome, leg });
        }
      }

      if (tasks.length > 0) {
        // Fetch all outcomes of this pair in parallel
        const results = await Promise.allSettled(
          tasks.map(async ({ adapter, outcome, leg }) => {
            const orderBook = await adapter.fetchOrderBook!(leg);
            if (!orderBook?.asks?.length) return 0;

            const bestAsk = orderBook.asks[0].price;
            if (Number(outcome.price) === bestAsk) return 0;

            outcome.previousPrice = outcome.price;
            outcome.price = bestAsk;
            outcome.lastUpdatedAt = now;
            await this.outcomeRepo.save(outcome);
            return 1;
          }),
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            updatedCount += result.value;
          } else {
            this.logger.warn(
              `Orderbook fetch failed for a leg in match "${match.title}": ${result.reason?.message}`,
            );
          }
        }
      }

      // Rate-limit delay between pairs (skip after the last one)
      if (i < matches.length - 1 && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (updatedCount > 0) {
      this.logger.debug(`Updated ${updatedCount} outcome prices via orderbooks`);
    }

    return updatedCount;
  }

  /**
   * Get platform entity by slug.
   */
  async getPlatform(slug: string): Promise<Platform | null> {
    return this.platformRepo.findOne({ where: { slug } });
  }

  /**
   * Get all active platforms.
   */
  async getActivePlatforms(): Promise<Platform[]> {
    return this.platformRepo.find({ where: { isActive: true } });
  }

  /**
   * Get event counts per platform.
   */
  async getEventCountsPerPlatform(): Promise<
    { slug: string; name: string; eventCount: number; lastPolledAt: Date | null }[]
  > {
    const platforms = await this.platformRepo.find({ where: { isActive: true } });
    const results: { slug: string; name: string; eventCount: number; lastPolledAt: Date | null }[] =
      [];

    for (const platform of platforms) {
      const count = await this.eventRepo.count({
        where: { platformId: platform.id, status: 'active' as any },
      });
      results.push({
        slug: platform.slug,
        name: platform.name,
        eventCount: count,
        lastPolledAt: platform.lastPolledAt,
      });
    }

    return results;
  }
}
