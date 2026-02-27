import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  Index,
  JoinColumn,
} from 'typeorm';
import { Platform } from './platform.entity';
import { Outcome } from './outcome.entity';
import { EventStatus, OutcomeType } from '../interfaces/types';

/**
 * A single market/question on a prediction platform.
 * Example: "Will Trump win the 2024 election?" on Polymarket.
 */
@Entity('platform_events')
@Index(['platformId', 'externalId'], { unique: true })
@Index(['status'])
@Index(['category'])
export class PlatformEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Platform, (platform) => platform.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'platformId' })
  platform: Platform;

  @Column()
  platformId: string;

  /** ID of this event on the source platform */
  @Column()
  externalId: string;

  /** Market question / title */
  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ nullable: true })
  category: string;

  @Column({ nullable: true })
  subcategory: string;

  /** When this market resolves */
  @Column({ type: 'timestamptz', nullable: true })
  endDate: Date;

  @Column({ type: 'enum', enum: EventStatus, default: EventStatus.ACTIVE })
  status: EventStatus;

  @Column({ type: 'enum', enum: OutcomeType, default: OutcomeType.BINARY })
  outcomeType: OutcomeType;

  /** Direct link to this market on the platform */
  @Column({ nullable: true })
  url: string;

  /** Raw API response for debugging */
  @Column({ type: 'jsonb', default: {} })
  rawData: Record<string, any>;

  @OneToMany(() => Outcome, (outcome) => outcome.event, {
    cascade: true,
    eager: true,
  })
  outcomes: Outcome[];

  @Column({ type: 'timestamptz' })
  lastFetchedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
