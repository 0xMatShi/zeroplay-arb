import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { UsersService } from '../../../users/users.service';
import { SubscriptionsService } from '../../../subscriptions/subscriptions.service';
import { SportsArbitrageOpportunity, SportsMatch } from '../interfaces/sports-arb.types';

/**
 * WebSocket gateway for real-time sports arbitrage (PM vs DexSport) notifications.
 *
 * Events emitted to clients:
 * - "sports:new"     - A new arb opportunity was found
 * - "sports:updated" - An existing opportunity's numbers changed
 * - "sports:expired" - An opportunity no longer exists
 *
 * Connect: ws://localhost:{PORT}/sports-arbitrage
 * Auth: pass apiKey via handshake.auth.apiKey or query param ?apiKey=...
 */
@WebSocketGateway({
  namespace: '/sports-arbitrage',
  cors: {
    origin: '*',
  },
})
export class SportsArbGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SportsArbGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly usersService: UsersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    const apiKey =
      (client.handshake.auth?.apiKey as string) ||
      (client.handshake.query?.apiKey as string);

    if (!apiKey) {
      client.emit('error', { message: 'API key is required' });
      client.disconnect();
      return;
    }

    const adminKey = this.configService.get<string>('ADMIN_API_KEY');
    if (adminKey && apiKey === adminKey) {
      this.logger.log(`Admin client connected: ${client.id}`);
      return;
    }

    const user = await this.usersService.findByApiKey(apiKey);

    if (!user) {
      client.emit('error', { message: 'Invalid API key' });
      client.disconnect();
      return;
    }

    const hasSubscription = await this.subscriptionsService.hasActiveSubscription(user.id);

    if (!hasSubscription) {
      client.emit('error', { message: 'Active subscription required' });
      client.disconnect();
      return;
    }

    this.logger.log(`Client connected: ${client.id} (user: ${user.id})`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  private static readonly ESPORTS = new Set(['csgo', 'dota2', 'lol', 'valorant', 'call-of-duty']);

  /** Map sportKey → Pinnacle888 URL path segment */
  private static readonly PINNACLE_SPORT_PATH: Record<string, string> = {
    basketball: 'basketball',
    tennis:     'tennis',
    hockey:     'ice-hockey',
    baseball:   'baseball',
    csgo:       'esports/cs2',
    dota2:      'esports/dota-2',
    valorant:   'esports/valorant',
  };

  private buildBookmakerUrl(match: SportsMatch | undefined): string | undefined {
    if (!match) return undefined;
    const { bookmakerPlatform, dexEvent } = match;

    if (bookmakerPlatform === 'pinnacle') {
      const sportPath = SportsArbGateway.PINNACLE_SPORT_PATH[dexEvent.sportKey];
      if (!sportPath) return 'https://www.pinnacle888.com/en/standard/sports';

      // URL format: /en/standard/{sport}/{league-slug}/{Home-vs-Away}/{eventId}/
      const leagueSlug = (dexEvent.tournamentName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // event name is "{Home} vs {Away}" — replace spaces with hyphens preserving case
      const matchSlug = dexEvent.name.replace(/\s+/g, '-');
      const eventId = dexEvent.eventId;

      return leagueSlug && matchSlug && eventId
        ? `https://www.pinnacle888.com/en/standard/${sportPath}/${leagueSlug}/${matchSlug}/${eventId}/`
        : `https://www.pinnacle888.com/en/standard/${sportPath}`;
    }

    // DexSport URL: https://dexsport.io/{esports|sports}/{sport}/{name-slug}-{id}/bets/
    const rawId = dexEvent.eventId.includes('.')
      ? dexEvent.eventId.split('.')[1]
      : dexEvent.eventId;
    const nameSlug = dexEvent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dexCategory = SportsArbGateway.ESPORTS.has(dexEvent.sportKey) ? 'esports' : 'sports';
    return rawId
      ? `https://dexsport.io/${dexCategory}/${dexEvent.sportKey}/${nameSlug}-${rawId}/bets/`
      : undefined;
  }

  private mapOpportunity(opp: SportsArbitrageOpportunity, matchMap: Map<string, SportsMatch>) {
    const match = matchMap.get(opp.matchId);
    const pmSlug = match?.pmEvent.slug ?? '';
    const dexSportKey = match?.dexEvent.sportKey ?? opp.sportKey;
    const tournamentName = match?.dexEvent.tournamentName ?? null;
    const pmUrl = pmSlug ? `https://polymarket.com/event/${pmSlug}` : undefined;
    const bookmakerUrl = this.buildBookmakerUrl(match);

    const platformName = (platform: string) => {
      if (platform === 'polymarket') return 'Polymarket';
      if (platform === 'pinnacle') return 'Pinnacle';
      return 'DexSport';
    };

    return {
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
      maxInvestment: opp.maxInvestment,
      maxProfit: opp.maxProfit,
      status: 'active' as const,
      foundAt: new Date(opp.firstDetectedAt).toISOString(),
      lastValidatedAt: new Date(opp.detectedAt).toISOString(),
      expiredAt: null,
      matchTitle: opp.eventName,
      sportKey: dexSportKey,
      tournamentName,
      marketType: opp.marketType,
      dexMarketName: opp.dexMarketName,
      sportsLegs: opp.legs.map((leg) => ({
        platform: leg.platform,
        outcomeName: leg.outcomeName,
        probability: leg.probability,
        decimalOdds: leg.decimalOdds,
        pmBestAskQty: leg.pmBestAskQty ?? 0,
        url: leg.platform === 'polymarket' ? pmUrl : bookmakerUrl,
      })),
    };
  }

  emitNew(opp: SportsArbitrageOpportunity, matchMap: Map<string, SportsMatch>): void {
    this.server.emit('sports:new', this.mapOpportunity(opp, matchMap));
  }

  emitUpdated(opp: SportsArbitrageOpportunity, matchMap: Map<string, SportsMatch>): void {
    const mapped = this.mapOpportunity(opp, matchMap);
    this.server.emit('sports:updated', {
      id: mapped.id,
      profitPercentage: mapped.profitPercentage,
      totalCost: mapped.totalCost,
      legs: mapped.legs,
      lastValidatedAt: mapped.lastValidatedAt,
      sportsLegs: mapped.sportsLegs,
    });
  }

  emitExpired(id: string): void {
    this.server.emit('sports:expired', { id });
  }

  getConnectedCount(): number {
    return this.server?.sockets?.sockets?.size || 0;
  }
}
