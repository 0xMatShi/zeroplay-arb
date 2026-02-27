import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEthereumAddress } from 'class-validator';

export class RequestSiweDto {
  @ApiProperty({
    description: 'Ethereum wallet address',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  })
  @IsEthereumAddress()
  @IsString()
  address: string;
}

export class RequestSiweResponseDto {
  @ApiProperty({
    description: 'SIWE message to sign',
    example: 'localhost:3000 wants you to sign in with your Ethereum account:...',
  })
  message: string;

  @ApiProperty({
    description: 'Nonce for this request',
    example: 'a1b2c3d4e5f6...',
  })
  nonce: string;
}
