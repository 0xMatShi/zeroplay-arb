import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { BotGuard } from './bot.guard';
import { BotService } from './bot.service';
import { ActivateSubscriptionDto } from './dto/activate-subscription.dto';
import { DeactivateSubscriptionsDto } from './dto/deactivate-subscriptions.dto';
import { VerifyApiKeyDto } from './dto/verify-api-key.dto';

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

  @Post('verify-key')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify that an API key belongs to the given Telegram user' })
  @ApiResponse({ status: 200, description: 'Returns {valid: boolean}' })
  async verifyApiKey(@Body() dto: VerifyApiKeyDto) {
    const valid = await this.botService.verifyApiKey(dto.apiKey, dto.telegramUserId);
    return { valid };
  }
}
