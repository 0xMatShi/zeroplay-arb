import { mainnet, bsc, arbitrum, base } from 'viem/chains';
import { SupportedChain, ChainConfig } from '../../interfaces/types';

export interface EvmChainEnvConfig {
  rpcUrlEnv: string;
  confirmationsEnv: string;
  defaultConfirmations: number;
}

export const EVM_CHAIN_ENV: Record<SupportedChain, EvmChainEnvConfig> = {
  ethereum: {
    rpcUrlEnv: 'ETHEREUM_RPC_URL',
    confirmationsEnv: 'ETHEREUM_CONFIRMATIONS',
    defaultConfirmations: 12,
  },
  bsc: {
    rpcUrlEnv: 'BSC_RPC_URL',
    confirmationsEnv: 'BSC_CONFIRMATIONS',
    defaultConfirmations: 15,
  },
  arbitrum: {
    rpcUrlEnv: 'ARBITRUM_RPC_URL',
    confirmationsEnv: 'ARBITRUM_CONFIRMATIONS',
    defaultConfirmations: 5,
  },
  base: {
    rpcUrlEnv: 'BASE_RPC_URL',
    confirmationsEnv: 'BASE_CONFIRMATIONS',
    defaultConfirmations: 5,
  },
};

export const DEFAULT_CHAIN_CONFIGS: Record<
  SupportedChain,
  Omit<ChainConfig, 'rpcUrl' | 'masterWallet' | 'confirmations' | 'pollIntervalMs'>
> = {
  ethereum: {
    chainId: 'ethereum',
    chainName: 'Ethereum Mainnet',
    viemChain: mainnet,
    maxBlockRange: 2000,
    tokens: [
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
  },
  bsc: {
    chainId: 'bsc',
    chainName: 'BNB Smart Chain',
    viemChain: bsc,
    maxBlockRange: 5000,
    tokens: [
      // { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDT', address: '0xaEbDc04C20cFB3F2FE340714dA7b9782551DdBde', decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
  },
  arbitrum: {
    chainId: 'arbitrum',
    chainName: 'Arbitrum One',
    viemChain: arbitrum,
    maxBlockRange: 5000,
    tokens: [
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
  },
  base: {
    chainId: 'base',
    chainName: 'Base',
    viemChain: base,
    maxBlockRange: 5000,
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    ],
  },
};
