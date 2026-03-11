import {
  Controller,
  Get,
  Param,
  Query,
  Post,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OpportunityService } from '../services/opportunity.service';
import { OrderBookService } from '../services/orderbook.service';
import { MatchingService } from '../services/matching.service';
import { EventFetcherService } from '../services/event-fetcher.service';
import { ArbitrageGateway } from '../gateways/arbitrage.gateway';
import {
  OpportunityQueryDto,
  OpportunityResponseDto,
  StatsResponseDto,
} from '../dto/opportunity.dto';
import { MatchStatus } from '../interfaces/types';
import { SubscriptionGuard } from '../../../auth/guards/subscription.guard';
import { AdminGuard } from '../../../auth/guards/admin.guard';

@ApiTags('arbitrage')
@Controller('arbitrage')
@ApiBearerAuth()
export class ArbitrageController {
  constructor(
    private readonly opportunityService: OpportunityService,
    private readonly orderBookService: OrderBookService,
    private readonly matchingService: MatchingService,
    private readonly eventFetcher: EventFetcherService,
    private readonly gateway: ArbitrageGateway,
  ) {}

  // ==================== Opportunities (subscription required) ====================

  @Get('opportunities')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({
    summary: 'Get active arbitrage opportunities',
    description: 'Add ?refresh=true to fetch fresh prices from platform APIs before returning.',
  })
  @ApiResponse({ status: 200, type: [OpportunityResponseDto] })
  async getOpportunities(@Query() query: OpportunityQueryDto) {
    const { items, total } = query.refresh
      ? await this.opportunityService.refreshAndGetActive(query.limit, query.offset)
      : await this.opportunityService.getActive(query.limit, query.offset);

    return {
      items: items.map((opp) => ({
        id: opp.id,
        type: opp.type,
        profitPercentage: Number(opp.profitPercentage),
        totalCost: Number(opp.totalCost),
        guaranteedPayout: Number(opp.guaranteedPayout),
        legs: opp.legs,
        status: opp.status,
        foundAt: opp.foundAt,
        lastValidatedAt: opp.lastValidatedAt,
        expiredAt: opp.expiredAt,
        matchTitle: opp.eventMatch?.title,
        weightedAvgProfit: opp.weightedAvgProfit != null ? Number(opp.weightedAvgProfit) : null,
        totalGrossProfit: opp.totalGrossProfit != null ? Number(opp.totalGrossProfit) : null,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  @Get('opportunities/history')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get opportunity history (all statuses)' })
  async getHistory(@Query() query: OpportunityQueryDto) {
    const { items, total } = await this.opportunityService.getHistory(
      query.limit,
      query.offset,
      query.status,
    );

    return {
      items: items.map((opp) => ({
        id: opp.id,
        type: opp.type,
        profitPercentage: Number(opp.profitPercentage),
        totalCost: Number(opp.totalCost),
        guaranteedPayout: Number(opp.guaranteedPayout),
        legs: opp.legs,
        status: opp.status,
        foundAt: opp.foundAt,
        lastValidatedAt: opp.lastValidatedAt,
        expiredAt: opp.expiredAt,
        matchTitle: opp.eventMatch?.title,
        weightedAvgProfit: opp.weightedAvgProfit != null ? Number(opp.weightedAvgProfit) : null,
        totalGrossProfit: opp.totalGrossProfit != null ? Number(opp.totalGrossProfit) : null,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  @Get('opportunities/:id')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get opportunity details by ID' })
  async getOpportunity(@Param('id') id: string) {
    const opp = await this.opportunityService.getById(id);
    if (!opp) throw new NotFoundException(`Opportunity ${id} not found`);
    return opp;
  }

  @Get('opportunities/:id/orderbook')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({
    summary: 'Get order book analysis with executable arb tiers',
    description:
      'Fetches real-time order books from each platform, then walks through them ' +
      'to compute executable arb tiers. Each tier shows: quantity, prices per leg, ' +
      'profit %, and investment amount. Tiers are sorted by profit (best first). ' +
      'Stops when no more profit is available (totalCost >= 1.0).',
  })
  async getOpportunityOrderBook(@Param('id') id: string) {
    const result = await this.orderBookService.getOrderBookAnalysis(id);
    if (!result) throw new NotFoundException(`Opportunity ${id} not found`);
    return result;
  }

  // ==================== Stats (subscription required) ====================

  @Get('stats')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get arbitrage engine stats' })
  @ApiResponse({ status: 200, type: StatsResponseDto })
  async getStats() {
    const stats = await this.opportunityService.getStats();
    return {
      ...stats,
      connectedClients: this.gateway.getConnectedCount(),
    };
  }

  // ==================== Matches (subscription required) ====================

  @Get('matches')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get all active event matches' })
  async getMatches() {
    const matches = await this.matchingService.getActiveMatches();
    return matches.map((m) => ({
      id: m.id,
      title: m.title,
      matchMethod: m.matchMethod,
      confidence: Number(m.confidence),
      status: m.status,
      events: m.events.map((e) => ({
        id: e.id,
        title: e.title,
        platform: e.platform?.name,
        platformSlug: e.platform?.slug,
        outcomes: e.outcomes?.map((o) => ({
          name: o.name,
          price: Number(o.price),
        })),
      })),
      outcomeMapping: m.outcomeMapping,
      createdAt: m.createdAt,
    }));
  }

  // ==================== Platforms (subscription required) ====================

  @Get('platforms')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get all platforms and their status' })
  async getPlatforms() {
    const platforms = await this.eventFetcher.getActivePlatforms();
    return platforms.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      baseUrl: p.baseUrl,
      isActive: p.isActive,
      pollIntervalMs: p.pollIntervalMs,
      lastPolledAt: p.lastPolledAt,
    }));
  }

  @Get('platforms/stats')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get event counts per platform' })
  async getPlatformStats() {
    return this.eventFetcher.getEventCountsPerPlatform();
  }

  // ==================== Admin: Match Management ====================

  @Post('matches/:id/confirm')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually confirm a match (admin)' })
  async confirmMatch(@Param('id') id: string) {
    return this.matchingService.updateMatchStatus(id, MatchStatus.CONFIRMED);
  }

  @Post('matches/:id/reject')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a match (admin)' })
  async rejectMatch(@Param('id') id: string) {
    return this.matchingService.updateMatchStatus(id, MatchStatus.REJECTED);
  }

  // ==================== Admin: Manual Triggers ====================

  @Post('trigger/poll')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger a poll cycle (admin)' })
  async triggerPoll() {
    const results = await this.eventFetcher.fetchAll();
    const summary: Record<string, number> = {};
    for (const [slug, ids] of results) {
      summary[slug] = ids.length;
    }
    return { message: 'Poll completed', eventsFetched: summary };
  }

  @Post('trigger/match')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger matching (admin)' })
  async triggerMatch() {
    const newMatches = await this.matchingService.matchNewEvents();
    return { message: 'Matching completed', newMatches };
  }

  @Post('trigger/scan')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger arb scan (admin)' })
  async triggerScan() {
    const newIds = await this.opportunityService.runScanCycle();
    return { message: 'Scan completed', newOpportunities: newIds.length, ids: newIds };
  }

}
