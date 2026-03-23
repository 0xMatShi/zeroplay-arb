import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDashboard1700000000004 implements MigrationInterface {
  name = 'AddDashboard1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dashboard_profiles" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" varchar NOT NULL UNIQUE,
        "nickname" varchar(50) NOT NULL UNIQUE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dashboard_profiles_user_id" ON "dashboard_profiles" ("user_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dashboard_trades" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" varchar NOT NULL,
        "bookmaker1" varchar(100) NOT NULL,
        "bookmaker2" varchar(100) NOT NULL,
        "event_name" varchar(500) NOT NULL,
        "sport" varchar(100),
        "outcome1" varchar(300),
        "outcome2" varchar(300),
        "odds1" decimal(10,4) NOT NULL,
        "odds2" decimal(10,4) NOT NULL,
        "stake1" decimal(12,2) NOT NULL,
        "stake2" decimal(12,2) NOT NULL,
        "profit" decimal(12,2),
        "profit_percent" decimal(8,4),
        "is_public" boolean NOT NULL DEFAULT true,
        "winner" varchar(100),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dashboard_trades_user_id" ON "dashboard_trades" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dashboard_trades_is_public" ON "dashboard_trades" ("is_public")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dashboard_trades"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dashboard_profiles"`);
  }
}
