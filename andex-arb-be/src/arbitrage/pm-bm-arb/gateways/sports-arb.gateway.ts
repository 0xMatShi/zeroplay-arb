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
import { PaymentsService } from '../../../subscriptions/payments.service';
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
    private readonly paymentsService: PaymentsService,
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

    const hasSubscription = await this.paymentsService.hasActiveSubscription(user.id);

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

  private mapOpportunity(opp: SportsArbitrageOpportunity, matchMap: Map<string, SportsMatch>) {
    const match = matchMap.get(opp.matchId);
    const pmSlug = match?.pmEvent.slug ?? '';
    const dexEventId = match?.dexEvent.eventId ?? '';
    const tournamentName = match?.dexEvent.tournamentName ?? null;
    const pmUrl = pmSlug ? `https://polymarket.com/event/${pmSlug}` : undefined;
    const dexUrl = dexEventId ? `https://dexsport.io/en/event/${dexEventId}` : undefined;

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
        platformName: leg.platform === 'polymarket' ? 'Polymarket' : 'DexSport',
        eventExternalId: opp.matchId,
        eventTitle: opp.eventName,
        outcomeExternalId: '',
        outcomeName: leg.outcomeName,
        price: leg.probability,
        url: leg.platform === 'polymarket' ? pmUrl : dexUrl,
      })),
      isLive: opp.isLive,
      status: 'active' as const,
      foundAt: new Date(opp.firstDetectedAt).toISOString(),
      lastValidatedAt: new Date(opp.detectedAt).toISOString(),
      expiredAt: null,
      matchTitle: opp.eventName,
      sportKey: opp.sportKey,
      tournamentName,
      marketType: opp.marketType,
      dexMarketName: opp.dexMarketName,
      sportsLegs: opp.legs.map((leg) => ({
        platform: leg.platform,
        outcomeName: leg.outcomeName,
        probability: leg.probability,
        decimalOdds: leg.decimalOdds,
        pmBestAskQty: leg.pmBestAskQty ?? 0,
        url: leg.platform === 'polymarket' ? pmUrl : dexUrl,
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
