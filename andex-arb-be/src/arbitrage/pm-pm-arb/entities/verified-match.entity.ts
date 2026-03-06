import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EventMatch } from './event-match.entity';

/**
 * A fully-verified event match — only confirmed matches live here.
 *
 * This is the single source of truth for the scanner:
 * ScannerService reads from this table instead of event_matches directly.
 *
 * Populated by:
 * - AiVerificationService: when AI confirms or auto-confirms a match
 * - MatchingService.updateMatchStatus(): when a match is manually confirmed
 * - MatchingService.seedVerifiedMatches(): on startup, for existing CONFIRMED matches
 *
 * Deleted from when a match is REJECTED (reversal).
 */
@Entity('verified_matches')
@Index(['eventMatchId'], { unique: true })
export class VerifiedMatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EventMatch, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'eventMatchId' })
  eventMatch: EventMatch;

  /** FK to event_matches — unique, CASCADE delete */
  @Column({ unique: true })
  eventMatchId: string;

  /** How this match was verified: 'auto' | 'ai' | 'manual' */
  @Column()
  verificationSource: string;

  /** Confidence at the time of verification (0.0 - 1.0) */
  @Column({ type: 'decimal', precision: 5, scale: 4 })
  confidence: number;

  @CreateDateColumn()
  verifiedAt: Date;
}
