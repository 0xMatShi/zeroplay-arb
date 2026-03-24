import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDashboardTradeComment1700000000005 implements MigrationInterface {
  name = 'AddDashboardTradeComment1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dashboard_trades"
      ADD COLUMN IF NOT EXISTS "comment" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "dashboard_trades"
      DROP COLUMN IF EXISTS "comment"
    `);
  }
}
