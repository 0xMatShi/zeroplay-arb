import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VersionDto } from './dto/version.dto';

@Injectable()
export class VersionService {
  constructor(private readonly configService: ConfigService) {}

  getVersion(): VersionDto {
    return {
      name: this.configService.get<string>('APP_NAME', 'arb-be'),
      version: this.configService.get<string>('APP_VERSION', '1.0.0'),
      environment: this.configService.get<string>('NODE_ENV', 'development'),
    };
  }
}
