/**
 * Raw types for the Polymarket Gamma API sports markets endpoint.
 * GET https://gamma-api.polymarket.com/markets?sportsMarketType=moneyline
 */

export interface PolymarketSportsMarketRaw {
  conditionId: string;
  slug: string;
  question: string;

  /** JSON string: '["MOUZ","Heroic"]' — for moneyline these are team names */
  outcomes: string;
  /** JSON string: '["0.85","0.15"]' */
  outcomePrices: string;
  /** JSON string: '["{tokenId1}","{tokenId2}"]' */
  clobTokenIds: string;

  active: boolean;
  closed: boolean;

  /** "moneyline" | "spread" | "total" — we only care about "moneyline" */
  sportsMarketType?: string;

  /** Sport series identifier, e.g. "CS2", "NFL", "NBA" */
  series?: string;

  /** Parent event info */
  events?: PolymarketSportsEventParent[];

  /** Tagging info for sport detection */
  tags?: PolymarketTag[];

  /** Whether the game is currently live */
  live?: boolean;

  endDate?: string;
  volume?: string;
  liquidity?: string;
}

export interface PolymarketSportsEventParent {
  id: string;
  slug: string;
  title?: string;
  live?: boolean;
  score?: string;
  period?: string;
  /** e.g. "ncaa-cbb", "nba", "nhl", "mlb", "ufc", "epl", "lpl" */
  seriesSlug?: string;
}

export interface PolymarketTag {
  id: string;
  slug: string;
  label?: string;
}
