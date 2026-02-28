import { Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { ISourceAdapter } from '../interfaces/source-adapter.interface';
import { NormalizedEvent, PlatformInfo } from '../interfaces/types';

/**
 * Abstract base adapter with shared HTTP client and error handling.
 * Extend this class to implement a new source adapter.
 */
export abstract class BaseAdapter implements ISourceAdapter {
  protected readonly logger: Logger;
  protected readonly http: AxiosInstance;

  abstract readonly platformSlug: string;
  abstract readonly platformName: string;

  constructor(baseURL: string, config?: AxiosRequestConfig) {
    this.logger = new Logger(this.constructor.name);

    this.http = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'andex-arb-engine/1.0',
      },
      ...config,
    });

    // Request/response logging
    this.http.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `${response.config.method?.toUpperCase()} ${response.config.url} -> ${response.status}`,
        );
        return response;
      },
      (error) => {
        this.logger.error(
          `HTTP Error: ${error.config?.method?.toUpperCase()} ${error.config?.url} -> ${error.response?.status || error.message}`,
        );
        throw error;
      },
    );
  }

  abstract getPlatformInfo(): PlatformInfo;
  abstract fetchEvents(): Promise<NormalizedEvent[]>;

  /**
   * Default health check — tries to reach the base URL.
   * Override in subclass for more specific checks.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get('/', { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper: safe JSON parse with fallback.
   */
  protected safeJsonParse<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  /**
   * Helper: sleep for rate limiting.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
