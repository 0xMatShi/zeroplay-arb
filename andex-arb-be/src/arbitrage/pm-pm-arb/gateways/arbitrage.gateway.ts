import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { ArbitrageOpportunity } from '../entities/arbitrage-opportunity.entity';
import { UsersService } from '../../../users/users.service';
import { PaymentsService } from '../../../subscriptions/payments.service';

/**
 * WebSocket gateway for real-time arbitrage opportunity notifications.
 *
 * Events emitted to clients:
 * - "opportunity:new"     - A new arb opportunity was found
 * - "opportunity:updated" - An existing opportunity's numbers changed
 * - "opportunity:expired" - An opportunity no longer exists
 *
 * Connect: ws://localhost:{PORT}/arbitrage
 * Auth: pass apiKey via handshake.auth.apiKey or query param ?apiKey=...
 */
@WebSocketGateway({
  namespace: '/arbitrage',
  cors: {
    origin: '*',
  },
})
export class ArbitrageGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ArbitrageGateway.name);

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

    const hasSubscription = await this.paymentsService.hasActiveSubscription(
      user.id,
    );

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

  emitNewOpportunity(opportunity: ArbitrageOpportunity): void {
    this.server.emit('opportunity:new', {
      id: opportunity.id,
      matchTitle: opportunity.eventMatch?.title,
      profitPercentage: opportunity.profitPercentage,
      totalCost: opportunity.totalCost,
      totalGrossProfit: opportunity.totalGrossProfit,
      totalInvestment: opportunity.totalInvestment,
      totalShares: opportunity.totalShares,
      legs: opportunity.legs,
      type: opportunity.type,
      foundAt: opportunity.foundAt,
    });
  }

  emitOpportunityUpdated(opportunity: ArbitrageOpportunity): void {
    this.server.emit('opportunity:updated', {
      id: opportunity.id,
      profitPercentage: opportunity.profitPercentage,
      totalCost: opportunity.totalCost,
      legs: opportunity.legs,
      lastValidatedAt: opportunity.lastValidatedAt,
    });
  }

  emitOpportunityExpired(opportunityId: string): void {
    this.server.emit('opportunity:expired', {
      id: opportunityId,
      expiredAt: new Date(),
    });
  }

  getConnectedCount(): number {
    return this.server?.sockets?.sockets?.size || 0;
  }
}
