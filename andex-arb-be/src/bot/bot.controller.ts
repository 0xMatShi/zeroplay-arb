import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { BotGuard } from './bot.guard';
import { BotService } from './bot.service';
import { ActivateSubscriptionDto } from './dto/activate-subscription.dto';
import { DeactivateSubscriptionsDto } from './dto/deactivate-subscriptions.dto';

@ApiTags('bot')
@Controller('bot')
@SkipThrottle()
@UseGuards(BotGuard)
export class BotController {
  constructor(private readonly botService: BotService) {}

  @Post('activate')
  @ApiOperation({ summary: 'Activate subscription for Telegram user after successful payment' })
  @ApiResponse({ status: 200, description: 'Returns the API key for the user' })
  async activateSubscription(@Body() dto: ActivateSubscriptionDto) {
    return this.botService.activateSubscription(dto.telegramUserId, dto.planSlug, dto.expiresAt ?? null);
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Get all active subscriptions with expiry times' })
  @ApiResponse({ status: 200, description: 'List of active subscriptions' })
  async getSubscriptions() {
    return this.botService.getSubscriptions();
  }

  @Post('deactivate')
  @ApiOperation({ summary: 'Deactivate subscriptions and clear API keys for expired users' })
  @ApiResponse({ status: 200, description: 'Subscriptions deactivated' })
  async deactivateSubscriptions(@Body() dto: DeactivateSubscriptionsDto) {
    await this.botService.deactivateSubscriptions(dto.telegramUserIds);
    return { deactivated: dto.telegramUserIds.length };
  }
}
