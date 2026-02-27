import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsIn } from 'class-validator';
import { SUPPORTED_CHAINS, SupportedChain } from '../../blockchain/interfaces/types';

export class CreatePaymentRequestDto {
  @ApiProperty({
    description: 'Plan ID to subscribe to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  planId: string;

  @ApiProperty({
    description: 'Blockchain chain to pay on',
    enum: SUPPORTED_CHAINS,
    example: 'ethereum',
  })
  @IsIn(SUPPORTED_CHAINS)
  chainId: SupportedChain;
}

export class PaymentRequestResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  planId: string;

  @ApiProperty()
  amount: string;

  @ApiProperty()
  chainId: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  walletAddress: string;

  @ApiPropertyOptional()
  tokenSymbol: string | null;

  @ApiProperty({ type: [Object] })
  supportedTokens: { symbol: string; address: string }[];

  @ApiProperty()
  expiresAt: Date;

  @ApiProperty()
  createdAt: Date;
}
