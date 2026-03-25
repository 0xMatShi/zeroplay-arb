import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class BybitP2PService {
  private readonly logger = new Logger(BybitP2PService.name);

  private latestRate: number | null = null;
  private updatedAt: Date | null = null;

  getRate(): { rate: number | null; updatedAt: string | null } {
    return {
      rate: this.latestRate,
      updatedAt: this.updatedAt?.toISOString() ?? null,
    };
  }

  @Cron('* * * * *')
  async fetchRate(): Promise<void> {
    try {
      const res = await fetch('https://api2.bybit.com/fiat/otc/item/online', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          tokenId: 'USDT',
          currencyId: 'RUB',
          side: '1',       // SELL ads — мерчант продаёт USDT, пользователь покупает
          size: '10',
          page: '1',
          amount: '5000',  // минимум 5000 RUB
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Bybit P2P HTTP ${res.status}`);
        return;
      }

      const data = await res.json() as any;
      const items: any[] = data?.result?.items ?? [];

      // Берём первый оффер с нормальной ликвидностью (> 200 USDT)
      const bestItem = items.find(i => parseFloat(i.quantity) > 200) ?? items[0];
      if (!bestItem) return;

      const rate = parseFloat(bestItem.price);
      if (isNaN(rate) || rate <= 0) return;

      this.latestRate = rate;
      this.updatedAt = new Date();
      this.logger.debug(`Bybit P2P RUB/USDT = ${rate}`);
    } catch (err) {
      this.logger.warn(`Bybit P2P fetch error: ${(err as Error).message}`);
    }
  }
}
