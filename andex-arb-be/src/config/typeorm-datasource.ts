import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_DATABASE || 'arb_be',
  entities: [path.resolve(__dirname, '../**/*.entity{.ts,.js}')],
  migrations: [path.resolve(__dirname, '../migrations/**/*{.ts,.js}')],
  migrationsTableName: 'typeorm_migrations',
});
