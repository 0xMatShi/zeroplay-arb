import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BotGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const secret = request.headers['x-bot-secret'];
    const expectedSecret = this.configService.get<string>('BOT_SECRET');

    if (!expectedSecret) {
      throw new UnauthorizedException('BOT_SECRET not configured');
    }

    if (!secret || secret !== expectedSecret) {
      throw new UnauthorizedException('Invalid bot secret');
    }

    return true;
  }
}
