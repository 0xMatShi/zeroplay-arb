import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaymentsService } from './payments.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription, SubscriptionStatus } from './entities/subscription.entity';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

  @Get('active')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current active subscription' })
  @ApiResponse({ status: 200, description: 'Active subscription or null' })
  async getActiveSubscription(@CurrentUser() user: User) {
    const subscription = await this.subscriptionRepository.findOne({
      where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
      relations: ['plan'],
      order: { expiresAt: 'DESC' },
    });

    if (!subscription) {
      return null;
    }

    if (subscription.expiresAt < new Date()) {
      subscription.status = SubscriptionStatus.EXPIRED;
      await this.subscriptionRepository.save(subscription);
      return null;
    }

    return {
      id: subscription.id,
      planId: subscription.planId,
      planName: subscription.plan?.name ?? null,
      status: subscription.status,
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      createdAt: subscription.createdAt,
    };
  }

  @Get('history')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all user subscriptions (active + past)' })
  @ApiResponse({ status: 200, description: 'List of subscriptions' })
  async getSubscriptionHistory(@CurrentUser() user: User) {
    const subscriptions = await this.subscriptionRepository.find({
      where: { userId: user.id },
      relations: ['plan'],
      order: { createdAt: 'DESC' },
    });

    return subscriptions.map((sub) => ({
      id: sub.id,
      planId: sub.planId,
      planName: sub.plan?.name ?? null,
      status: sub.status,
      startsAt: sub.startsAt,
      expiresAt: sub.expiresAt,
      createdAt: sub.createdAt,
    }));
  }

  @Get('status')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if user has active subscription' })
  @ApiResponse({ status: 200, description: 'Subscription status check' })
  async checkSubscriptionStatus(@CurrentUser() user: User) {
    const isActive = await this.paymentsService.hasActiveSubscription(user.id);
    return { active: isActive };
  }
}
