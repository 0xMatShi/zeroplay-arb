import { Injectable } from '@nestjs/common';
import { User } from '../users/entities/user.entity';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 минут
const SUBSCRIPTION_TTL_MS = 30 * 60 * 1000;

interface SessionEntry {
  user: User;
  expiresAt: number;
}

interface SubscriptionEntry {
  user: User;
  hasSubscription: boolean;
  expiresAt: number;
}

@Injectable()
export class AuthCacheService {
  private readonly sessionCache = new Map<string, SessionEntry>();
  private readonly subscriptionCache = new Map<string, SubscriptionEntry>();

  getSession(apiKey: string, sessionToken: string): User | null {
    const entry = this.sessionCache.get(`${apiKey}:${sessionToken}`);
    if (!entry || entry.expiresAt < Date.now()) {
      this.sessionCache.delete(`${apiKey}:${sessionToken}`);
      return null;
    }
    return entry.user;
  }

  setSession(apiKey: string, sessionToken: string, user: User): void {
    this.sessionCache.set(`${apiKey}:${sessionToken}`, {
      user,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  getSubscription(apiKey: string): SubscriptionEntry | null {
    const entry = this.subscriptionCache.get(apiKey);
    if (!entry || entry.expiresAt < Date.now()) {
      this.subscriptionCache.delete(apiKey);
      return null;
    }
    return entry;
  }

  setSubscription(apiKey: string, user: User, hasSubscription: boolean): void {
    this.subscriptionCache.set(apiKey, {
      user,
      hasSubscription,
      expiresAt: Date.now() + SUBSCRIPTION_TTL_MS,
    });
  }

  invalidate(apiKey: string): void {
    this.subscriptionCache.delete(apiKey);
    for (const key of this.sessionCache.keys()) {
      if (key.startsWith(`${apiKey}:`)) {
        this.sessionCache.delete(key);
      }
    }
  }
}
