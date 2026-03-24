import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DashboardProfile } from './entities/dashboard-profile.entity';
import { DashboardTrade } from './entities/dashboard-trade.entity';

export interface CreateTradeDto {
  bookmaker1: string;
  bookmaker2: string;
  eventName: string;
  sport?: string;
  outcome1?: string;
  outcome2?: string;
  odds1: number;
  odds2: number;
  stake1: number;
  stake2: number;
  profit?: number;
  profitPercent?: number;
  isPublic?: boolean;
  winner?: string;
  comment?: string;
}

export interface UpdateTradeDto extends Partial<CreateTradeDto> {}

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(DashboardProfile)
    private profileRepo: Repository<DashboardProfile>,
    @InjectRepository(DashboardTrade)
    private tradeRepo: Repository<DashboardTrade>,
  ) {}

  // ── Profile ──────────────────────────────────────────────────────────────

  async getOrCreateProfile(userId: string): Promise<DashboardProfile> {
    const existing = await this.profileRepo.findOne({ where: { userId } });
    if (existing) return existing;

    const nickname = await this.generateUniqueNickname();
    const profile = this.profileRepo.create({ userId, nickname });
    return this.profileRepo.save(profile);
  }

  async updateNickname(userId: string, nickname: string): Promise<DashboardProfile> {
    const trimmed = nickname.trim().slice(0, 50);
    if (!trimmed) throw new ForbiddenException('Nickname cannot be empty');

    const conflict = await this.profileRepo.findOne({ where: { nickname: trimmed } });
    if (conflict && conflict.userId !== userId) {
      throw new ConflictException('Этот никнейм уже занят');
    }

    const profile = await this.getOrCreateProfile(userId);
    profile.nickname = trimmed;
    return this.profileRepo.save(profile);
  }

  private async generateUniqueNickname(): Promise<string> {
    const adjectives = ['fast', 'smart', 'lucky', 'sharp', 'bold', 'swift', 'keen', 'wise', 'cool', 'hot'];
    const nouns = ['arber', 'trader', 'forker', 'hunter', 'scout', 'raider', 'seeker', 'finder'];
    for (let i = 0; i < 20; i++) {
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[Math.floor(Math.random() * nouns.length)];
      const num = Math.floor(Math.random() * 9000) + 1000;
      const candidate = `${adj}_${noun}${num}`;
      const exists = await this.profileRepo.findOne({ where: { nickname: candidate } });
      if (!exists) return candidate;
    }
    return `user${Date.now()}`;
  }

  // ── Trades ───────────────────────────────────────────────────────────────

  async createTrade(userId: string, dto: CreateTradeDto): Promise<DashboardTrade> {
    const trade = this.tradeRepo.create({
      userId,
      bookmaker1: dto.bookmaker1,
      bookmaker2: dto.bookmaker2,
      eventName: dto.eventName,
      sport: dto.sport ?? null,
      outcome1: dto.outcome1 ?? null,
      outcome2: dto.outcome2 ?? null,
      odds1: dto.odds1,
      odds2: dto.odds2,
      stake1: dto.stake1,
      stake2: dto.stake2,
      profit: dto.profit ?? null,
      profitPercent: dto.profitPercent ?? null,
      isPublic: dto.isPublic !== undefined ? dto.isPublic : true,
      winner: dto.winner ?? null,
      comment: dto.comment ?? null,
    });
    return this.tradeRepo.save(trade);
  }

  async updateTrade(userId: string, tradeId: string, dto: UpdateTradeDto): Promise<DashboardTrade> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) throw new NotFoundException('Trade not found');
    if (trade.userId !== userId) throw new ForbiddenException('Access denied');

    Object.assign(trade, {
      ...(dto.bookmaker1 !== undefined && { bookmaker1: dto.bookmaker1 }),
      ...(dto.bookmaker2 !== undefined && { bookmaker2: dto.bookmaker2 }),
      ...(dto.eventName !== undefined && { eventName: dto.eventName }),
      ...(dto.sport !== undefined && { sport: dto.sport }),
      ...(dto.outcome1 !== undefined && { outcome1: dto.outcome1 }),
      ...(dto.outcome2 !== undefined && { outcome2: dto.outcome2 }),
      ...(dto.odds1 !== undefined && { odds1: dto.odds1 }),
      ...(dto.odds2 !== undefined && { odds2: dto.odds2 }),
      ...(dto.stake1 !== undefined && { stake1: dto.stake1 }),
      ...(dto.stake2 !== undefined && { stake2: dto.stake2 }),
      ...(dto.profit !== undefined && { profit: dto.profit }),
      ...(dto.profitPercent !== undefined && { profitPercent: dto.profitPercent }),
      ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
      ...(dto.winner !== undefined && { winner: dto.winner }),
      ...(dto.comment !== undefined && { comment: dto.comment }),
    });

    return this.tradeRepo.save(trade);
  }

  async deleteTrade(userId: string, tradeId: string): Promise<void> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) throw new NotFoundException('Trade not found');
    if (trade.userId !== userId) throw new ForbiddenException('Access denied');
    await this.tradeRepo.remove(trade);
  }

  async getMyTrades(userId: string, from?: string, to?: string): Promise<DashboardTrade[]> {
    let qb = this.tradeRepo.createQueryBuilder('t').where('t.user_id = :userId', { userId });
    if (from && to) {
      qb = qb.andWhere('t.created_at >= :from AND t.created_at <= :to', {
        from: new Date(from),
        to: new Date(new Date(to).setHours(23, 59, 59, 999)),
      });
    }
    return qb.orderBy('t.created_at', 'DESC').getMany();
  }

  async getPublicTrades(limit = 50, offset = 0, from?: string, to?: string): Promise<{ trades: DashboardTrade[]; total: number }> {
    let qb = this.tradeRepo.createQueryBuilder('t').where('t.is_public = true');
    if (from && to) {
      qb = qb.andWhere('t.created_at >= :from AND t.created_at <= :to', {
        from: new Date(from),
        to: new Date(new Date(to).setHours(23, 59, 59, 999)),
      });
    }
    const [trades, total] = await qb.orderBy('t.created_at', 'DESC').skip(offset).take(limit).getManyAndCount();
    return { trades, total };
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  async getGlobalStats(period: '1d' | '7d' | '30d' | 'all' = '1d', from?: string, to?: string): Promise<{
    periodProfit: number;
    periodTrades: number;
    periodBestProfit: number;
  }> {
    let qb = this.tradeRepo
      .createQueryBuilder('t')
      .where('t.is_public = true');

    if (from && to) {
      qb = qb.andWhere('t.created_at >= :from AND t.created_at <= :to', {
        from: new Date(from),
        to: new Date(new Date(to).setHours(23, 59, 59, 999)),
      });
    } else if (period !== 'all') {
      const since = new Date();
      if (period === '1d') since.setHours(0, 0, 0, 0);
      else if (period === '7d') { since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0); }
      else if (period === '30d') { since.setDate(since.getDate() - 30); since.setHours(0, 0, 0, 0); }
      qb = qb.andWhere('t.created_at >= :since', { since });
    }

    const result = await qb
      .select('COALESCE(SUM(t.profit), 0)', 'periodProfit')
      .addSelect('COUNT(*)', 'periodTrades')
      .addSelect('COALESCE(MAX(t.profit), 0)', 'periodBestProfit')
      .getRawOne();

    return {
      periodProfit: parseFloat(result.periodProfit) || 0,
      periodTrades: parseInt(result.periodTrades) || 0,
      periodBestProfit: parseFloat(result.periodBestProfit) || 0,
    };
  }

  async getMyStats(
    userId: string,
    period: '1d' | '7d' | '30d' | 'all' = 'all',
    from?: string,
    to?: string,
  ): Promise<{
    totalProfit: number;
    totalTrades: number;
    bestProfit: number;
  }> {
    let qb = this.tradeRepo
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId });

    if (from && to) {
      qb = qb.andWhere('t.created_at >= :from AND t.created_at <= :to', {
        from: new Date(from),
        to: new Date(new Date(to).setHours(23, 59, 59, 999)),
      });
    } else if (period !== 'all') {
      const since = new Date();
      if (period === '1d') since.setHours(0, 0, 0, 0);
      else if (period === '7d') { since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0); }
      else if (period === '30d') { since.setDate(since.getDate() - 30); since.setHours(0, 0, 0, 0); }
      qb = qb.andWhere('t.created_at >= :since', { since });
    }

    const result = await qb
      .select('COALESCE(SUM(t.profit), 0)', 'totalProfit')
      .addSelect('COUNT(*)', 'totalTrades')
      .addSelect('COALESCE(MAX(t.profit), 0)', 'bestProfit')
      .getRawOne();

    return {
      totalProfit: parseFloat(result.totalProfit) || 0,
      totalTrades: parseInt(result.totalTrades) || 0,
      bestProfit: parseFloat(result.bestProfit) || 0,
    };
  }

  // ── Leaderboard ──────────────────────────────────────────────────────

  async getLeaderboard(from?: string, to?: string): Promise<
    Array<{
      userId: string;
      nickname: string;
      totalTrades: number;
      totalProfit: number;
      bestProfit: number;
    }>
  > {
    let qb = this.tradeRepo
      .createQueryBuilder('t')
      .where('t.is_public = true');

    if (from && to) {
      qb = qb.andWhere('t.created_at >= :from AND t.created_at <= :to', {
        from: new Date(from),
        to: new Date(new Date(to).setHours(23, 59, 59, 999)),
      });
    }

    const rows = await qb
      .groupBy('t.user_id')
      .select('t.user_id', 'userId')
      .addSelect('COUNT(*)', 'totalTrades')
      .addSelect('COALESCE(SUM(t.profit), 0)', 'totalProfit')
      .addSelect('COALESCE(MAX(t.profit), 0)', 'bestProfit')
      .orderBy('SUM(t.profit)', 'DESC')
      .getRawMany();

    const profiles = await this.profileRepo.find();
    const profileMap = new Map(profiles.map((p) => [p.userId, p.nickname]));

    return rows.map((r) => ({
      userId: r.userId,
      nickname: profileMap.get(r.userId) ?? 'Unknown',
      totalTrades: parseInt(r.totalTrades),
      totalProfit: parseFloat(r.totalProfit) || 0,
      bestProfit: parseFloat(r.bestProfit) || 0,
    }));
  }

  // ── Public trade with nickname ────────────────────────────────────────

  async getPublicTradesWithNicknames(
    limit = 50,
    offset = 0,
    from?: string,
    to?: string,
  ): Promise<{ trades: Array<DashboardTrade & { nickname: string }>; total: number }> {
    const { trades, total } = await this.getPublicTrades(limit, offset, from, to);
    const userIds = [...new Set(trades.map((t) => t.userId))];
    const profiles = userIds.length
      ? await this.profileRepo
          .createQueryBuilder('p')
          .where('p.user_id IN (:...ids)', { ids: userIds })
          .getMany()
      : [];
    const profileMap = new Map(profiles.map((p) => [p.userId, p.nickname]));

    const tradesWithNick = trades.map((t) => ({
      ...t,
      nickname: profileMap.get(t.userId) ?? 'Unknown',
    }));

    return { trades: tradesWithNick, total };
  }
}
