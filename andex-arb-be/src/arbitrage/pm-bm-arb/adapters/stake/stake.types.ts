/**
 * Internal types for StakeAdapter.
 */

/** Fixture metadata obtained via HTTP GraphQL */
export interface StakeFixture {
  id: string;
  name: string;
  slug: string;
  status: 'live' | 'prematch' | string;
  /** Unix ms */
  startTime: number;
  provider: string;
  /** External match ID, e.g. "sr:match:12345" */
  extId: string;
  /** Canonical sport key used by the rest of the pipeline (e.g. "csgo", "hockey") */
  sportKey: string;
  tournamentName: string;
  /** Stake-specific URL slugs for building direct links */
  sportSlug: string;       // e.g. "counter-strike", "dota-2"
  categorySlug: string;    // e.g. "usa", "wta", "international-2"
  tournamentSlug: string;  // e.g. "nba", "blast-open-spring-2026-t1"
}

/** Market from WS `sportFixtureMarketsNext` */
export interface StakeWsMarket {
  id: string;
  name: string;
  status: string;
  /** Betradar/Oddin template ID, e.g. "186", "52", "406" */
  extId: string;
  /**
   * Specifiers string from the Betradar/Oddin feed.
   * Examples: "map=1", "total=224.5", "hcp=-1.5", "" (empty for main markets)
   */
  specifiers: string;
  outcomes: StakeWsOutcome[];
}

export interface StakeWsOutcome {
  id: string;
  name: string;
  odds: number;
  active: boolean;
}
