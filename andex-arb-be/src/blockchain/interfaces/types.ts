import { Chain } from 'viem';

export type SupportedChain = 'ethereum' | 'bsc' | 'arbitrum' | 'base';
export type SupportedToken = 'USDT' | 'USDC';

export interface TokenInfo {
  symbol: SupportedToken;
  address: string;
  decimals: number;
}

export interface TokenTransfer {
  chainId: string;
  txHash: string;
  blockNumber: bigint;
  from: string;
  to: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  logIndex: number;
}

export interface ChainConfig {
  chainId: SupportedChain;
  chainName: string;
  viemChain: Chain;
  rpcUrl: string;
  masterWallet: string;
  confirmations: number;
  pollIntervalMs: number;
  maxBlockRange: number;
  tokens: TokenInfo[];
}

export const SUPPORTED_CHAINS: SupportedChain[] = ['ethereum', 'bsc', 'arbitrum', 'base'];
