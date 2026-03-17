import { Global, Module } from '@nestjs/common';
import { AuthCacheService } from './auth-cache.service';

@Global()
@Module({
  providers: [AuthCacheService],
  exports: [AuthCacheService],
})
export class AuthCacheModule {}
