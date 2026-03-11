import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionToken1700000000003 implements MigrationInterface {
  name = 'AddSessionToken1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_token" VARCHAR(255) UNIQUE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "session_token"`);
  }
}
