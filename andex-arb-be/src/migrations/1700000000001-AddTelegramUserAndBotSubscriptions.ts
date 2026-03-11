import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTelegramUserAndBotSubscriptions1700000000001 implements MigrationInterface {
  name = 'AddTelegramUserAndBotSubscriptions1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add telegramUserId to users, make address nullable
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "address" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "telegramUserId" BIGINT`);
    await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_users_telegramUserId" UNIQUE ("telegramUserId")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_telegramUserId" ON "users" ("telegramUserId")`);

    // Make planId and paymentRequestId nullable in subscriptions
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_plan"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_payment"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "plan_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "payment_request_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "expiresAt" DROP NOT NULL`);

    // Add planSlug column
    await queryRunner.query(`ALTER TABLE "subscriptions" ADD COLUMN "plan_slug" VARCHAR(50)`);

    // Restore FK constraints as optional
    await queryRunner.query(`
      ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_subscriptions_plan"
        FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    `);
    await queryRunner.query(`
      ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_subscriptions_payment"
        FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "plan_slug"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "expiresAt" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "payment_request_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "plan_id" SET NOT NULL`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_telegramUserId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_telegramUserId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "telegramUserId"`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "address" SET NOT NULL`);
  }
}
