import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('dashboard_trades')
export class DashboardTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'varchar' })
  @Index()
  userId: string;

  @Column({ name: 'bookmaker1', type: 'varchar', length: 100 })
  bookmaker1: string;

  @Column({ name: 'bookmaker2', type: 'varchar', length: 100 })
  bookmaker2: string;

  @Column({ name: 'event_name', type: 'varchar', length: 500 })
  eventName: string;

  @Column({ name: 'sport', type: 'varchar', length: 100, nullable: true })
  sport: string | null;

  @Column({ name: 'outcome1', type: 'varchar', length: 300, nullable: true })
  outcome1: string | null;

  @Column({ name: 'outcome2', type: 'varchar', length: 300, nullable: true })
  outcome2: string | null;

  @Column({ name: 'odds1', type: 'decimal', precision: 10, scale: 4 })
  odds1: number;

  @Column({ name: 'odds2', type: 'decimal', precision: 10, scale: 4 })
  odds2: number;

  @Column({ name: 'stake1', type: 'decimal', precision: 12, scale: 2 })
  stake1: number;

  @Column({ name: 'stake2', type: 'decimal', precision: 12, scale: 2 })
  stake2: number;

  @Column({ name: 'profit', type: 'decimal', precision: 12, scale: 2, nullable: true })
  profit: number | null;

  @Column({ name: 'profit_percent', type: 'decimal', precision: 8, scale: 4, nullable: true })
  profitPercent: number | null;

  @Column({ name: 'is_public', type: 'boolean', default: true })
  isPublic: boolean;

  @Column({ name: 'winner', type: 'varchar', length: 100, nullable: true })
  winner: string | null;

  @Column({ name: 'comment', type: 'text', nullable: true })
  comment: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
