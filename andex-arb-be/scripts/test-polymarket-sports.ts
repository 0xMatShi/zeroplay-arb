/**
 * Fetch all Polymarket sports moneyline markets.
 * Groups by seriesSlug dynamically, then shows sport breakdown using exact lookup.
 *
 * Run: npx ts-node scripts/test-polymarket-sports.ts
 */

import axios from 'axios';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const PAGE = 500;

interface MarketRaw {
  conditionId: string;
  question: string;
  outcomes: string;
  outcomePrices: string;
  active: boolean;
  closed: boolean;
  sportsMarketType?: string;
  events?: Array<{ id: string; slug: string; title?: string; live?: boolean; seriesSlug?: string }>;
  live?: boolean;
  volume?: string;
}

/** Mirrors SERIES_SPORT in the adapter */
const SERIES_SPORT: Record<string, string> = {
  'counter-strike': 'csgo', 'league-of-legends': 'lol', 'dota-2': 'dota2',
  'valorant': 'valorant', 'call-of-duty': 'call-of-duty', 'honor-of-kings': 'honor-of-kings',
  'starcraft-2': 'starcraft2',
  'ufc': 'mma', 'zuffa': 'boxing', 'power-slap': 'other',
  'ncaa-cbb': 'basketball', 'cwbb': 'basketball', 'nba-2026': 'basketball',
  'euroleague-basketball': 'basketball', 'pro-a': 'basketball', 'liga-endesa': 'basketball',
  'lnb': 'basketball', 'basketball-champions-league': 'basketball',
  'basketball-series-a': 'basketball', 'kbl': 'basketball', 'nbl': 'basketball', 'wll': 'basketball',
  'nhl-2026': 'hockey', 'ahl-2026': 'hockey', 'khl-2026': 'hockey',
  'shl-2026': 'hockey', 'dehl-2026': 'hockey', 'snhl-2026': 'hockey',
  'mlb': 'baseball', 'world-baseball-classic': 'baseball',
  'atp': 'tennis', 'wta': 'tennis',
  'international-cricket': 'cricket', 'pakistan-t20': 'cricket', 'sheffield-shield': 'cricket',
  'plunket-shield': 'cricket', 'csa-t20': 'cricket',
  'womens-national-cricket-league': 'cricket', 'hong-kong-t20-premier-league-women': 'cricket',
  'cricket-bangladesh': 'cricket',
  'super-rugby-pacific': 'rugby', 'united-rugby-championship': 'rugby',
  'rugby-top-14': 'rugby', 'rugby-premiership': 'rugby', 'rugby-six-nations': 'rugby',
  'japan-j2-league': 'football', 'japan-j-league': 'football',
  'primera-a': 'football', 'primera-divisin-argentina': 'football', 'primera-division': 'football',
  'fifa-friendly': 'football', 'efl-championship': 'football', 'efl-cup': 'football',
  'fa-cup': 'football', 'premier-league-2025': 'football', 'mls-2025': 'football',
  'brazil-serie-a': 'football', 'lib-2025': 'football', 'serie-b': 'football',
  'serie-a-2025': 'football', 'mex-2025': 'football', 'ere-2025': 'football',
  'tur-2025': 'football', 'primeira-liga': 'football', 'russian-premier-league': 'football',
  'k-league': 'football', 'chinese-super-league': 'football', 'la-liga-2': 'football',
  'la-liga-2025': 'football', 'saudi-professional-league': 'football',
  'ligue-1-2025': 'football', 'ligue-2': 'football', 'liga-1': 'football',
  'bundesliga-2025': 'football', 'bundesliga-2': 'football', 'ucl-2025': 'football',
  'uel-2025': 'football', 'europa-conference-league': 'football',
  'womens-champions-league': 'football', 'norway-eliteserien': 'football',
  'ukraine-premier-liha': 'football', 'czechia-1': 'football', 'morocco-1': 'football',
  'egypt-1': 'football', 'indian-super-league': 'football', 'a-league-soccer': 'football',
  'scottish-premiership': 'football', 'romania-1': 'football',
  'ncaa-fb': 'american-football', 'nfl': 'american-football',
  'pll': 'lacrosse',
};

const SPORT_MAP: Array<[RegExp, string]> = [
  [/counter.?strike|cs2|cs:go/i, 'csgo'],
  [/league of legends|\blol\b/i, 'lol'],
  [/dota.?2/i, 'dota2'],
  [/valorant/i, 'valorant'],
  [/call of duty|\bcod\b/i, 'call-of-duty'],
  [/\bsoccer\b/i, 'football'],
  [/\bbasketball\b|\bnba\b/i, 'basketball'],
  [/\btennis\b/i, 'tennis'],
  [/\bhockey\b|\bnhl\b/i, 'hockey'],
  [/\bbaseball\b|\bmlb\b/i, 'baseball'],
  [/\bcricket\b/i, 'cricket'],
  [/\bmma\b|\bufc\b/i, 'mma'],
  [/\bboxing\b/i, 'boxing'],
];

function detectSport(question: string, seriesSlug?: string): string {
  if (seriesSlug && seriesSlug in SERIES_SPORT) return SERIES_SPORT[seriesSlug];
  for (const [re, slug] of SPORT_MAP) {
    if (re.test(question)) return slug;
  }
  return 'other';
}

function safeParse<T>(value: string | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

async function fetchAll(): Promise<MarketRaw[]> {
  const all: MarketRaw[] = [];
  let offset = 0;

  process.stdout.write('Fetching');
  while (true) {
    const { data } = await axios.get<MarketRaw[]>(`${GAMMA_API}/markets`, {
      params: { active: true, closed: false, sportsMarketType: 'moneyline', limit: PAGE, offset },
      timeout: 20_000,
    });
    const batch: MarketRaw[] = Array.isArray(data) ? data : [];
    const moneyline = batch.filter((m) => m.sportsMarketType === 'moneyline');
    all.push(...moneyline);
    process.stdout.write(` ${all.length}`);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  console.log('\n');
  return all;
}

async function main() {
  console.log('=== Polymarket Sports Markets ===\n');

  const markets = await fetchAll();
  console.log(`Total moneyline markets: ${markets.length}\n`);

  // Group by sport
  const bySport = new Map<string, MarketRaw[]>();
  for (const m of markets) {
    const sport = detectSport(m.question ?? '', m.events?.[0]?.seriesSlug);
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport)!.push(m);
  }

  const sorted = [...bySport.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log('--- By sport ---');
  for (const [sport, list] of sorted) {
    const live = list.filter((m) => m.live || m.events?.[0]?.live).length;
    const liveStr = live > 0 ? `  (${live} live)` : '';
    console.log(`  ${sport.padEnd(20)} ${list.length}${liveStr}`);
  }

  // Unknown seriesSlugs — need to add to SERIES_SPORT
  const unknownSlugs = new Map<string, number>();
  for (const m of markets) {
    const slug = m.events?.[0]?.seriesSlug;
    if (slug && !(slug in SERIES_SPORT)) {
      unknownSlugs.set(slug, (unknownSlugs.get(slug) ?? 0) + 1);
    }
  }
  if (unknownSlugs.size > 0) {
    console.log(`\n--- Unknown seriesSlugs (add to SERIES_SPORT!) ---`);
    for (const [slug, count] of [...unknownSlugs.entries()].sort((a, b) => b[1] - a[1])) {
      const sample = markets.find((m) => m.events?.[0]?.seriesSlug === slug)?.question ?? '';
      console.log(`  ${String(count).padStart(4)}  ${slug.padEnd(35)}  e.g. "${sample.slice(0, 45)}"`);
    }
  }

  // Live markets
  const liveMarkets = markets.filter((m) => m.live || m.events?.[0]?.live);
  console.log(`\n--- Live markets (${liveMarkets.length}) ---`);
  for (const m of liveMarkets) {
    const outcomes: string[] = safeParse(m.outcomes, []);
    const prices = safeParse<string[]>(m.outcomePrices, []);
    const priceStr = outcomes.map((o, i) => `${o}: ${parseFloat(prices[i] ?? '0').toFixed(3)}`).join(' | ');
    const sport = detectSport(m.question ?? '', m.events?.[0]?.seriesSlug);
    console.log(`  [${sport}] ${m.question}`);
    console.log(`          ${priceStr}`);
  }
}

main().catch(console.error);
