import ethIcon from 'cryptocurrency-icons/svg/color/eth.svg'
import bnbIcon from 'cryptocurrency-icons/svg/color/bnb.svg'
import arbitrumIcon from '../assets/chain-icons/arbitrum.svg'
import baseIcon from '../assets/chain-icons/base.svg'

import usdtIcon from 'cryptocurrency-icons/svg/color/usdt.svg'
import usdcIcon from 'cryptocurrency-icons/svg/color/usdc.svg'
import genericIcon from 'cryptocurrency-icons/svg/color/generic.svg'

import type { ChainId } from '../api/types'

export const CHAIN_ICONS: Record<ChainId, string> = {
  ethereum: ethIcon,
  bsc: bnbIcon,
  arbitrum: arbitrumIcon,
  base: baseIcon,
}

const TOKEN_ICONS: Record<string, string> = {
  usdt: usdtIcon,
  usdc: usdcIcon,
}

export function getTokenIcon(symbol: string): string {
  return TOKEN_ICONS[symbol.toLowerCase()] ?? genericIcon
}
