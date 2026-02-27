import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SiweRequest } from './entities/siwe-request.entity';
import { UsersService } from '../../users/users.service';
import { SiweMessage } from 'siwe';
import { getAddress, verifyMessage } from 'viem';
import { randomBytes } from 'node:crypto';

@Injectable()
export class SiweService {
  constructor(
    @InjectRepository(SiweRequest)
    private readonly siweRequestRepository: Repository<SiweRequest>,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  async createSiweRequest(address: string): Promise<{ message: string; nonce: string }> {
    const normalizedAddress = getAddress(address);
    console.log('normalizedAddress', normalizedAddress);
    const nonce = randomBytes(16).toString('hex');
    console.log('nonce', nonce);
    const domain = this.configService.get<string>('APP_DOMAIN', 'localhost');
    const origin = this.configService.get<string>('APP_ORIGIN', `http://${domain}:3000`);
    const chainId = this.configService.get<number>('SIWE_CHAIN_ID', 1);
    const statement = this.configService.get<string>(
      'SIWE_STATEMENT',
      'Sign in with Ethereum to the app.',
    );
    console.log('origin', origin);
    console.log('chainId', chainId);
    try {
      const siweMessage = new SiweMessage({
        domain,
        address: normalizedAddress,
        statement,
        uri: origin,
        version: '1',
        chainId,
        nonce,
      });
      console.log('siweMessage', siweMessage);
      const message = siweMessage.prepareMessage();
      console.log('message', message);

      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 minutes expiry
      console.log('expiresAt', expiresAt);
      await this.siweRequestRepository.save({
        address: normalizedAddress,
        message,
        nonce,
        expiresAt,
        used: false,
      });

      return { message, nonce };
    } catch (error) {
      console.error('Error creating SIWE request', error);
      throw new BadRequestException('Failed to create SIWE request');
    }
  }

  async verifySignature(
    address: string,
    message: string,
    signature: string,
  ): Promise<{ apiKey: string; user: { id: string; address: string } }> {
    const normalizedAddress = getAddress(address);

    // Parse and validate SIWE message
    let siweMessage: SiweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch (error) {
      throw new BadRequestException('Invalid SIWE message format');
    }

    // Verify message fields
    if (siweMessage.address !== normalizedAddress) {
      throw new BadRequestException('Address mismatch');
    }

    // Check if request exists and is valid
    const request = await this.siweRequestRepository.findOne({
      where: {
        address: normalizedAddress,
        nonce: siweMessage.nonce,
        used: false,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    if (!request) {
      throw new NotFoundException('SIWE request not found or already used');
    }

    if (request.expiresAt < new Date()) {
      throw new BadRequestException('SIWE request has expired');
    }

    if (request.message !== message) {
      throw new BadRequestException('Message mismatch');
    }

    // Verify signature using viem
    try {
      const isValid = await verifyMessage({
        address: normalizedAddress as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });

      if (!isValid) {
        throw new BadRequestException('Invalid signature');
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Signature verification failed');
    }

    // Mark request as used
    request.used = true;
    await this.siweRequestRepository.save(request);

    // Create or update user and return API key
    const user = await this.usersService.createOrUpdate(normalizedAddress);

    if (!user.apiKey) {
      throw new BadRequestException('Failed to generate API key');
    }

    return {
      apiKey: user.apiKey,
      user: {
        id: user.id,
        address: user.address,
      },
    };
  }
}
