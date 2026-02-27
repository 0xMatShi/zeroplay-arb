import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { PaymentsService } from '../../subscriptions/payments.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKey(request);

    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    const user = await this.usersService.findByApiKey(apiKey);

    if (!user) {
      throw new UnauthorizedException('Invalid API key');
    }

    const hasSubscription = await this.paymentsService.hasActiveSubscription(
      user.id,
    );

    if (!hasSubscription) {
      throw new ForbiddenException('Active subscription required');
    }

    request.user = user;
    return true;
  }

  private extractApiKey(request: any): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader) return null;

    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return authHeader;
  }
}
