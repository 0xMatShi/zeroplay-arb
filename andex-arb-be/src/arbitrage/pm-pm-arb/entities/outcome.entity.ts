import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  Index,
  JoinColumn,
} from 'typeorm';
import { PlatformEvent } from './platform-event.entity';

/**
 * A single tradeable outcome within a market.
 * Example: "Yes" at price 0.55 for "Will Trump win?"
 */
@Entity('outcomes')
@Index(['eventId', 'externalId'], { unique: true })
export class Outcome {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => PlatformEvent, (event) => event.outcomes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'eventId' })
  event: PlatformEvent;

  @Column()
  eventId: string;

  /** ID of this outcome on the source platform */
  @Column()
  externalId: string;

  /** "Yes", "No", "Trump", "Biden", etc. */
  @Column()
  name: string;

  /** Current price (probability) 0.0 - 1.0 */
  @Column({ type: 'decimal', precision: 10, scale: 6 })
  price: number;

  /** Previous price before last update (for tracking movement) */
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  previousPrice: number;

  /** 24h trading volume in USD */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  volume24h: number;

  /** Platform-specific outcome metadata */
  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'timestamptz' })
  lastUpdatedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
