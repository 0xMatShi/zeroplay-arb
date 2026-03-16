import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { AuthCacheService } from '../auth-cache.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly authCache: AuthCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKeyFromHeader(request);

    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    const sessionToken = request.headers['x-session-token'] as string | undefined;

    if (!sessionToken) {
      throw new UnauthorizedException('Session token required');
    }

    const cached = this.authCache.getSession(apiKey, sessionToken);
    if (cached) {
      request.user = cached;
      return true;
    }

    const user = await this.usersService.findByApiKeyAndSession(apiKey, sessionToken);
    if (!user) {
      throw new UnauthorizedException('Session expired or invalid');
    }

    this.authCache.setSession(apiKey, sessionToken, user);
    request.user = user;
    return true;
  }

  private extractApiKeyFromHeader(request: any): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader) return null;
    if (authHeader.startsWith('Bearer ')) return authHeader.substring(7);
    return authHeader;
  }
}
