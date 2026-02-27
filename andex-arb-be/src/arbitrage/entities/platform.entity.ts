import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { PlatformEvent } from './platform-event.entity';

/**
 * A prediction market / bookmaker platform.
 * Each platform has an adapter that knows how to fetch data from it.
 */
@Entity('platforms')
export class Platform {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Unique slug matching the adapter's platformSlug, e.g. "polymarket" */
  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  baseUrl: string;

  @Column({ default: true })
  isActive: boolean;

  /** How often to poll this platform (ms). Default 2 minutes */
  @Column({ type: 'int', default: 120_000 })
  pollIntervalMs: number;

  /** Last time we successfully fetched data */
  @Column({ type: 'timestamptz', nullable: true })
  lastPolledAt: Date;

  /** Platform-specific config (API keys, custom settings, etc.) */
  @Column({ type: 'jsonb', default: {} })
  config: Record<string, any>;

  @OneToMany(() => PlatformEvent, (event) => event.platform)
  events: PlatformEvent[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
