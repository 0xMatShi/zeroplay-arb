import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { getAddress } from 'viem';
import {
  PaymentRequest,
  PaymentRequestStatus,
} from './entities/payment-request.entity';
import { Plan } from './entities/plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { ChainMonitorRegistry } from '../blockchain/services/chain-monitor.registry';
import {
  TokenTransfer,
  SupportedChain,
  SUPPORTED_CHAINS,
} from '../blockchain/interfaces/types';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(PaymentRequest)
    private readonly paymentRequestRepository: Repository<PaymentRequest>,
    @InjectRepository(Plan)
    private readonly planRepository: Repository<Plan>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    private readonly configService: ConfigService,
    private readonly chainMonitorRegistry: ChainMonitorRegistry,
  ) {}

  async createPaymentRequest(
    userId: string,
    planId: string,
    chainId: SupportedChain,
    fromUserWalletAddress: string,
  ): Promise<PaymentRequest> {
    const plan = await this.planRepository.findOne({
      where: { id: planId, isActive: true },
    });

    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    if (!SUPPORTED_CHAINS.includes(chainId)) {
      throw new BadRequestException(
        `Unsupported chain: ${chainId}. Supported: ${SUPPORTED_CHAINS.join(', ')}`,
      );
    }

    if (!this.chainMonitorRegistry.hasChain(chainId)) {
      throw new BadRequestException(
        `Chain ${chainId} is not currently active. Check RPC configuration.`,
      );
    }

    const existingRequest = await this.paymentRequestRepository.findOne({
      where: {
        userId,
        status: PaymentRequestStatus.PENDING,
      },
    });

    if (existingRequest) {
      throw new BadRequestException(
        'You already have a pending payment request',
      );
    }

    const walletAddress = this.configService.get<string>(
      'PAYMENT_WALLET_ADDRESS',
    );

    if (!walletAddress) {
      throw new BadRequestException('Payment wallet address not configured');
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const normalizedFromAddress = getAddress(fromUserWalletAddress);

    const paymentRequest = this.paymentRequestRepository.create({
      userId,
      planId: plan.id,
      amount: plan.price,
      chainId,
      status: PaymentRequestStatus.PENDING,
      walletAddress,
      fromUserWalletAddress: normalizedFromAddress,
      expiresAt,
    });

    return this.paymentRequestRepository.save(paymentRequest);
  }

  async findUserPaymentRequests(userId: string): Promise<PaymentRequest[]> {
    return this.paymentRequestRepository.find({
      where: { userId },
      relations: ['plan'],
      order: { createdAt: 'DESC' },
    });
  }

  async findPendingPaymentRequests(): Promise<PaymentRequest[]> {
    return this.paymentRequestRepository.find({
      where: { status: PaymentRequestStatus.PENDING },
      relations: ['user', 'plan'],
    });
  }

  async getPendingCount(): Promise<number> {
    return this.paymentRequestRepository.count({
      where: { status: PaymentRequestStatus.PENDING },
    });
  }

  async findOneById(id: string): Promise<PaymentRequest | null> {
    return this.paymentRequestRepository.findOne({
      where: { id },
      relations: ['plan'],
    });
  }

  async cancelPaymentRequest(
    paymentRequestId: string,
    userId: string,
  ): Promise<PaymentRequest> {
    const paymentRequest = await this.findOneById(paymentRequestId);

    if (!paymentRequest) {
      throw new NotFoundException('Payment request not found');
    }

    if (paymentRequest.userId !== userId) {
      throw new BadRequestException(
        'You can only cancel your own payment requests',
      );
    }

    if (paymentRequest.status !== PaymentRequestStatus.PENDING) {
      throw new BadRequestException(
        `Cannot cancel payment request with status: ${paymentRequest.status}. Only PENDING requests can be cancelled.`,
      );
    }

    paymentRequest.status = PaymentRequestStatus.CANCELLED;
    await this.paymentRequestRepository.save(paymentRequest);

    this.logger.log(
      `Payment request ${paymentRequestId} cancelled by user ${userId}`,
    );

    return paymentRequest;
  }

  async matchTransfers(transfers: TokenTransfer[]): Promise<number> {
    if (transfers.length === 0) return 0;

    const pendingRequests = await this.findPendingPaymentRequests();

    if (pendingRequests.length === 0) return 0;

    let matchedCount = 0;

    for (const transfer of transfers) {
      const matched = await this.tryMatchTransfer(transfer, pendingRequests);
      if (matched) {
        matchedCount++;
      }
    }

    if (matchedCount > 0) {
      this.logger.log(`Matched ${matchedCount} transfer(s) to payment requests`);
    }

    return matchedCount;
  }

  private async tryMatchTransfer(
    transfer: TokenTransfer,
    pendingRequests: PaymentRequest[],
  ): Promise<boolean> {
    for (const request of pendingRequests) {
      if (request.status !== PaymentRequestStatus.PENDING) continue;
      if (request.chainId !== transfer.chainId) continue;

      if (!request.fromUserWalletAddress) continue;

      const transferFrom = getAddress(transfer.from);
      const expectedFrom = getAddress(request.fromUserWalletAddress);
      if (transferFrom !== expectedFrom) continue;

      if (!this.amountMatches(transfer.amount, transfer.tokenDecimals, request.amount)) continue;

      const alreadyUsed = await this.paymentRequestRepository.findOne({
        where: {
          txHash: transfer.txHash,
          status: PaymentRequestStatus.PAID,
        },
      });

      if (alreadyUsed) {
        this.logger.warn(
          `Transfer ${transfer.txHash} already used for payment request ${alreadyUsed.id}`,
        );
        continue;
      }

      request.status = PaymentRequestStatus.PAID;
      request.txHash = transfer.txHash;
      request.tokenSymbol = transfer.tokenSymbol;
      request.tokenAddress = transfer.tokenAddress;
      request.blockNumber = transfer.blockNumber.toString();
      await this.paymentRequestRepository.save(request);

      const now = new Date();
      const durationDays = request.plan?.durationDays ?? 30;
      const subscriptionExpiresAt = new Date(now);
      subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + durationDays);

      const subscription = this.subscriptionRepository.create({
        userId: request.userId,
        planId: request.planId,
        paymentRequestId: request.id,
        startsAt: now,
        expiresAt: subscriptionExpiresAt,
        status: SubscriptionStatus.ACTIVE,
      });
      await this.subscriptionRepository.save(subscription);

      this.logger.log(
        `PAYMENT CONFIRMED: request=${request.id}, tx=${transfer.txHash}, ` +
          `chain=${transfer.chainId}, token=${transfer.tokenSymbol}, ` +
          `amount=${transfer.amount}, block=${transfer.blockNumber}`,
      );
      this.logger.log(
        `SUBSCRIPTION CREATED: user=${request.userId}, expires=${subscriptionExpiresAt.toISOString()}`,
      );

      return true;
    }

    return false;
  }

  private amountMatches(
    rawTransferAmount: string,
    tokenDecimals: number,
    expectedUsd: string,
  ): boolean {
    const raw = BigInt(rawTransferAmount);
    const divisor = 10n ** BigInt(tokenDecimals);

    // Convert raw amount to USD float: e.g. 99990000n / 10^6 = 99.99
    const transferUsd = Number(raw) / Number(divisor);
    const expected = parseFloat(expectedUsd);

    if (expected === 0) return false;

    // 1% tolerance
    const tolerance = expected * 0.01;

    return transferUsd >= expected - tolerance && transferUsd <= expected + tolerance;
  }

  async expireOldPaymentRequests(): Promise<number> {
    const expiredRequests = await this.paymentRequestRepository.find({
      where: { status: PaymentRequestStatus.PENDING },
    });

    const now = new Date();
    let expiredCount = 0;

    for (const request of expiredRequests) {
      if (request.expiresAt < now) {
        request.status = PaymentRequestStatus.EXPIRED;
        await this.paymentRequestRepository.save(request);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.logger.log(`Expired ${expiredCount} payment request(s)`);
    }

    return expiredCount;
  }

  async hasActiveSubscription(userId: string): Promise<boolean> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      order: { expiresAt: 'DESC' },
    });

    if (!subscription) return false;

    if (subscription.expiresAt < new Date()) {
      subscription.status = SubscriptionStatus.EXPIRED;
      await this.subscriptionRepository.save(subscription);
      return false;
    }

    return true;
  }

  getSupportedTokensForChain(
    chainId: string,
  ): { symbol: string; address: string }[] {
    const monitor = this.chainMonitorRegistry.getMonitor(chainId);
    if (!monitor) return [];

    return monitor.getSupportedTokens().map((t) => ({
      symbol: t.symbol,
      address: t.address,
    }));
  }
}
