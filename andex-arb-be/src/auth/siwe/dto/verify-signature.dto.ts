import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEthereumAddress } from 'class-validator';

export class VerifySignatureDto {
  @ApiProperty({
    description: 'Ethereum wallet address',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  })
  @IsEthereumAddress()
  @IsString()
  address: string;

  @ApiProperty({
    description: 'SIWE message that was signed',
    example: 'localhost:3000 wants you to sign in with your Ethereum account:...',
  })
  @IsString()
  message: string;

  @ApiProperty({
    description: 'Signature of the message',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  signature: string;
}

export class VerifySignatureResponseDto {
  @ApiProperty({
    description: 'API key for authenticated requests',
    example: 'arb_abc123...',
  })
  apiKey: string;

  @ApiProperty({
    description: 'User information',
  })
  user: {
    id: string;
    address: string;
  };
}
