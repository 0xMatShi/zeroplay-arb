import { Injectable, Logger } from '@nestjs/common';
import { ISourceAdapter } from '../interfaces/source-adapter.interface';

/**
 * Central registry for all source adapters.
 *
 * Each adapter registers itself here via onModuleInit().
 * The engine uses this registry to discover and interact with all sources.
 */
@Injectable()
export class AdapterRegistry {
  private readonly logger = new Logger(AdapterRegistry.name);
  private readonly adapters = new Map<string, ISourceAdapter>();

  /**
   * Register an adapter. Called by each adapter on module init.
   */
  register(adapter: ISourceAdapter): void {
    if (this.adapters.has(adapter.platformSlug)) {
      this.logger.warn(`Adapter for "${adapter.platformSlug}" is already registered, overwriting`);
    }

    this.adapters.set(adapter.platformSlug, adapter);
    this.logger.log(`Registered adapter: ${adapter.platformName} (${adapter.platformSlug})`);
  }

  /**
   * Get adapter by platform slug.
   */
  getAdapter(slug: string): ISourceAdapter | undefined {
    return this.adapters.get(slug);
  }

  /**
   * Get all registered adapters.
   */
  getAllAdapters(): ISourceAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Get all registered platform slugs.
   */
  getSlugs(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if we have an adapter for this slug.
   */
  hasAdapter(slug: string): boolean {
    return this.adapters.has(slug);
  }
}
