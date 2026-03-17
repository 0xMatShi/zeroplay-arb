import { Controller, Post, Body, Get, UseGuards, Headers, Req, UnauthorizedException, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { User } from '../../users/entities/user.entity';
import { UsersService } from '../../users/users.service';
import { AuthCacheService } from '../auth-cache.service';

@ApiTags('auth')
@Controller('auth/siwe')
@Throttle({ default: { ttl: 60000, limit: 10 } })
export class SiweController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authCache: AuthCacheService,
  ) {}

  @Post('session')
  @ApiOperation({ summary: 'Create a new session token (invalidates previous sessions for this API key)' })
  @ApiResponse({ status: 201, description: 'Returns session token' })
  @ApiResponse({ status: 401, description: 'Invalid API key' })
  async createSession(@Headers('authorization') authHeader: string): Promise<{ sessionToken: string }> {
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    if (!apiKey) throw new UnauthorizedException('API key is required');

    this.authCache.invalidate(apiKey);

    const result = await this.usersService.createSession(apiKey);
    if (!result) throw new UnauthorizedException('Invalid API key');

    return { sessionToken: result.sessionToken };
  }

  @Get('check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify auth from cookies (used by Nginx auth_request for docs)' })
  @ApiResponse({ status: 200, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async checkAuth(@Req() req: Request): Promise<void> {
    const apiKey =
      (req.cookies as Record<string, string>)?.['auth_api_key'] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : req.headers.authorization);

    const sessionToken =
      (req.cookies as Record<string, string>)?.['auth_session_token'] ||
      (req.headers['x-session-token'] as string | undefined);

    if (!apiKey || !sessionToken) {
      throw new UnauthorizedException();
    }

    const user = await this.usersService.findByApiKeyAndSession(apiKey, sessionToken);
    if (!user) {
      throw new UnauthorizedException();
    }
  }

  @Get('whoami')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user information' })
  @ApiResponse({ status: 200, description: 'Returns current user information' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async whoami(@CurrentUser() user: User) {
    return {
      id: user.id,
      address: user.address,
      createdAt: user.createdAt,
    };
  }
}
