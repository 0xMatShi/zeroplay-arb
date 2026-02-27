import {
  Controller,
  Post,
  Body,
  Get,
  Delete,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { User } from '../users/entities/user.entity';
import {
  CreatePaymentRequestDto,
  PaymentRequestResponseDto,
} from './dto/create-payment-request.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('request')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create payment request for subscription' })
  @ApiResponse({
    status: 201,
    description: 'Payment request created successfully',
    type: PaymentRequestResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async createPaymentRequest(
    @CurrentUser() user: User,
    @Body() dto: CreatePaymentRequestDto,
  ): Promise<PaymentRequestResponseDto> {
    const paymentRequest = await this.paymentsService.createPaymentRequest(
      user.id,
      dto.planId,
      dto.chainId,
      user.address,
    );

    const supportedTokens = this.paymentsService.getSupportedTokensForChain(
      dto.chainId,
    );

    return {
      id: paymentRequest.id,
      planId: paymentRequest.planId,
      amount: paymentRequest.amount,
      chainId: paymentRequest.chainId,
      status: paymentRequest.status,
      walletAddress: paymentRequest.walletAddress,
      tokenSymbol: paymentRequest.tokenSymbol,
      supportedTokens,
      expiresAt: paymentRequest.expiresAt,
      createdAt: paymentRequest.createdAt,
    };
  }

  @Get('my-requests')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user payment requests' })
  @ApiResponse({
    status: 200,
    description: 'Returns user payment requests',
    type: [PaymentRequestResponseDto],
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyPaymentRequests(
    @CurrentUser() user: User,
  ): Promise<PaymentRequestResponseDto[]> {
    const requests = await this.paymentsService.findUserPaymentRequests(
      user.id,
    );

    return requests.map((request) => ({
      id: request.id,
      planId: request.planId,
      amount: request.amount,
      chainId: request.chainId,
      status: request.status,
      walletAddress: request.walletAddress,
      tokenSymbol: request.tokenSymbol,
      supportedTokens: this.paymentsService.getSupportedTokensForChain(
        request.chainId,
      ),
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
    }));
  }

  @Delete('request/:id')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel payment request' })
  @ApiResponse({
    status: 200,
    description: 'Payment request cancelled successfully',
    type: PaymentRequestResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or cannot cancel',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Payment request not found' })
  async cancelPaymentRequest(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<PaymentRequestResponseDto> {
    const paymentRequest = await this.paymentsService.cancelPaymentRequest(
      id,
      user.id,
    );

    return {
      id: paymentRequest.id,
      planId: paymentRequest.planId,
      amount: paymentRequest.amount,
      chainId: paymentRequest.chainId,
      status: paymentRequest.status,
      walletAddress: paymentRequest.walletAddress,
      tokenSymbol: paymentRequest.tokenSymbol,
      supportedTokens: this.paymentsService.getSupportedTokensForChain(
        paymentRequest.chainId,
      ),
      expiresAt: paymentRequest.expiresAt,
      createdAt: paymentRequest.createdAt,
    };
  }
}
