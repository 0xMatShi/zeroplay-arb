/**
 * Raw types for the Polymarket Gamma API sports events/markets.
 */

export interface PolymarketSportsMarketRaw {
  conditionId: string;
  slug?: string;
  question: string;
  sportsMarketType?: string | null;

  /** JSON string: '["Team A","Team B"]' */
  outcomes: string;
  /** JSON string: '["0.85","0.15"]' */
  outcomePrices: string;
  /** JSON string: '["tokenId1","tokenId2"]' */
  clobTokenIds: string;

  active: boolean;
  closed: boolean;
  live?: boolean;
}

export interface PolymarketSportsEventRaw {
  id: string;
  slug: string;
  title: string;
  active?: boolean;
  closed?: boolean;
  live?: boolean;
  seriesSlug?: string;
  startTime?: string;
  tags?: Array<{ slug: string; label?: string }>;
  markets?: PolymarketSportsMarketRaw[];
}
