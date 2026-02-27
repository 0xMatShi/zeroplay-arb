import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { randomBytes } from 'crypto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async findByAddress(address: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { address: address.toLowerCase() },
    });
  }

  async findByApiKey(apiKey: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { apiKey },
    });
  }

  async createOrUpdate(address: string): Promise<User> {
    const normalizedAddress = address.toLowerCase();
    let user = await this.findByAddress(normalizedAddress);

    if (!user) {
      user = this.userRepository.create({
        address: normalizedAddress,
        apiKey: this.generateApiKey(),
      });
    } else if (!user.apiKey) {
      user.apiKey = this.generateApiKey();
    }

    return this.userRepository.save(user);
  }

  private generateApiKey(): string {
    const prefix = 'arb_';
    const randomPart = randomBytes(32).toString('hex');
    return `${prefix}${randomPart}`;
  }
}
