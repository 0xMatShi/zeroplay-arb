import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { SubscriptionGuard } from '../auth/guards/subscription.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('active')
  @UseGuards(SubscriptionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current active subscription' })
  @ApiResponse({ status: 200, description: 'Active subscription or null' })
  async getActiveSubscription(@CurrentUser() user: User) {
    const subscription = await this.subscriptionsService.getActiveSubscription(user.id);

    if (!subscription) return null;

    return {
      id: subscription.id,
      planSlug: subscription.planSlug,
      status: subscription.status,
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      createdAt: subscription.createdAt,
    };
  }

  @Get('history')
  @UseGuards(SubscriptionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all user subscriptions (active + past)' })
  @ApiResponse({ status: 200, description: 'List of subscriptions' })
  async getSubscriptionHistory(@CurrentUser() user: User) {
    const subscriptions = await this.subscriptionsService.getSubscriptionHistory(user.id);

    return subscriptions.map((sub) => ({
      id: sub.id,
      planSlug: sub.planSlug,
      status: sub.status,
      startsAt: sub.startsAt,
      expiresAt: sub.expiresAt,
      createdAt: sub.createdAt,
    }));
  }

  @Get('status')
  @UseGuards(SubscriptionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if user has active subscription' })
  @ApiResponse({ status: 200, description: 'Subscription status check' })
  async checkSubscriptionStatus(@CurrentUser() user: User) {
    const isActive = await this.subscriptionsService.hasActiveSubscription(user.id);
    return { active: isActive };
  }
}
