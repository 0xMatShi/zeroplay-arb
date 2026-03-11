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

  async createSession(apiKey: string): Promise<{ user: User; sessionToken: string } | null> {
    const user = await this.findByApiKey(apiKey);
    if (!user) return null;
    const sessionToken = `sess_${randomBytes(32).toString('hex')}`;
    user.sessionToken = sessionToken;
    await this.userRepository.save(user);
    return { user, sessionToken };
  }

  async findByApiKeyAndSession(apiKey: string, sessionToken: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { apiKey, sessionToken } });
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

  async findOrCreateByTelegramId(telegramUserId: number): Promise<User> {
    let user = await this.userRepository.findOne({ where: { telegramUserId } });

    if (!user) {
      user = this.userRepository.create({
        telegramUserId,
        address: null,
        apiKey: this.generateApiKey(),
      });
      user = await this.userRepository.save(user);
    } else if (!user.apiKey) {
      user.apiKey = this.generateApiKey();
      user = await this.userRepository.save(user);
    }

    return user;
  }

  async clearApiKey(userId: string): Promise<void> {
    await this.userRepository.update(userId, { apiKey: null });
  }

  private generateApiKey(): string {
    const prefix = 'arb_';
    const randomPart = randomBytes(32).toString('hex');
    return `${prefix}${randomPart}`;
  }
}
