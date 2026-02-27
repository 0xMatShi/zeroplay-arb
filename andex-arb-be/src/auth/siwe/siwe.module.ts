import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SiweRequest } from './entities/siwe-request.entity';
import { SiweService } from './siwe.service';
import { SiweController } from './siwe.controller';
import { UsersModule } from '../../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([SiweRequest]), UsersModule],
  controllers: [SiweController],
  providers: [SiweService],
  exports: [SiweService],
})
export class SiweModule {}
