import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { DashboardService, CreateTradeDto, UpdateTradeDto } from './dashboard.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // ── Public endpoints ──────────────────────────────────────────────────

  @Get('stats')
  getGlobalStats(@Query('period') period?: string) {
    const p = ['1d', '7d', '30d', 'all'].includes(period ?? '') ? (period as '1d' | '7d' | '30d' | 'all') : '1d';
    return this.dashboardService.getGlobalStats(p);
  }

  @Get('trades')
  getPublicTrades(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.dashboardService.getPublicTradesWithNicknames(limit, offset);
  }

  @Get('leaderboard')
  getLeaderboard() {
    return this.dashboardService.getLeaderboard();
  }

  // ── Authenticated endpoints ───────────────────────────────────────────

  @Get('profile')
  @UseGuards(ApiKeyGuard)
  async getProfile(@CurrentUser() user: User) {
    const profile = await this.dashboardService.getOrCreateProfile(user.id);
    const stats = await this.dashboardService.getMyStats(user.id, 'all');
    return { profile, stats };
  }

  @Get('my-stats')
  @UseGuards(ApiKeyGuard)
  async getMyStats(@CurrentUser() user: User, @Query('period') period?: string) {
    const p = ['1d', '7d', '30d', 'all'].includes(period ?? '') ? (period as '1d' | '7d' | '30d' | 'all') : 'all';
    return this.dashboardService.getMyStats(user.id, p);
  }

  @Put('profile')
  @UseGuards(ApiKeyGuard)
  async updateProfile(@CurrentUser() user: User, @Body() body: { nickname: string }) {
    return this.dashboardService.updateNickname(user.id, body.nickname);
  }

  @Get('my-trades')
  @UseGuards(ApiKeyGuard)
  getMyTrades(@CurrentUser() user: User) {
    return this.dashboardService.getMyTrades(user.id);
  }

  @Post('trades')
  @UseGuards(ApiKeyGuard)
  createTrade(@CurrentUser() user: User, @Body() dto: CreateTradeDto) {
    return this.dashboardService.createTrade(user.id, dto);
  }

  @Put('trades/:id')
  @UseGuards(ApiKeyGuard)
  updateTrade(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTradeDto,
  ) {
    return this.dashboardService.updateTrade(user.id, id, dto);
  }

  @Delete('trades/:id')
  @UseGuards(ApiKeyGuard)
  deleteTrade(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.dashboardService.deleteTrade(user.id, id);
  }
}
