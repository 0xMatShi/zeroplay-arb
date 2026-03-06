import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventMatch } from '../entities/event-match.entity';
import { VerifiedMatch } from '../entities/verified-match.entity';
import { MatchStatus, MatchMethod, VerificationSource } from '../interfaces/types';

/**
 * Verdict from AI verification of a match.
 */
export interface AiVerdict {
  matchId: string;
  decision: 'confirmed' | 'rejected';
  reasoning: string;
  /** Confidence from AI (0.0 - 1.0) */
  confidence: number;
  /** How this verdict was produced */
  source: (typeof VerificationSource)[keyof typeof VerificationSource];
}

/** Max matches to verify in a single API call */
const BATCH_SIZE = 10;

/** Max matches to process per verifyPendingMatches() call */
const MAX_PER_CYCLE = 10000;

/**
 * Text-similarity above this threshold → auto-confirm without AI.
 * 0.95 — titles must be virtually identical (differ by at most 1-2 words).
 */
const AUTO_CONFIRM_THRESHOLD = 0.95;

/**
 * System prompt — tuned for balanced confirmation of prediction market matches.
 *
 * Key philosophy: the question is NOT "are the titles identical?" but
 * "would these two markets ALWAYS resolve the same way?"
 */
const SYSTEM_PROMPT = `You are a prediction market analyst specializing in cross-platform arbitrage.

Your task: determine if two prediction market events from different platforms would ALWAYS resolve the same way. If Event A resolves "Yes", would Event B necessarily also resolve "Yes", and vice versa?

## Decision Framework

Ask yourself: "Is there ANY realistic scenario where one market resolves Yes and the other resolves No?"

- If NO such scenario exists → **confirmed**
- If such a scenario clearly exists → **rejected**

## CONFIRM when:

1. **Same question, different wording:**
   - "Will BTC hit $100k by end of 2025?" ↔ "Bitcoin to reach $100,000 before January 2026" → CONFIRM (same threshold, same deadline)
   - "Will Trump win the 2024 election?" ↔ "Trump to become President in 2024" → CONFIRM
   - "Democrats win White House" ↔ "Will a Democrat be elected president in 2024?" → CONFIRM
   - "SpaceX Starship orbital flight in 2025?" ↔ "Will Starship reach orbit before 2026?" → CONFIRM

2. **Minor cosmetic differences that don't change resolution:**
   - "Super Bowl 2026" ↔ "Super Bowl LX" → CONFIRM (same event)
   - "Ethereum above $5,000" ↔ "ETH price over $5000" → CONFIRM
   - Platform A says "Yes/No", Platform B says "Up/Down" → fine if underlying question is the same

3. **Same entity + same achievement + same timeframe** = CONFIRM:
   - "Lakers win 2026 NBA Championship" ↔ "Will the Los Angeles Lakers win the 2025-26 NBA Finals?" → CONFIRM

## REJECT when:

1. **Different thresholds or deadlines:**
   - "$100k" vs "$150k" — different thresholds
   - "by March" vs "by June" — different deadlines

2. **Different scope (subset/superset):**
   - "Win championship" vs "Make playoffs" — making playoffs ≠ winning championship
   - "Top 6 finish" vs "2nd place" — 2nd place ⊂ top 6
   - "Win gold medal" vs "Win any medal" — gold ⊂ any medal 

3. **Different events entirely — same deadline is NOT enough:**
   - "Win MVP" vs "Win Rookie of the Year"
   - "Regular season" vs "Playoffs"
   - "Will Theo launch a token by March 31?" vs "Bitcoin all time high by March 31?" — shared deadline only, completely different subjects → REJECT
   - Any two events where the ONLY shared words are dates, months, years, or numbers → REJECT

4. **Same entity, different type of question:**
   - "Trail Blazers vs. Bulls" vs "Will Trail Blazers finish with the best NBA record?" — same team, but single game ≠ season achievement → REJECT
   - "Messi scores in the match" vs "Will Messi win the Ballon d'Or?" — same person, different question → REJECT
   - "Hyperliquid listed on Binance in 2026?" vs "Will Hyperliquid perform an airdrop by December 31, 2026?" — same crypto project, but exchange listing ≠ airdrop (airdrop can happen without listing) → REJECT
   - The same entity (team, player, coin, company) appearing in both titles is NOT sufficient. The underlying question must be the same type:
     - game/match result ≠ season record or championship
     - single event ≠ career/season achievement
     - "X vs Y" matchup ≠ "Will X win the league/tournament?"
     - exchange listing ≠ airdrop ≠ token launch ≠ price milestone (these are independent crypto events)

## Smell test before confirming:

Ask yourself two questions:
1. "If I remove all dates, numbers, and deadlines from both titles, do they still describe the same event?" If NO → REJECT
2. "Are both events the same TYPE of question (single game vs single game, season record vs season record)?" If NO → REJECT
- "Trail Blazers vs. Bulls" vs "Will Trail Blazers finish with best NBA record?" → different type → REJECT
- "Hyperliquid listed on Binance" vs "Hyperliquid perform an airdrop" → different action on same entity → REJECT
- "Will Theo launch a token" vs "Bitcoin all time high" → completely different subject → REJECT
- "Will BTC hit $100k" vs "Bitcoin to reach $100,000" → same subject, same type → CONFIRM

## Important guidelines:

- Prediction markets on different platforms OFTEN ask the same question with slightly different phrasing — this is expected and normal.
- When the core question is clearly the same, CONFIRM it. Don't reject over trivial wording differences.
- Focus on RESOLUTION EQUIVALENCE: would the outcomes always match?
- If the outcome names differ but map naturally (Yes↔Yes, No↔No, or Up↔Yes, Down↔No), that's fine.
- Categories and descriptions provide helpful context — use them.
- High text similarity (>60%) combined with the same topic is a strong signal.
- **When in doubt, REJECT.** A false positive in arbitrage costs real money. Only confirm when you can clearly identify the same underlying real-world question.

Return your analysis as a JSON array.`;

/**
 * AI-powered verification service for event matches.
 *
 * Pipeline:
 * 1. Auto-confirm obvious matches (high text similarity, cross-platform refs)
 * 2. Send remaining to LLM for nuanced verification
 * 3. Apply verdicts — binary confirm/reject (no "uncertain" limbo)
 *
 * Improvements over v1:
 * - Balanced prompt favoring resolution equivalence over exact wording
 * - Auto-confirm for high-confidence text matches (>0.8)
 * - Auto-confirm for cross-platform references (polymarketConditionIds)
 * - No "uncertain" — binary decision reduces PENDING backlog
 * - More context in prompt (500 char descriptions, categories, outcome structure)
 */
@Injectable()
export class AiVerificationService {
  private readonly logger = new Logger(AiVerificationService.name);
  private readonly apiKey: string | null;
  private readonly model: string;

  constructor(
    @InjectRepository(EventMatch)
    private readonly matchRepo: Repository<EventMatch>,
    @InjectRepository(VerifiedMatch)
    private readonly verifiedMatchRepo: Repository<VerifiedMatch>,
  ) {
    const key = process.env.OPENROUTER_API_KEY;

    if (key) {
      this.apiKey = key;
      this.model = process.env.AI_VERIFICATION_MODEL || 'anthropic/claude-sonnet-4.6';
      this.logger.log(`AI verification enabled via OpenRouter (model: ${this.model})`);
    } else {
      this.apiKey = null;
      this.model = '';
      this.logger.warn('OPENROUTER_API_KEY not set — AI verification disabled.');
    }
  }

  /**
   * Is the service configured and ready?
   */
  isEnabled(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Verify all PENDING matches created by the text matcher.
   * Returns the number of matches processed.
   */
  async verifyPendingMatches(): Promise<{
    processed: number;
    confirmed: number;
    rejected: number;
    autoConfirmed: number;
    errors: number;
  }> {
    if (!this.apiKey) {
      this.logger.warn('AI verification skipped — no API key');
      return { processed: 0, confirmed: 0, rejected: 0, autoConfirmed: 0, errors: 0 };
    }

    // Fetch pending matches with their events
    const pendingMatches = await this.matchRepo.find({
      where: { status: MatchStatus.PENDING, matchMethod: MatchMethod.AUTO },
      relations: ['events', 'events.platform', 'events.outcomes'],
      order: { confidence: 'DESC' },
      take: MAX_PER_CYCLE,
    });

    if (pendingMatches.length === 0) {
      this.logger.debug('No pending matches to verify');
      return { processed: 0, confirmed: 0, rejected: 0, autoConfirmed: 0, errors: 0 };
    }

    this.logger.log(`Verifying ${pendingMatches.length} pending matches...`);

    const stats = { processed: 0, confirmed: 0, rejected: 0, autoConfirmed: 0, errors: 0 };

    // Phase 1: Auto-confirm high-similarity matches
    const needsAi: EventMatch[] = [];
    for (const match of pendingMatches) {
      const autoVerdict = this.tryAutoConfirm(match);
      if (autoVerdict) {
        try {
          await this.applyVerdict(autoVerdict);
          stats.confirmed++;
          stats.autoConfirmed++;
        } catch (err) {
          this.logger.warn(`Failed to apply auto-verdict for match ${match.id}: ${err.message}`);
          stats.errors++;
        }
      } else {
        needsAi.push(match);
      }
    }
    stats.processed = pendingMatches.length;

    // Phase 2: AI verification for remaining matches
    for (let i = 0; i < needsAi.length; i += BATCH_SIZE) {
      const batch = needsAi.slice(i, i + BATCH_SIZE);
      const verdicts = await this.verifyBatch(batch);

      for (const verdict of verdicts) {
        try {
          await this.applyVerdict(verdict);

          if (verdict.decision === 'confirmed') stats.confirmed++;
          else stats.rejected++;
        } catch (err) {
          this.logger.warn(`Failed to apply verdict for match ${verdict.matchId}: ${err.message}`);
          stats.errors++;
        }
      }
    }

    this.logger.log(
      `Verification complete: ${stats.processed} processed, ` +
        `${stats.confirmed} confirmed (${stats.autoConfirmed} auto), ` +
        `${stats.rejected} rejected, ${stats.errors} errors`,
    );

    return stats;
  }

  /**
   * Verify a single match by ID. Useful for manual/on-demand verification.
   */
  async verifySingleMatch(matchId: string): Promise<AiVerdict | null> {
    if (!this.apiKey) {
      this.logger.warn('AI verification skipped — no API key');
      return null;
    }

    const match = await this.matchRepo.findOne({
      where: { id: matchId },
      relations: ['events', 'events.platform', 'events.outcomes'],
    });

    if (!match) {
      throw new Error(`Match ${matchId} not found`);
    }

    const verdicts = await this.verifyBatch([match]);
    if (verdicts.length > 0) {
      await this.applyVerdict(verdicts[0]);
      return verdicts[0];
    }

    return null;
  }

  // ==================== Phase 1: Auto-Confirm ====================

  private tryAutoConfirm(match: EventMatch): AiVerdict | null {
    const events = match.events || [];
    if (events.length < 2) return null;

    // Only auto-confirm on extremely high text similarity (titles are nearly identical)
    if (Number(match.confidence) >= AUTO_CONFIRM_THRESHOLD) {
      return {
        matchId: match.id,
        decision: 'confirmed',
        reasoning: `Auto-confirmed: text similarity ${(Number(match.confidence) * 100).toFixed(0)}% >= ${AUTO_CONFIRM_THRESHOLD * 100}% threshold`,
        confidence: Number(match.confidence),
        source: VerificationSource.AUTO,
      };
    }

    // Cross-platform references (e.g. predict.fun → polymarketConditionIds) are hints,
    // NOT proof of identical resolution. The referenced market may be related but different
    // (e.g. "win a game" vs "win the tournament"). Always send these to AI for semantic check.

    return null;
  }

  private checkCrossPlatformRefs(events: any[]): string | null {
    for (const event of events) {
      const rawData = event.rawData || {};

      // predict.fun → Polymarket reference
      const polyConditionIds: string[] = rawData.polymarketConditionIds || [];
      if (polyConditionIds.length > 0) {
        for (const other of events) {
          if (other.id === event.id) continue;
          const otherPlatform = other.platform?.slug || '';
          if (otherPlatform === 'polymarket') {
            const otherConditionId = other.rawData?.conditionId || other.rawData?.condition_id;
            if (otherConditionId && polyConditionIds.includes(otherConditionId)) {
              return `predict.fun polymarketConditionIds contains ${otherConditionId}`;
            }
          }
        }
      }

      // predict.fun → Kalshi reference
      const kalshiTicker: string | null = rawData.kalshiMarketTicker || null;
      if (kalshiTicker) {
        for (const other of events) {
          if (other.id === event.id) continue;
          const otherPlatform = other.platform?.slug || '';
          if (otherPlatform === 'kalshi') {
            const otherTicker = other.externalId || other.rawData?.ticker;
            if (otherTicker && otherTicker === kalshiTicker) {
              return `predict.fun kalshiMarketTicker matches ${kalshiTicker}`;
            }
          }
        }
      }
    }
    return null;
  }

  // ==================== Phase 2: AI Verification ====================

  /**
   * Send a batch of matches to the AI for verification.
   */
  private async verifyBatch(matches: EventMatch[]): Promise<AiVerdict[]> {
    const matchDescriptions = matches
      .map((match, idx) => {
        const events = match.events || [];
        if (events.length < 2) return null;

        const e1 = events[0];
        const e2 = events[1];

        return {
          index: idx + 1,
          matchId: match.id,
          textSimilarity: Number(match.confidence),
          crossPlatformRef: this.checkCrossPlatformRefs(events) as string | null,
          event1: this.formatEventForPrompt(e1),
          event2: this.formatEventForPrompt(e2),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    if (matchDescriptions.length === 0) return [];

    const userPrompt = `Analyze these ${matchDescriptions.length} candidate matches. For each, decide if the two markets would ALWAYS resolve the same way.

${matchDescriptions
  .map(
    (m) => `--- Match #${m.index} (text similarity: ${(m.textSimilarity * 100).toFixed(0)}%${m.crossPlatformRef ? `, cross-platform ref: ${m.crossPlatformRef}` : ''}) ---
Platform A (${m.event1.platform}): "${m.event1.title}"
${m.event1.description ? `  Description: ${m.event1.description}` : ''}
${m.event1.category ? `  Category: ${m.event1.category}` : ''}
  Outcomes: ${m.event1.outcomes.join(', ')}

Platform B (${m.event2.platform}): "${m.event2.title}"
${m.event2.description ? `  Description: ${m.event2.description}` : ''}
${m.event2.category ? `  Category: ${m.event2.category}` : ''}
  Outcomes: ${m.event2.outcomes.join(', ')}
${m.crossPlatformRef ? `  Note: Platform A explicitly references Platform B's market ID. This is a hint they may be related, but verify the underlying question is truly identical before confirming.` : ''}`,
  )
  .join('\n')}

Return a JSON array with one object per match:
[
  {
    "index": 1,
    "decision": "confirmed" | "rejected",
    "reasoning": "Brief explanation (1-2 sentences)",
    "confidence": 0.0-1.0
  }
]

Rules:
- ONLY "confirmed" or "rejected" — no "uncertain". Make a decision.
- When in doubt, use "rejected". False positives cost real money.
- "confirmed" means you are confident these markets resolve identically.
- Same entity (team, player, coin) is NOT enough — the type of question must also be the same (single game ≠ tournament win, one match ≠ season record).
- ONLY return the JSON array, no markdown fences, no extra text.`;

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 3000,
          reasoning: { enabled: true },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`OpenRouter API error ${res.status}: ${errText.slice(0, 200)}`);
        return [];
      }

      const response = await res.json() as { choices?: { message?: { content?: string } }[] };
      const content: string | undefined = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        this.logger.warn('Empty AI response');
        return [];
      }

      // Parse JSON — strip markdown fences if present
      const jsonStr = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

      let results: { index: number; decision: string; reasoning: string; confidence: number }[];

      try {
        results = JSON.parse(jsonStr);
      } catch (parseErr) {
        this.logger.error(`Failed to parse AI response: ${jsonStr.slice(0, 200)}`);
        return [];
      }

      if (!Array.isArray(results)) {
        this.logger.error('AI response is not an array');
        return [];
      }

      // Map back to verdicts
      return results
        .map((r) => {
          const matchDesc = matchDescriptions.find((m) => m.index === r.index);
          if (!matchDesc) return null;

          // Normalize decision — treat anything that's not explicitly "confirmed" as rejected
          // This prevents ambiguous responses from slipping through as false positives
          const decision = r.decision === 'confirmed' ? 'confirmed' : 'rejected';

          const verdict: AiVerdict = {
            matchId: matchDesc.matchId,
            decision,
            reasoning: r.reasoning || 'No reasoning provided',
            confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
            source: VerificationSource.AI,
          };
          return verdict;
        })
        .filter((v): v is AiVerdict => v !== null);
    } catch (error) {
      this.logger.error(`AI verification API call failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Format an event for the AI prompt — includes more context than before.
   */
  private formatEventForPrompt(event: any): {
    platform: string;
    title: string;
    description: string;
    category: string;
    outcomes: string[];
  } {
    return {
      platform: event.platform?.name || 'Unknown',
      title: event.title || '',
      // 500 chars of description for better context
      description: (event.description || '').slice(0, 500),
      category: event.category || '',
      outcomes: (event.outcomes || []).map(
        (o: any) => `${o.name} @ $${Number(o.price).toFixed(2)}`,
      ),
    };
  }

  // ==================== Apply Verdict ====================

  /**
   * Apply an AI verdict to a match record.
   * On confirm: upsert into verified_matches.
   * On reject: remove from verified_matches (reversal).
   */
  private async applyVerdict(verdict: AiVerdict): Promise<void> {
    const match = await this.matchRepo.findOne({ where: { id: verdict.matchId } });
    if (!match) return;

    const prevStatus = match.status;

    if (verdict.decision === 'confirmed') {
      match.status = MatchStatus.CONFIRMED;
      match.matchMethod = verdict.source === VerificationSource.AI ? MatchMethod.AI : MatchMethod.AUTO;
      match.confidence = verdict.confidence;

      await this.matchRepo.save(match);

      // Upsert into verified_matches (idempotent — safe on repeated calls)
      await this.verifiedMatchRepo.upsert(
        {
          eventMatchId: verdict.matchId,
          verificationSource: verdict.source,
          confidence: verdict.confidence,
        },
        ['eventMatchId'],
      );
    } else {
      match.status = MatchStatus.REJECTED;
      match.matchMethod = MatchMethod.AI;
      match.confidence = verdict.confidence;

      await this.matchRepo.save(match);

      // Remove from verified_matches if it was previously confirmed
      await this.verifiedMatchRepo.delete({ eventMatchId: verdict.matchId });
    }

    const label = verdict.decision === 'confirmed' ? 'CONFIRMED' : 'REJECTED';

    this.logger.log(
      `${label} match "${match.title}" (${prevStatus} → ${match.status}, ` +
        `conf: ${(verdict.confidence * 100).toFixed(0)}%): ${verdict.reasoning}`,
    );
  }

  // ==================== Stats ====================

  /**
   * Get verification stats.
   */
  async getStats(): Promise<{
    totalPending: number;
    totalConfirmed: number;
    totalRejected: number;
    aiVerified: number;
  }> {
    const [totalPending, totalConfirmed, totalRejected, aiVerified] = await Promise.all([
      this.matchRepo.count({ where: { status: MatchStatus.PENDING } }),
      this.matchRepo.count({ where: { status: MatchStatus.CONFIRMED } }),
      this.matchRepo.count({ where: { status: MatchStatus.REJECTED } }),
      this.matchRepo.count({ where: { matchMethod: MatchMethod.AI } }),
    ]);

    return { totalPending, totalConfirmed, totalRejected, aiVerified };
  }
}
