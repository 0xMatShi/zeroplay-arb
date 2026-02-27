import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  Index,
  JoinColumn,
} from 'typeorm';
import { EventMatch } from './event-match.entity';
import { OpportunityStatus, OutcomeType, ArbitrageLeg } from '../interfaces/types';

/**
 * A detected arbitrage opportunity between matched events.
 *
 * Lifecycle: ACTIVE -> EXPIRED (prices moved) or CLOSED (manually)
 * Revalidated periodically to check if the arb still exists.
 */
@Entity('arbitrage_opportunities')
@Index(['status'])
@Index(['eventMatchId'])
export class ArbitrageOpportunity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EventMatch, (match) => match.opportunities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'eventMatchId' })
  eventMatch: EventMatch;

  @Column()
  eventMatchId: string;

  @Column({ type: 'enum', enum: OutcomeType })
  type: OutcomeType;

  /** Profit percentage: (payout - cost) / cost * 100 */
  @Column({ type: 'decimal', precision: 10, scale: 4 })
  profitPercentage: number;

  /** Total cost for all legs (sum of best prices) */
  @Column({ type: 'decimal', precision: 10, scale: 6 })
  totalCost: number;

  /** Guaranteed payout (1.0 for normalized prediction markets) */
  @Column({ type: 'decimal', precision: 10, scale: 6, default: 1.0 })
  guaranteedPayout: number;

  /** All legs of this arb — what to buy and where */
  @Column({ type: 'jsonb' })
  legs: ArbitrageLeg[];

  /**
   * Weighted average profit % based on real order book depth.
   * Computed by OrderBookService and cached here for sorting/filtering.
   * Null until the order book has been analyzed at least once.
   */
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, default: null })
  weightedAvgProfit: number | null;

  /**
   * Total gross profit in $ across all executable tiers.
   * Computed by OrderBookService and cached here for sorting.
   * Null until the order book has been analyzed at least once.
   */
  @Column({ type: 'decimal', precision: 12, scale: 4, nullable: true, default: null })
  totalGrossProfit: number | null;

  @Column({
    type: 'enum',
    enum: OpportunityStatus,
    default: OpportunityStatus.ACTIVE,
  })
  status: OpportunityStatus;

  @Column({ type: 'timestamptz' })
  foundAt: Date;

  @Column({ type: 'timestamptz' })
  lastValidatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiredAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
