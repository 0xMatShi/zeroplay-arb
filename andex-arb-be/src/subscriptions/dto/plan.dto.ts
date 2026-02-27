import { ApiProperty } from '@nestjs/swagger';

export class PlanDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty()
  price: string;

  @ApiProperty()
  durationDays: number;

  @ApiProperty()
  isActive: boolean;
}
