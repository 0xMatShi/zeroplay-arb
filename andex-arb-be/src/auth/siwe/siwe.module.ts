import { Module } from '@nestjs/common';
import { SiweService } from './siwe.service';
import { SiweController } from './siwe.controller';
import { UsersModule } from '../../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [SiweController],
  providers: [SiweService],
  exports: [SiweService],
})
export class SiweModule {}
