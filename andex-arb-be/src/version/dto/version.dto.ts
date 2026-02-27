import { ApiProperty } from '@nestjs/swagger';

export class VersionDto {
  @ApiProperty({
    description: 'Application name',
    example: 'arb-be',
  })
  name: string;

  @ApiProperty({
    description: 'Application version',
    example: '1.0.0',
  })
  version: string;

  @ApiProperty({
    description: 'Current environment',
    example: 'development',
  })
  environment: string;
}
