import { TokenTransfer, TokenInfo } from './types';

export interface IChainMonitor {
  readonly chainId: string;
  readonly chainName: string;

  getTokenTransfers(fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]>;

  getCurrentBlockNumber(): Promise<bigint>;

  getRequiredConfirmations(): number;

  getSupportedTokens(): TokenInfo[];

  healthCheck(): Promise<boolean>;
}
