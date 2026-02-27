import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('chain_sync_states')
export class ChainSyncState {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  chainId: string;

  @Column({ type: 'bigint', default: '0' })
  lastProcessedBlock: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
