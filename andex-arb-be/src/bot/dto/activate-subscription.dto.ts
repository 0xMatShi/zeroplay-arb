import { IsNumber, IsString, IsOptional, IsISO8601 } from 'class-validator';

export class ActivateSubscriptionDto {
  @IsNumber()
  telegramUserId: number;

  @IsString()
  planSlug: string; // '1month', '3months', 'forever'

  @IsISO8601()
  @IsOptional()
  expiresAt: string | null; // null = lifetime subscription
}
