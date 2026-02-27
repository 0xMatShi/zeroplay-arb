import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentsService } from './payments.service';
import { TransferScannerService } from '../blockchain/services/transfer-scanner.service';

@Injectable()
export class PaymentMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentMonitorService.name);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly transferScanner: TransferScannerService,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs = this.configService.get<number>(
      'PAYMENT_POLL_INTERVAL_MS',
      20_000,
    );
  }

  onModuleInit() {
    this.startMonitoring();
  }

  onModuleDestroy() {
    this.stopMonitoring();
  }

  private startMonitoring(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.error(`Poll cycle failed: ${err.message}`),
      );
    }, this.pollIntervalMs);

    this.logger.log(
      `Payment monitor started (poll interval: ${this.pollIntervalMs}ms)`,
    );
  }

  private stopMonitoring(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.logger.log('Payment monitor stopped');
    }
  }

  private async poll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const pendingCount = await this.paymentsService.getPendingCount();

      if (pendingCount === 0) {
        this.logger.debug('No pending payment requests, skipping scan');
        return;
      }

      this.logger.log(
        `Scanning chains for transfers... (${pendingCount} pending request(s))`,
      );

      const transfers = await this.transferScanner.scanAllChains();

      if (transfers.length > 0) {
        this.logger.log(
          `Found ${transfers.length} transfer(s), matching against pending requests`,
        );
        const matched = await this.paymentsService.matchTransfers(transfers);
        this.logger.log(
          `Matched ${matched}/${transfers.length} transfer(s) to payment requests`,
        );
      }
    } finally {
      this.isRunning = false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireOldPayments(): Promise<void> {
    await this.paymentsService.expireOldPaymentRequests();
  }
}
