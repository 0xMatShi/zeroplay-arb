import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VersionService } from './version.service';
import { VersionDto } from './dto/version.dto';

@ApiTags('version')
@Controller('version')
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get()
  @ApiOperation({ summary: 'Get application version' })
  @ApiResponse({
    status: 200,
    description: 'Returns application version information',
    type: VersionDto,
  })
  getVersion(): VersionDto {
    return this.versionService.getVersion();
  }
}
