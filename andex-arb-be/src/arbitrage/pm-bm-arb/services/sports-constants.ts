import { SportDef } from '../interfaces/sports-arb.types';

// ── Sport mapping ────────────────────────────────────────────

export const SPORTS: Record<string, SportDef> = {
  basketball: { label: 'Basketball', dexSlugs: ['basketball'], pmTags: ['basketball'] },
  tennis:     { label: 'Tennis',     dexSlugs: ['tennis'],     pmTags: ['tennis'] },
  hockey:     { label: 'Hockey',     dexSlugs: ['hockey'],     pmTags: ['hockey'] },
  football:   { label: 'Football',   dexSlugs: ['football'],   pmTags: ['soccer'] },
  csgo:       { label: 'CS2',        dexSlugs: ['csgo'],       pmTags: ['counter-strike-2'] },
  boxing:     { label: 'Boxing',     dexSlugs: ['boxing'],     pmTags: ['ufc', 'zuffa'] },
  dota2:      { label: 'Dota 2',     dexSlugs: ['dota2'],      pmTags: ['dota-2'] },
  cod:        { label: 'Call of Duty', dexSlugs: ['call-of-duty'], pmTags: ['call-of-duty'] },
  baseball:   { label: 'Baseball',   dexSlugs: ['baseball'],   pmTags: ['mlb', 'wbc', 'baseball'] },
  lol:        { label: 'League of Legends', dexSlugs: ['lol'], pmTags: ['league-of-legends'] },
  valorant:   { label: 'Valorant',   dexSlugs: ['valorant'],   pmTags: ['valorant'] },
};

// Reverse lookups
export const PM_TAG_TO_SPORT = new Map<string, string>();
export const DEX_SLUG_TO_SPORT = new Map<string, string>();

for (const [key, def] of Object.entries(SPORTS)) {
  for (const tag of def.pmTags) PM_TAG_TO_SPORT.set(tag, key);
  for (const slug of def.dexSlugs) DEX_SLUG_TO_SPORT.set(slug, key);
}

// ── Market type mapping (PM sportsMarketType → DEX market name) ──

export const MARKET_MAP: Record<string, Record<string, string[]>> = {
  basketball: {
    moneyline: ['Winner. With overtime'],
    totals:    ['Total. With overtime'],
    spreads:   ['Handicap. With overtime'],
  },
  tennis: {
    moneyline:           ['Match Winner'],
    tennis_set_handicap: ['Handicap Sets'],
    tennis_set_totals:   ['Total Sets'],
    tennis_match_totals: ['Total'],
  },
  hockey: {
    moneyline: ['Winner. With overtime'],
    spreads:   ['Handicap. With overtime'],
    totals:    ['Total. With overtime'],
  },
  csgo: {
    moneyline:       ['Match Winner'],
    child_moneyline: [], // dynamic: "Winner. Map N (With overtime)"
    map_handicap:    ['Maps Handicap'],
    totals:          ['Total maps'],
  },
  boxing: {
    moneyline: ['Fight Winner'],
  },
  dota2: {
    moneyline:       ['Match Winner'],
    child_moneyline: [], // dynamic: "Winner. Map N"
    map_handicap:    ['Maps Handicap'],
    totals:          ['Total maps'],
  },
  cod: {
    moneyline:       ['Match Winner'],
    child_moneyline: [], // dynamic: "Winner. Map N"
    map_handicap:    ['Handicap'],
    totals:          ['Total maps'],
  },
  // Candidate names prefixed with '=' require exact (non-prefix) name match against Dexsport.
  // This prevents false positives like "Total" matching "Total. 1-st half" or
  // "Handicap" matching "Asian Handicap" / "Handicap 0:1" etc.
  football: {
    spreads:                    ['=Handicap'],
    totals:                     ['=Total'],
    football_first_half_totals: ['=Total. 1-st half'],
    both_teams_to_score:        ['=Both to score'],
    total_corners:              ['=Corners. Total'],
    total_corners_1h:           ['=Corners. Total. 1-st half'],
    double_chance:              ['=Double Chance'],
  },
  baseball: {
    moneyline: ['Match Winner'],
  },
  lol: {
    moneyline:       ['Match Winner'],
    child_moneyline: [], // dynamic: "Winner. Map N"
    map_handicap:    ['Maps Handicap'],
    totals:          ['Total maps'],
  },
  valorant: {
    moneyline:       ['Match Winner'],
    child_moneyline: [], // dynamic: "Winner. Map N (With overtime)"
    totals:          ['Total maps'],
  },
};

/** Types that carry a numeric value (totals, spreads, handicaps) and need value comparison. */
export const VALUE_TYPES = new Set([
  'totals', 'spreads', 'total_corners', 'total_corners_1h', 'football_first_half_totals',
  'points', 'assists', 'rebounds',
  'tennis_set_totals', 'tennis_match_totals', 'tennis_set_handicap',
  'tennis_first_set_totals',
  'first_half_totals', 'first_half_spreads',
  'map_handicap',
]);

/**
 * Player prop market types that use dynamic Dexsport market names (include the player name).
 * Matching is done by extracting the player name from the PM question, not by fixed MARKET_MAP entries.
 */
export const PLAYER_PROP_TYPES = new Set(['points', 'assists', 'rebounds']);

/** Dexsport name suffix for each player prop type (lowercase, after the player name). */
export const PLAYER_PROP_DEX_SUFFIXES: Record<string, string> = {
  points:   ' total points. with overtime',
  assists:  ' total assists. with overtime',
  rebounds: '. rebounds. with overtime',
};

/** Types where sign can differ (spread from team A = -X, from team B = +X). Compare by abs value. */
export const SPREAD_TYPES = new Set([
  'spreads', 'first_half_spreads',
  'tennis_set_handicap',
  'map_handicap',
]);

// ── Text similarity constants ────────────────────────────────

export const MATCH_THRESHOLD = 0.60;
export const MIN_SHARED_WORDS = 2;

export const TEAM_ALIASES: Record<string, string> = {
  'bb': 'betboom',
};

export const STOP_WORDS = new Set([
  'will', 'the', 'a', 'an', 'be', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'for',
  'on', 'at', 'by', 'with', 'from', 'that', 'this', 'it', 'its', 'as', 'or', 'and',
  'but', 'if', 'do', 'does', 'did', 'has', 'have', 'had', 'not', 'no', 'yes', 'what',
  'who', 'when', 'where', 'how', 'which', 'than', 'then', 'before', 'after', 'above',
  'below', 'between', 'during', 'about', 'into', 'through', 'over', 'under', 'again',
  'further', 'once', 'market', 'close', 'price', 'end', 'day', 'month', 'year', 'vs',
  'gaming', 'esports', 'team', 'club',
]);
