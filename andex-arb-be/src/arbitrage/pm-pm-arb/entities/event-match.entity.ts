import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  OneToMany,
  JoinTable,
} from 'typeorm';
import { PlatformEvent } from './platform-event.entity';
import { ArbitrageOpportunity } from './arbitrage-opportunity.entity';
import { MatchStatus, MatchMethod } from '../interfaces/types';

/**
 * A group of PlatformEvents from different sources
 * that represent the same real-world event.
 *
 * Example: "Will Trump win?" on Polymarket + "Trump wins election" on Kalshi.
 */
@Entity('event_matches')
export class EventMatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Normalized title for this matched group */
  @Column()
  title: string;

  /** How this match was created */
  @Column({ type: 'enum', enum: MatchMethod })
  matchMethod: MatchMethod;

  /** Confidence score 0.0 - 1.0 */
  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 })
  confidence: number;

  @Column({ type: 'enum', enum: MatchStatus, default: MatchStatus.PENDING })
  status: MatchStatus;

  /** The linked events from different platforms */
  @ManyToMany(() => PlatformEvent, { eager: true })
  @JoinTable({
    name: 'event_match_events',
    joinColumn: { name: 'eventMatchId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'platformEventId', referencedColumnName: 'id' },
  })
  events: PlatformEvent[];

  /**
   * Maps normalized outcome names to platform-specific outcome IDs.
   * Format: { "yes": { "polymarket": "outcome-id-1", "kalshi": "outcome-id-2" } }
   */
  @Column({ type: 'jsonb', default: {} })
  outcomeMapping: Record<string, Record<string, string>>;

  @OneToMany(() => ArbitrageOpportunity, (opp) => opp.eventMatch)
  opportunities: ArbitrageOpportunity[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
