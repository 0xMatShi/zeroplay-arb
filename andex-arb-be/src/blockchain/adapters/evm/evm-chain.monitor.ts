import { Logger } from '@nestjs/common';
import { createPublicClient, http, parseAbiItem, getAddress, PublicClient } from 'viem';
import { IChainMonitor } from '../../interfaces/chain-monitor.interface';
import { ChainConfig, TokenInfo, TokenTransfer } from '../../interfaces/types';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export class EvmChainMonitor implements IChainMonitor {
  readonly chainId: string;
  readonly chainName: string;

  private readonly logger: Logger;
  private readonly client: PublicClient;
  private readonly config: ChainConfig;
  private readonly tokenByAddress: Map<string, TokenInfo>;

  constructor(config: ChainConfig) {
    this.config = config;
    this.chainId = config.chainId;
    this.chainName = config.chainName;
    this.logger = new Logger(`EvmChainMonitor:${config.chainId}`);

    this.client = createPublicClient({
      chain: config.viemChain,
      transport: http(config.rpcUrl),
    }) as PublicClient;

    this.tokenByAddress = new Map(
      config.tokens.map((t) => [t.address.toLowerCase(), t]),
    );
  }

  async getTokenTransfers(fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]> {
    const totalBlocks = toBlock - fromBlock + 1n;
    const maxRange = BigInt(this.config.maxBlockRange);

    if (totalBlocks <= maxRange) {
      return this.fetchLogs(fromBlock, toBlock);
    }

    this.logger.log(
      `${this.chainId}: range ${totalBlocks} blocks exceeds max ${maxRange}, splitting into chunks`,
    );

    const allTransfers: TokenTransfer[] = [];
    let chunkStart = fromBlock;

    while (chunkStart <= toBlock) {
      const chunkEnd =
        chunkStart + maxRange - 1n > toBlock
          ? toBlock
          : chunkStart + maxRange - 1n;

      const transfers = await this.fetchLogs(chunkStart, chunkEnd);
      allTransfers.push(...transfers);
      chunkStart = chunkEnd + 1n;
    }

    return allTransfers;
  }

  private async fetchLogs(fromBlock: bigint, toBlock: bigint): Promise<TokenTransfer[]> {
    const contractAddresses = this.config.tokens.map(
      (t) => t.address as `0x${string}`,
    );
    const masterWallet = getAddress(this.config.masterWallet) as `0x${string}`;

    this.logger.debug(
      `Querying logs on ${this.chainId}: blocks ${fromBlock}-${toBlock} (${toBlock - fromBlock + 1n} blocks)`,
    );

    const logs = await this.client.getLogs({
      address: contractAddresses,
      event: TRANSFER_EVENT,
      args: { to: masterWallet },
      fromBlock,
      toBlock,
    });

    this.logger.debug(`Found ${logs.length} Transfer logs on ${this.chainId}`);

    return logs.map((log) => this.parseTransferLog(log));
  }

  async getCurrentBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  getRequiredConfirmations(): number {
    return this.config.confirmations;
  }

  getSupportedTokens(): TokenInfo[] {
    return this.config.tokens;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  private parseTransferLog(log: any): TokenTransfer {
    const tokenAddress = log.address.toLowerCase();
    const token = this.tokenByAddress.get(tokenAddress);

    return {
      chainId: this.chainId,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      from: getAddress(log.args.from),
      to: getAddress(log.args.to),
      tokenAddress: log.address,
      tokenSymbol: token?.symbol ?? 'UNKNOWN',
      tokenDecimals: token?.decimals ?? 18,
      amount: log.args.value.toString(),
      logIndex: log.logIndex,
    };
  }
}
