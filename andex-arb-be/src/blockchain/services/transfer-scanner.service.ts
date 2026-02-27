import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChainMonitorRegistry } from './chain-monitor.registry';
import { ChainSyncState } from '../entities/chain-sync-state.entity';
import { TokenTransfer } from '../interfaces/types';

@Injectable()
export class TransferScannerService {
  private readonly logger = new Logger(TransferScannerService.name);

  constructor(
    private readonly registry: ChainMonitorRegistry,
    @InjectRepository(ChainSyncState)
    private readonly syncStateRepo: Repository<ChainSyncState>,
  ) {}

  async scanChain(chainId: string): Promise<TokenTransfer[]> {
    const monitor = this.registry.getMonitor(chainId);
    if (!monitor) {
      this.logger.warn(`No monitor registered for chain: ${chainId}`);
      return [];
    }

    const syncState = await this.getOrCreateSyncState(chainId);
    const currentBlock = await monitor.getCurrentBlockNumber();
    const confirmations = BigInt(monitor.getRequiredConfirmations());
    const safeBlock = currentBlock - confirmations;
    const lastProcessed = BigInt(syncState.lastProcessedBlock);

    if (safeBlock <= lastProcessed) {
      this.logger.debug(
        `${chainId}: no new safe blocks (current=${currentBlock}, safe=${safeBlock}, lastProcessed=${lastProcessed})`,
      );
      return [];
    }

    const fromBlock = lastProcessed + 1n;

    this.logger.log(
      `${chainId}: scanning blocks ${fromBlock}-${safeBlock} (${safeBlock - fromBlock + 1n} blocks, head=${currentBlock})`,
    );

    try {
      const transfers = await monitor.getTokenTransfers(fromBlock, safeBlock);
      await this.updateSyncState(chainId, safeBlock);

      if (transfers.length > 0) {
        this.logger.log(
          `${chainId}: found ${transfers.length} transfer(s) in blocks ${fromBlock}-${safeBlock}`,
        );
      }

      return transfers;
    } catch (error) {
      this.logger.error(
        `${chainId}: failed to scan blocks ${fromBlock}-${safeBlock}: ${error.message}`,
      );
      return [];
    }
  }

  async scanAllChains(): Promise<TokenTransfer[]> {
    const chainIds = this.registry.getAllChainIds();

    if (chainIds.length === 0) {
      this.logger.warn('No chain monitors registered');
      return [];
    }

    const results = await Promise.allSettled(
      chainIds.map((id) => this.scanChain(id)),
    );

    const transfers: TokenTransfer[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        transfers.push(...result.value);
      }
    }

    return transfers;
  }

  async getSyncStates(): Promise<ChainSyncState[]> {
    return this.syncStateRepo.find();
  }

  private async getOrCreateSyncState(chainId: string): Promise<ChainSyncState> {
    let state = await this.syncStateRepo.findOne({ where: { chainId } });

    if (!state) {
      state = this.syncStateRepo.create({
        chainId,
        lastProcessedBlock: '0',
      });
      state = await this.syncStateRepo.save(state);
      this.logger.log(
        `${chainId}: initialized sync state at block 0 (will start from current safe block on first scan)`,
      );
    }

    return state;
  }

  private async updateSyncState(
    chainId: string,
    block: bigint,
  ): Promise<void> {
    await this.syncStateRepo.upsert(
      { chainId, lastProcessedBlock: block.toString() },
      ['chainId'],
    );
  }

  /**
   * Initialize sync state to current safe block for chains that haven't been scanned yet.
   * Prevents scanning from block 0 on first startup.
   */
  async initializeSyncStates(): Promise<void> {
    for (const chainId of this.registry.getAllChainIds()) {
      const state = await this.syncStateRepo.findOne({ where: { chainId } });
      if (!state || state.lastProcessedBlock === '0') {
        const monitor = this.registry.getMonitor(chainId);
        if (!monitor) continue;

        try {
          const currentBlock = await monitor.getCurrentBlockNumber();
          const safeBlock = currentBlock - BigInt(monitor.getRequiredConfirmations());
          await this.updateSyncState(chainId, safeBlock > 0n ? safeBlock : 0n);
          this.logger.log(
            `${chainId}: initialized sync state to block ${safeBlock}`,
          );
        } catch (error) {
          this.logger.error(
            `${chainId}: failed to initialize sync state: ${error.message}`,
          );
        }
      }
    }
  }
}
