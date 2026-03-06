import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PolymarketSportsAdapter } from '../../arbitrage/adapters/predictions_bm/polymarket-sports/polymarket-sports.adapter';
import { DexsportAdapter } from '../../arbitrage/adapters/predictions_bm/dexsport/dexsport.adapter';
import {
  SportsMatch,
  DexsportSportsEvent,
  DexsportSportsOutcome,
} from '../interfaces/sports-arb.types';

/**
 * Maps DexSport sport slugs to Polymarket sport slugs (and vice versa).
 * One-to-many: a single key can be detected by multiple slugs.
 */
const SPORT_ALIASES: Record<string, string[]> = {
  csgo:           ['csgo', 'cs2', 'counter-strike'],
  lol:            ['lol', 'league-of-legends'],
  dota2:          ['dota2', 'dota-2'],
  valorant:       ['valorant'],
  'rainbow6':     ['rainbow6', 'rainbow-six', 'r6'],
  'call-of-duty': ['call-of-duty', 'cod'],
  football:       ['football', 'soccer'],
  basketball:     ['basketball'],
  tennis:         ['tennis'],
  hockey:         ['hockey'],
  baseball:       ['baseball'],
  cricket:        ['cricket'],
  volleyball:     ['volleyball'],
  handball:       ['handball'],
  mma:            ['mma', 'ufc'],
  boxing:         ['boxing'],
};

/** Normalize a sport slug to its canonical form */
function canonicalSport(slug: string): string {
  const s = slug.toLowerCase();
  for (const [canonical, aliases] of Object.entries(SPORT_ALIASES)) {
    if (aliases.includes(s)) return canonical;
  }
  return s;
}

/** Normalize a team name for fuzzy comparison */
function normTeam(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Returns true if two team names likely refer to the same team */
function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

@Injectable()
export class SportsMatcher {
  private readonly logger = new Logger(SportsMatcher.name);

  constructor(
    private readonly polyAdapter: PolymarketSportsAdapter,
    private readonly dexAdapter: DexsportAdapter,
  ) {}

  /**
   * Build the current list of matched Poly ↔ DexSport event pairs.
   * Called periodically by the scheduler.
   */
  async findMatches(): Promise<SportsMatch[]> {
    const polyEvents = this.polyAdapter.getEvents();
    const dexEvents  = this.buildDexEvents();

    const matches: SportsMatch[] = [];
    const usedDexIds = new Set<string>();

    for (const poly of polyEvents) {
      const polySport = canonicalSport(poly.sport);

      // Find DexSport event with same sport + matching team names
      const dex = dexEvents.find((d) => {
        if (usedDexIds.has(d.eventId)) return false;
        if (canonicalSport(d.sport) !== polySport) return false;
        // Both orderings: A vs B can be reversed
        return (
          (teamsMatch(poly.teamA, d.teamA) && teamsMatch(poly.teamB, d.teamB)) ||
          (teamsMatch(poly.teamA, d.teamB) && teamsMatch(poly.teamB, d.teamA))
        );
      });

      if (!dex) continue;

      usedDexIds.add(dex.eventId);

      const id = createHash('sha256')
        .update(`${poly.conditionId}:${dex.eventId}`)
        .digest('hex')
        .slice(0, 16);

      matches.push({
        id,
        sport: polySport,
        teamA: poly.teamA,
        teamB: poly.teamB,
        poly,
        dex,
        matchedAt: Date.now(),
      });
    }

    this.logger.log(
      `SportsMatcher: ${polyEvents.length} poly + ${dexEvents.length} dex → ${matches.length} matches`,
    );

    // Debug: show unmatched DexSport events grouped by sport
    const unmatchedDex = dexEvents.filter((d) => !usedDexIds.has(d.eventId));
    if (unmatchedDex.length > 0) {
      const bySport = new Map<string, string[]>();
      for (const d of unmatchedDex) {
        const s = canonicalSport(d.sport);
        if (!bySport.has(s)) bySport.set(s, []);
        bySport.get(s)!.push(`${d.teamA} vs ${d.teamB}`);
      }
      for (const [sport, names] of [...bySport.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
        this.logger.debug(
          `Unmatched dex [${sport}]: ${names.slice(0, 3).join(' | ')}${names.length > 3 ? ` ... +${names.length - 3}` : ''}`,
        );
      }
    }

    return matches;
  }

  /**
   * Convert DexSport NormalizedEvent cache into DexsportSportsEvent[] with team names.
   */
  private buildDexEvents(): DexsportSportsEvent[] {
    const normalized = this.dexAdapter.fetchEventsSync?.() ?? [];

    return normalized
      .filter((e) => e.outcomes.length >= 2)
      .map((e) => {
        // Parse team names from title: "MOUZ vs Heroic"
        const parts = e.title.split(/\s+vs\.?\s+/i);
        const teamA = parts[0]?.trim() ?? e.outcomes[0]?.name ?? 'Home';
        const teamB = parts[1]?.trim() ?? e.outcomes[e.outcomes.length - 1]?.name ?? 'Away';

        const outcomes: DexsportSportsOutcome[] = e.outcomes.map((o, i) => {
          let name: string;
          if (e.outcomes.length === 2) {
            name = i === 0 ? teamA : teamB;
          } else if (e.outcomes.length === 3) {
            name = i === 0 ? teamA : i === 1 ? 'Draw' : teamB;
          } else {
            name = o.name;
          }

          const decimalOdds = o.metadata?.decimalOdds ?? (o.price > 0 ? 1 / o.price : 0);
          return {
            name,
            decimalOdds,
            probability: decimalOdds > 0 ? 1 / decimalOdds : 0,
          };
        });

        return {
          eventId: e.externalId,
          name: e.title,
          sport: e.category ?? 'other',
          teamA,
          teamB,
          isLive: e.metadata?.isLive ?? false,
          marketId: e.metadata?.mainMarketId ?? '',
          outcomes,
          updatedAt: Date.now(),
        } satisfies DexsportSportsEvent;
      });
  }
}
