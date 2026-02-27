import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SiweService } from './siwe.service';
import { RequestSiweDto, RequestSiweResponseDto } from './dto/request-siwe.dto';
import { VerifySignatureDto, VerifySignatureResponseDto } from './dto/verify-signature.dto';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { User } from '../../users/entities/user.entity';

@ApiTags('auth')
@Controller('auth/siwe')
export class SiweController {
  constructor(private readonly siweService: SiweService) {}

  @Post('request')
  @ApiOperation({ summary: 'Request SIWE message for address' })
  @ApiResponse({
    status: 201,
    description: 'Returns SIWE message and nonce to sign',
    type: RequestSiweResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid address' })
  async requestSiweForAddress(@Body() dto: RequestSiweDto): Promise<RequestSiweResponseDto> {
    const { message, nonce } = await this.siweService.createSiweRequest(dto.address);
    console.log('message', message);
    console.log('nonce', nonce);
    return { message, nonce };
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify SIWE signature' })
  @ApiResponse({
    status: 200,
    description: 'Returns API key for authenticated requests',
    type: VerifySignatureResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid signature or request' })
  @ApiResponse({ status: 404, description: 'SIWE request not found' })
  async verifySignature(@Body() dto: VerifySignatureDto): Promise<VerifySignatureResponseDto> {
    return this.siweService.verifySignature(dto.address, dto.message, dto.signature);
  }

  @Get('whoami')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user information' })
  @ApiResponse({
    status: 200,
    description: 'Returns current user information',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async whoami(@CurrentUser() user: User) {
    return {
      id: user.id,
      address: user.address,
      createdAt: user.createdAt,
    };
  }
}
