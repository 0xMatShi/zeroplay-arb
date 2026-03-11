import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemovePaymentSystem1700000000002 implements MigrationInterface {
  name = 'RemovePaymentSystem1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop FK constraints from subscriptions referencing payment_requests and plans
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_plan"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_payment"`);

    // Drop columns that referenced deleted tables
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "plan_id"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "payment_request_id"`);

    // Drop obsolete tables
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "siwe_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chain_sync_states"`);

    // Drop obsolete enums
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."payment_request_status_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restoration not supported — payment system has been removed intentionally
  }
}
