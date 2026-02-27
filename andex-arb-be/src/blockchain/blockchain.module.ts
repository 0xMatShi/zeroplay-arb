import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ChainSyncState } from './entities/chain-sync-state.entity';
import { ChainMonitorRegistry } from './services/chain-monitor.registry';
import { TransferScannerService } from './services/transfer-scanner.service';
import { EvmChainMonitor } from './adapters/evm/evm-chain.monitor';
import { DEFAULT_CHAIN_CONFIGS, EVM_CHAIN_ENV } from './adapters/evm/evm-chains.config';
import { SUPPORTED_CHAINS, ChainConfig } from './interfaces/types';

@Module({
  imports: [TypeOrmModule.forFeature([ChainSyncState])],
  providers: [ChainMonitorRegistry, TransferScannerService],
  exports: [ChainMonitorRegistry, TransferScannerService],
})
export class BlockchainModule implements OnModuleInit {
  private readonly logger = new Logger(BlockchainModule.name);

  constructor(
    private readonly registry: ChainMonitorRegistry,
    private readonly scanner: TransferScannerService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.registerEvmChains();
    await this.scanner.initializeSyncStates();
  }

  private registerEvmChains(): void {
    const masterWallet = this.configService.get<string>('PAYMENT_WALLET_ADDRESS');
    const pollIntervalMs = this.configService.get<number>('PAYMENT_POLL_INTERVAL_MS', 20_000);

    if (!masterWallet) {
      this.logger.warn(
        'PAYMENT_WALLET_ADDRESS not configured, skipping chain monitor registration',
      );
      return;
    }

    for (const chainId of SUPPORTED_CHAINS) {
      const envConfig = EVM_CHAIN_ENV[chainId];
      const rpcUrl = this.configService.get<string>(envConfig.rpcUrlEnv);

      if (!rpcUrl) {
        this.logger.warn(`${envConfig.rpcUrlEnv} not configured, skipping ${chainId}`);
        continue;
      }

      const defaultConfig = DEFAULT_CHAIN_CONFIGS[chainId];
      const confirmations = this.configService.get<number>(
        envConfig.confirmationsEnv,
        envConfig.defaultConfirmations,
      );

      const config: ChainConfig = {
        ...defaultConfig,
        rpcUrl,
        masterWallet,
        confirmations,
        pollIntervalMs,
      };

      const monitor = new EvmChainMonitor(config);
      this.registry.register(monitor);
    }

    this.logger.log(
      `Registered ${this.registry.getAllChainIds().length} chain monitor(s): [${this.registry.getAllChainIds().join(', ')}]`,
    );
  }
}
