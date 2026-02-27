import { createConfig, http } from 'wagmi'
import { sepolia, bscTestnet } from 'wagmi/chains'
import { injected, metaMask, safe, walletConnect } from 'wagmi/connectors'

// Настройка wagmi конфигурации
export const config = createConfig({
  chains: [sepolia, bscTestnet],
  connectors: [
    injected(),
    metaMask(),
    walletConnect({
      projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '',
    }),
    safe(),
  ],
  transports: {
    [sepolia.id]: http(),
    [bscTestnet.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
