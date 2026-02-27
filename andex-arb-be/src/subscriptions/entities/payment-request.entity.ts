import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Plan } from './plan.entity';

export enum PaymentRequestStatus {
  PENDING = 'pending',
  PAID = 'paid',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

@Entity('payment_requests')
export class PaymentRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => Plan)
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ name: 'plan_id' })
  @Index()
  planId: string;

  @Column({ type: 'varchar', length: 50 })
  amount: string;

  @Column({ type: 'varchar', length: 32, default: 'ethereum' })
  @Index()
  chainId: string;

  @Column({
    type: 'enum',
    enum: PaymentRequestStatus,
    default: PaymentRequestStatus.PENDING,
  })
  @Index()
  status: PaymentRequestStatus;

  @Column({ type: 'varchar', length: 66, nullable: true })
  @Index()
  txHash: string | null;

  @Column({ type: 'varchar', length: 42 })
  walletAddress: string;

  @Column({ type: 'varchar', length: 42, nullable: true })
  @Index()
  fromUserWalletAddress: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  tokenSymbol: string | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  tokenAddress: string | null;

  @Column({ type: 'bigint', nullable: true })
  blockNumber: string | null;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
