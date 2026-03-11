import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription, SubscriptionStatus } from '../subscriptions/entities/subscription.entity';
import { UsersService } from '../users/users.service';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

  async activateSubscription(
    telegramUserId: number,
    planSlug: string,
    expiresAt: string | null,
  ): Promise<{ apiKey: string }> {
    const user = await this.usersService.findOrCreateByTelegramId(telegramUserId);

    // Деактивируем старые активные подписки
    await this.subscriptionRepository.update(
      { userId: user.id, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.EXPIRED },
    );

    const now = new Date();
    const subscription = this.subscriptionRepository.create({
      userId: user.id,
      planSlug,
      startsAt: now,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: SubscriptionStatus.ACTIVE,
    });
    await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Activated subscription for Telegram user ${telegramUserId} (plan=${planSlug}, expires=${expiresAt ?? 'never'})`,
    );

    return { apiKey: user.apiKey! };
  }

  async getSubscriptions(): Promise<{ telegramUserId: number; expiresAt: Date | null }[]> {
    const subscriptions = await this.subscriptionRepository.find({
      where: { status: SubscriptionStatus.ACTIVE },
      relations: ['user'],
    });

    return subscriptions
      .filter((s) => s.user?.telegramUserId != null)
      .map((s) => ({
        telegramUserId: Number(s.user.telegramUserId),
        expiresAt: s.expiresAt,
      }));
  }

  async deactivateSubscriptions(telegramUserIds: number[]): Promise<void> {
    for (const telegramUserId of telegramUserIds) {
      const user = await this.userRepository.findOne({ where: { telegramUserId } });
      if (!user) {
        this.logger.warn(`User with telegramUserId=${telegramUserId} not found, skipping`);
        continue;
      }

      await this.subscriptionRepository.update(
        { userId: user.id, status: SubscriptionStatus.ACTIVE },
        { status: SubscriptionStatus.EXPIRED },
      );

      await this.usersService.clearApiKey(user.id);

      this.logger.log(`Deactivated subscription and cleared apiKey for Telegram user ${telegramUserId}`);
    }
  }
}
