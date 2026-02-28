import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable uuid-ossp for uuid_generate_v4()
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // --- ENUMS ---
    await queryRunner.query(`
      CREATE TYPE "public"."event_status_enum" AS ENUM ('active', 'resolved', 'cancelled')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."outcome_type_enum" AS ENUM ('binary', 'multi')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."match_status_enum" AS ENUM ('pending', 'confirmed', 'rejected')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."match_method_enum" AS ENUM ('auto', 'ai', 'manual')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."opportunity_status_enum" AS ENUM ('active', 'expired', 'closed')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."payment_request_status_enum" AS ENUM ('pending', 'paid', 'expired', 'cancelled')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."subscription_status_enum" AS ENUM ('active', 'expired', 'cancelled')
    `);

    // --- users ---
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"         UUID         NOT NULL DEFAULT uuid_generate_v4(),
        "address"    VARCHAR(42)  NOT NULL,
        "apiKey"     VARCHAR(255),
        "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_address" UNIQUE ("address"),
        CONSTRAINT "UQ_users_apiKey"  UNIQUE ("apiKey"),
        CONSTRAINT "PK_users"        PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_users_address" ON "users" ("address")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_apiKey"  ON "users" ("apiKey")`);

    // --- siwe_requests ---
    await queryRunner.query(`
      CREATE TABLE "siwe_requests" (
        "id"        UUID        NOT NULL DEFAULT uuid_generate_v4(),
        "address"   VARCHAR(42) NOT NULL,
        "message"   TEXT        NOT NULL,
        "nonce"     VARCHAR(255) NOT NULL,
        "expiresAt" TIMESTAMP   NOT NULL,
        "used"      BOOLEAN     NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_siwe_nonce" UNIQUE ("nonce"),
        CONSTRAINT "PK_siwe_requests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_siwe_address" ON "siwe_requests" ("address")`);
    await queryRunner.query(`CREATE INDEX "IDX_siwe_nonce"   ON "siwe_requests" ("nonce")`);

    // --- platforms ---
    await queryRunner.query(`
      CREATE TABLE "platforms" (
        "id"             UUID        NOT NULL DEFAULT uuid_generate_v4(),
        "slug"           VARCHAR     NOT NULL,
        "name"           VARCHAR     NOT NULL,
        "baseUrl"        VARCHAR,
        "isActive"       BOOLEAN     NOT NULL DEFAULT true,
        "pollIntervalMs" INTEGER     NOT NULL DEFAULT 120000,
        "lastPolledAt"   TIMESTAMPTZ,
        "config"         JSONB       NOT NULL DEFAULT '{}',
        "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_platforms_slug" UNIQUE ("slug"),
        CONSTRAINT "PK_platforms"      PRIMARY KEY ("id")
      )
    `);

    // --- platform_events ---
    await queryRunner.query(`
      CREATE TABLE "platform_events" (
        "id"            UUID         NOT NULL DEFAULT uuid_generate_v4(),
        "platformId"    UUID         NOT NULL,
        "externalId"    VARCHAR      NOT NULL,
        "title"         VARCHAR      NOT NULL,
        "description"   TEXT,
        "category"      VARCHAR,
        "subcategory"   VARCHAR,
        "endDate"       TIMESTAMPTZ,
        "status"        "public"."event_status_enum"   NOT NULL DEFAULT 'active',
        "outcomeType"   "public"."outcome_type_enum"   NOT NULL DEFAULT 'binary',
        "url"           VARCHAR,
        "rawData"       JSONB        NOT NULL DEFAULT '{}',
        "lastFetchedAt" TIMESTAMPTZ  NOT NULL,
        "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_platform_events_platform_external" UNIQUE ("platformId", "externalId"),
        CONSTRAINT "PK_platform_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_platform_events_platform"
          FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_platform_events_status"   ON "platform_events" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_platform_events_category" ON "platform_events" ("category")`);

    // --- outcomes ---
    await queryRunner.query(`
      CREATE TABLE "outcomes" (
        "id"            UUID            NOT NULL DEFAULT uuid_generate_v4(),
        "eventId"       UUID            NOT NULL,
        "externalId"    VARCHAR         NOT NULL,
        "name"          VARCHAR         NOT NULL,
        "price"         DECIMAL(10,6)   NOT NULL,
        "previousPrice" DECIMAL(10,6),
        "volume24h"     DECIMAL(18,2),
        "metadata"      JSONB           NOT NULL DEFAULT '{}',
        "lastUpdatedAt" TIMESTAMPTZ     NOT NULL,
        "createdAt"     TIMESTAMPTZ     NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_outcomes_event_external" UNIQUE ("eventId", "externalId"),
        CONSTRAINT "PK_outcomes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_outcomes_event"
          FOREIGN KEY ("eventId") REFERENCES "platform_events"("id") ON DELETE CASCADE
      )
    `);

    // --- event_matches ---
    await queryRunner.query(`
      CREATE TABLE "event_matches" (
        "id"             UUID                        NOT NULL DEFAULT uuid_generate_v4(),
        "title"          VARCHAR                     NOT NULL,
        "matchMethod"    "public"."match_method_enum" NOT NULL,
        "confidence"     DECIMAL(5,4)                NOT NULL DEFAULT 0,
        "status"         "public"."match_status_enum" NOT NULL DEFAULT 'pending',
        "outcomeMapping" JSONB                        NOT NULL DEFAULT '{}',
        "createdAt"      TIMESTAMPTZ                 NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMPTZ                 NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_matches" PRIMARY KEY ("id")
      )
    `);

    // --- event_match_events (join table) ---
    await queryRunner.query(`
      CREATE TABLE "event_match_events" (
        "eventMatchId"    UUID NOT NULL,
        "platformEventId" UUID NOT NULL,
        CONSTRAINT "PK_event_match_events" PRIMARY KEY ("eventMatchId", "platformEventId"),
        CONSTRAINT "FK_eme_match"
          FOREIGN KEY ("eventMatchId")    REFERENCES "event_matches"("id")    ON DELETE CASCADE,
        CONSTRAINT "FK_eme_event"
          FOREIGN KEY ("platformEventId") REFERENCES "platform_events"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_eme_match" ON "event_match_events" ("eventMatchId")`);
    await queryRunner.query(`CREATE INDEX "IDX_eme_event" ON "event_match_events" ("platformEventId")`);

    // --- verified_matches ---
    await queryRunner.query(`
      CREATE TABLE "verified_matches" (
        "id"                 UUID          NOT NULL DEFAULT uuid_generate_v4(),
        "eventMatchId"       UUID          NOT NULL,
        "verificationSource" VARCHAR       NOT NULL,
        "confidence"         DECIMAL(5,4)  NOT NULL,
        "verifiedAt"         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_verified_matches_eventMatchId" UNIQUE ("eventMatchId"),
        CONSTRAINT "PK_verified_matches" PRIMARY KEY ("id"),
        CONSTRAINT "FK_verified_matches_event_match"
          FOREIGN KEY ("eventMatchId") REFERENCES "event_matches"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_verified_matches_eventMatchId" ON "verified_matches" ("eventMatchId")`);

    // --- arbitrage_opportunities ---
    await queryRunner.query(`
      CREATE TABLE "arbitrage_opportunities" (
        "id"                UUID                             NOT NULL DEFAULT uuid_generate_v4(),
        "eventMatchId"      UUID                             NOT NULL,
        "type"              "public"."outcome_type_enum"     NOT NULL,
        "profitPercentage"  DECIMAL(10,4)                   NOT NULL,
        "totalCost"         DECIMAL(10,6)                   NOT NULL,
        "guaranteedPayout"  DECIMAL(10,6)                   NOT NULL DEFAULT 1.0,
        "legs"              JSONB                            NOT NULL,
        "weightedAvgProfit" DECIMAL(10,4),
        "totalGrossProfit"  DECIMAL(12,4),
        "status"            "public"."opportunity_status_enum" NOT NULL DEFAULT 'active',
        "foundAt"           TIMESTAMPTZ                     NOT NULL,
        "lastValidatedAt"   TIMESTAMPTZ                     NOT NULL,
        "expiredAt"         TIMESTAMPTZ,
        "createdAt"         TIMESTAMPTZ                     NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMPTZ                     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_arbitrage_opportunities" PRIMARY KEY ("id"),
        CONSTRAINT "FK_arb_opp_event_match"
          FOREIGN KEY ("eventMatchId") REFERENCES "event_matches"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_arb_opp_status"       ON "arbitrage_opportunities" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_arb_opp_eventMatchId" ON "arbitrage_opportunities" ("eventMatchId")`);

    // --- chain_sync_states ---
    await queryRunner.query(`
      CREATE TABLE "chain_sync_states" (
        "chainId"             VARCHAR(32) NOT NULL,
        "lastProcessedBlock"  BIGINT      NOT NULL DEFAULT 0,
        "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chain_sync_states" PRIMARY KEY ("chainId")
      )
    `);

    // --- plans ---
    await queryRunner.query(`
      CREATE TABLE "plans" (
        "id"          UUID         NOT NULL DEFAULT uuid_generate_v4(),
        "name"        VARCHAR(100) NOT NULL,
        "description" TEXT,
        "price"       VARCHAR(50)  NOT NULL,
        "durationDays" INTEGER     NOT NULL,
        "isActive"    BOOLEAN      NOT NULL DEFAULT true,
        "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_plans_name" UNIQUE ("name"),
        CONSTRAINT "PK_plans"      PRIMARY KEY ("id")
      )
    `);

    // --- payment_requests ---
    await queryRunner.query(`
      CREATE TABLE "payment_requests" (
        "id"                   UUID          NOT NULL DEFAULT uuid_generate_v4(),
        "user_id"              UUID          NOT NULL,
        "plan_id"              UUID          NOT NULL,
        "amount"               VARCHAR(50)   NOT NULL,
        "chainId"              VARCHAR(32)   NOT NULL DEFAULT 'ethereum',
        "status"               "public"."payment_request_status_enum" NOT NULL DEFAULT 'pending',
        "txHash"               VARCHAR(66),
        "walletAddress"        VARCHAR(42)   NOT NULL,
        "fromUserWalletAddress" VARCHAR(42),
        "tokenSymbol"          VARCHAR(10),
        "tokenAddress"         VARCHAR(42),
        "blockNumber"          BIGINT,
        "expiresAt"            TIMESTAMP     NOT NULL,
        "createdAt"            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payment_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payment_requests_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_payment_requests_plan"
          FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_pr_user_id"               ON "payment_requests" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_pr_plan_id"               ON "payment_requests" ("plan_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_pr_chain_id"              ON "payment_requests" ("chainId")`);
    await queryRunner.query(`CREATE INDEX "IDX_pr_status"                ON "payment_requests" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_pr_tx_hash"               ON "payment_requests" ("txHash")`);
    await queryRunner.query(`CREATE INDEX "IDX_pr_from_wallet"           ON "payment_requests" ("fromUserWalletAddress")`);

    // --- subscriptions ---
    await queryRunner.query(`
      CREATE TABLE "subscriptions" (
        "id"                 UUID          NOT NULL DEFAULT uuid_generate_v4(),
        "user_id"            UUID          NOT NULL,
        "plan_id"            UUID          NOT NULL,
        "payment_request_id" UUID          NOT NULL,
        "startsAt"           TIMESTAMP     NOT NULL,
        "expiresAt"          TIMESTAMP     NOT NULL,
        "status"             "public"."subscription_status_enum" NOT NULL DEFAULT 'active',
        "createdAt"          TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subscriptions_user"
          FOREIGN KEY ("user_id")            REFERENCES "users"("id"),
        CONSTRAINT "FK_subscriptions_plan"
          FOREIGN KEY ("plan_id")            REFERENCES "plans"("id"),
        CONSTRAINT "FK_subscriptions_payment"
          FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_sub_user_id" ON "subscriptions" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_sub_status"  ON "subscriptions" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chain_sync_states"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "arbitrage_opportunities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "verified_matches"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_match_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_matches"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outcomes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platforms"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "siwe_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "public"."subscription_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."payment_request_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."opportunity_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."match_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."match_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."outcome_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."event_status_enum"`);
  }
}
