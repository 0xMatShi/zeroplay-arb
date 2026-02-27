import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsInt, IsBoolean, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { OpportunityStatus } from '../interfaces/types';

export class OpportunityQueryDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;

  @ApiPropertyOptional({ enum: OpportunityStatus })
  @IsOptional()
  @IsEnum(OpportunityStatus)
  status?: OpportunityStatus;

  @ApiPropertyOptional({
    default: false,
    description: 'If true, fetches fresh prices from platform APIs before returning results',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  refresh?: boolean = false;
}

export class OpportunityResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: string;

  @ApiProperty({ description: 'Profit percentage' })
  profitPercentage: number;

  @ApiProperty({ description: 'Total cost for all legs (normalized to $1 payout)' })
  totalCost: number;

  @ApiProperty({ description: 'Guaranteed payout' })
  guaranteedPayout: number;

  @ApiProperty({ description: 'Trade legs — what to buy and where' })
  legs: any[];

  @ApiProperty({ enum: OpportunityStatus })
  status: OpportunityStatus;

  @ApiProperty()
  foundAt: Date;

  @ApiProperty()
  lastValidatedAt: Date;

  @ApiPropertyOptional()
  expiredAt?: Date;

  @ApiPropertyOptional({ description: 'Matched event title' })
  matchTitle?: string;

  @ApiPropertyOptional({ description: 'Weighted average profit % from order book depth analysis. Null until order book has been fetched at least once.' })
  weightedAvgProfit?: number | null;

  @ApiPropertyOptional({ description: 'Total gross profit in $ across all executable tiers. Null until order book has been fetched at least once.' })
  totalGrossProfit?: number | null;
}

export class StatsResponseDto {
  @ApiProperty()
  activeCount: number;

  @ApiProperty()
  avgProfit: number;

  @ApiProperty()
  maxProfit: number;

  @ApiProperty()
  totalFound: number;

  @ApiProperty()
  connectedClients: number;
}
