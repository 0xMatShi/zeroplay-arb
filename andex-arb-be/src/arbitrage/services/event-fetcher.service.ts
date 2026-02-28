import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Platform } from '../entities/platform.entity';
import { PlatformEvent } from '../entities/platform-event.entity';
import { Outcome } from '../entities/outcome.entity';
import { EventMatch } from '../entities/event-match.entity';
import { AdapterRegistry } from '../adapters/adapter.registry';
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
   * Refresh prices for all events in verified matches via fetchOrderBook.
   *
   * Called every 30s for ALL verified matches (not just those with active opportunities).
   * Extracts bestAsk = asks[0].price from each orderbook and updates Outcome.price in DB.
   *
   * Adapters without fetchOrderBook are skipped silently.
   */
  async refreshPricesViaOrderBooks(matches: EventMatch[]): Promise<number> {
    // Collect unique events across all matches
    const allEvents = new Map<string, PlatformEvent>();
    for (const match of matches) {
      for (const event of match.events || []) {
        if (!allEvents.has(event.id)) {
          allEvents.set(event.id, event);
        }
      }
    }

    if (allEvents.size === 0) return 0;

    // Group by platform
    const byPlatform = new Map<string, PlatformEvent[]>();
    for (const event of allEvents.values()) {
      const slug = event.platform?.slug;
      if (!slug) continue;
      if (!byPlatform.has(slug)) byPlatform.set(slug, []);
      byPlatform.get(slug)!.push(event);
    }

    let updatedCount = 0;
    const now = new Date();

    for (const [slug, platformEvents] of byPlatform) {
      const adapter = this.adapterRegistry.getAdapter(slug);
      if (!adapter?.fetchOrderBook) continue;

      for (const event of platformEvents) {
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

          try {
            const orderBook = await adapter.fetchOrderBook(leg);
            if (!orderBook?.asks?.length) continue;

            const bestAsk = orderBook.asks[0].price;
            if (Number(outcome.price) !== bestAsk) {
              outcome.previousPrice = outcome.price;
              outcome.price = bestAsk;
              outcome.lastUpdatedAt = now;
              await this.outcomeRepo.save(outcome);
              updatedCount++;
            }
          } catch (error) {
            this.logger.warn(
              `Failed to fetch orderbook for ${slug}/${outcome.name} (${event.externalId}): ${error.message}`,
            );
          }
        }
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
