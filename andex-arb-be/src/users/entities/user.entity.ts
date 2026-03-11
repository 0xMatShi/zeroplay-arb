import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 42, unique: true, nullable: true })
  @Index()
  address: string | null;

  @Column({ type: 'bigint', unique: true, nullable: true })
  @Index()
  telegramUserId: number | null;

  @Column({ type: 'varchar', length: 255, unique: true, nullable: true })
  @Index()
  apiKey: string | null;

  @Column({ name: 'session_token', type: 'varchar', length: 255, unique: true, nullable: true })
  sessionToken: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
