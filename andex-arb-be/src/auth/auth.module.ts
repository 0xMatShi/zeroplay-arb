import { Module } from '@nestjs/common';
import { SiweModule } from './siwe/siwe.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SiweModule, UsersModule],
  exports: [SiweModule],
})
export class AuthModule {}
