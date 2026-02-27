import { Injectable, Logger } from '@nestjs/common';
import { IChainMonitor } from '../interfaces/chain-monitor.interface';

@Injectable()
export class ChainMonitorRegistry {
  private readonly logger = new Logger(ChainMonitorRegistry.name);
  private readonly monitors = new Map<string, IChainMonitor>();

  register(monitor: IChainMonitor): void {
    if (this.monitors.has(monitor.chainId)) {
      this.logger.warn(
        `Monitor for "${monitor.chainId}" already registered, overwriting`,
      );
    }
    this.monitors.set(monitor.chainId, monitor);
    this.logger.log(
      `Registered chain monitor: ${monitor.chainName} (${monitor.chainId})`,
    );
  }

  getMonitor(chainId: string): IChainMonitor | undefined {
    return this.monitors.get(chainId);
  }

  getAllMonitors(): IChainMonitor[] {
    return Array.from(this.monitors.values());
  }

  getAllChainIds(): string[] {
    return Array.from(this.monitors.keys());
  }

  hasChain(chainId: string): boolean {
    return this.monitors.has(chainId);
  }
}
