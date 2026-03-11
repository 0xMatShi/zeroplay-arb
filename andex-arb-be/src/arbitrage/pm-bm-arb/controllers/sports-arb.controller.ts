import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SportsScheduler } from '../scheduler/sports-scheduler';
import { SubscriptionGuard } from '../../../auth/guards/subscription.guard';

@ApiTags('sports-arbitrage')
@Controller('sports-arbitrage')
@ApiBearerAuth()
export class SportsArbController {
  constructor(private readonly scheduler: SportsScheduler) {}

  @Get('opportunities')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get active sports arbitrage opportunities (PM vs BM)' })
  getOpportunities() {
    const opps = this.scheduler.getOpportunities();
    const matches = this.scheduler.getMatches();
    const matchMap = new Map(matches.map((m) => [m.id, m]));

    const ESPORTS = new Set(['csgo', 'dota2', 'lol', 'valorant', 'call-of-duty']);
    const PINNACLE_SPORT_PATH: Record<string, string> = {
      basketball: 'basketball',
      tennis:     'tennis',
      hockey:     'ice-hockey',
      baseball:   'baseball',
      csgo:       'esports/cs2',
      dota2:      'esports/dota-2',
      valorant:   'esports/valorant',
    };

    return {
      items: opps.map((opp) => {
        const match = matchMap.get(opp.matchId);
        const pmSlug = match?.pmEvent.slug ?? '';
        const dexSportKey = match?.dexEvent.sportKey ?? opp.sportKey;
        const tournamentName = match?.dexEvent.tournamentName ?? null;
        const pmUrl = pmSlug ? `https://polymarket.com/event/${pmSlug}` : undefined;

        let bookmakerUrl: string | undefined;
        if (match?.bookmakerPlatform === 'pinnacle') {
          const sportPath = PINNACLE_SPORT_PATH[dexSportKey];
          if (sportPath && match.dexEvent.tournamentName && match.dexEvent.name) {
            const leagueSlug = match.dexEvent.tournamentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const matchSlug = match.dexEvent.name.replace(/\s+/g, '-');
            bookmakerUrl = `https://www.pinnacle888.com/en/standard/${sportPath}/${leagueSlug}/${matchSlug}/${match.dexEvent.eventId}/`;
          } else {
            bookmakerUrl = `https://www.pinnacle888.com/en/standard/${PINNACLE_SPORT_PATH[dexSportKey] ?? 'sports'}`;
          }
        } else if (match) {
          const rawId = match.dexEvent.eventId.includes('.') ? match.dexEvent.eventId.split('.')[1] : match.dexEvent.eventId;
          const nameSlug = match.dexEvent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const dexCategory = ESPORTS.has(dexSportKey) ? 'esports' : 'sports';
          bookmakerUrl = rawId ? `https://dexsport.io/${dexCategory}/${dexSportKey}/${nameSlug}-${rawId}/bets/` : undefined;
        }

        const platformName = (platform: string) => {
          if (platform === 'polymarket') return 'Polymarket';
          if (platform === 'pinnacle') return 'Pinnacle';
          return 'DexSport';
        };

        return {
          // Standard Opportunity fields (used by existing filter/sort logic)
          id: opp.id,
          type: 'binary' as const,
          profitPercentage: opp.profitPercent,
          weightedAvgProfit: null,
          totalGrossProfit: null,
          totalCost: opp.totalCost,
          guaranteedPayout: 1.0,
          legs: opp.legs.map((leg) => ({
            platformSlug: leg.platform,
            platformName: platformName(leg.platform),
            eventExternalId: opp.matchId,
            eventTitle: opp.eventName,
            outcomeExternalId: '',
            outcomeName: leg.outcomeName,
            price: leg.probability,
            url: leg.platform === 'polymarket' ? pmUrl : bookmakerUrl,
          })),
          isLive: opp.isLive,
          status: 'active' as const,
          foundAt: new Date(opp.firstDetectedAt).toISOString(),
          lastValidatedAt: new Date(opp.detectedAt).toISOString(),
          expiredAt: null,
          matchTitle: opp.eventName,
          // Sports-specific fields for the new card design
          sportKey: opp.sportKey,
          tournamentName,
          marketType: opp.marketType,
          dexMarketName: opp.dexMarketName,
          // pmEvent.startTime is in ms; dexEvent.startTime is in seconds → normalize to ms
          startTime: match?.pmEvent.startTime
            ?? (match?.dexEvent.startTime != null ? match.dexEvent.startTime * 1000 : null),
          sportsLegs: opp.legs.map((leg) => ({
            platform: leg.platform,
            outcomeName: leg.outcomeName,
            probability: leg.probability,
            decimalOdds: leg.decimalOdds,
            pmBestAskQty: leg.pmBestAskQty ?? 0,
            url: leg.platform === 'polymarket' ? pmUrl : bookmakerUrl,
          })),
        };
      }),
      total: opps.length,
      limit: opps.length,
      offset: 0,
    };
  }

  @Get('stats')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get sports arbitrage stats' })
  getStats() {
    const opps = this.scheduler.getOpportunities();
    const profits = opps.map((o) => o.profitPercent);

    return {
      activeCount: opps.length,
      avgProfit: profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0,
      maxProfit: profits.length > 0 ? Math.max(...profits) : 0,
      totalFound: opps.length,
      connectedClients: 0,
    };
  }

  @Get('matches')
  @UseGuards(SubscriptionGuard)
  @ApiOperation({ summary: 'Get current sports event matches' })
  getMatches() {
    return this.scheduler.getMatches().map((m) => ({
      id: m.id,
      sportKey: m.sportKey,
      pmEvent: m.pmEvent.title,
      dexEvent: m.dexEvent.name,
      similarity: m.similarity,
      matchedMarkets: m.matchedMarkets.length,
      matchedAt: new Date(m.matchedAt).toISOString(),
    }));
  }
}
