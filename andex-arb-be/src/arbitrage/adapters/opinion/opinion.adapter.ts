// import { Injectable, OnModuleInit } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { BaseAdapter } from '../base.adapter';
// import { AdapterRegistry } from '../adapter.registry';
// import {
//   NormalizedEvent,
//   NormalizedOutcome,
//   EventStatus,
//   OutcomeType,
//   PlatformInfo,
//   ArbitrageLeg,
//   OrderBook,
//   OrderBookEntry,
// } from '../../interfaces/types';
// import {
//   OpinionTopic,
//   OpinionChildMarket,
//   OpinionTopicListResult,
//   OpinionOrderBookResult,
//   OpinionApiResponse,
// } from './opinion.types';

// /**
//  * Opinion proxy API — no API key required.
//  * GET /topic returns a paginated list of topics (markets) with nested childList for categorical markets.
//  */
// const OPINION_API_BASE = 'https://proxy.opinion.trade:8443/api/bsc/api/v2';
// const OPINION_BASE_URL = 'https://app.opinion.trade';
// const MAX_PAGES = 300;
// const PAGE_LIMIT = 20; // Opinion API enforces max ~20 items per page

// @Injectable()
// export class OpinionAdapter extends BaseAdapter implements OnModuleInit {
//   readonly platformSlug = 'opinion';
//   readonly platformName = 'Opinion';

//   constructor(
//     private readonly configService: ConfigService,
//     private readonly registry: AdapterRegistry,
//   ) {
//     super(OPINION_API_BASE);
//   }

//   onModuleInit() {
//     this.registry.register(this);
//   }

//   getPlatformInfo(): PlatformInfo {
//     return {
//       slug: this.platformSlug,
//       name: this.platformName,
//       baseUrl: OPINION_BASE_URL,
//       defaultPollIntervalMs: 120_000, // 2 minutes
//     };
//   }

//   // ───────────────────────── fetchEvents ─────────────────────────

//   /**
//    * Fetch all active topics from Opinion.
//    *
//    * Uses GET /topic with page-based pagination.
//    * - status=2 → activated markets only
//    * - topicType=2 → both binary & categorical
//    * - sortBy=5 → volume24h descending (most liquid first)
//    *
//    * Categorical topics (with childList) become MULTI events.
//    * Binary topics (without childList) become BINARY events.
//    */
//   async fetchEvents(): Promise<NormalizedEvent[]> {
//     const allTopics: OpinionTopic[] = [];

//     for (let page = 1; page <= MAX_PAGES; page++) {
//       try {
//         const { data } = await this.http.get<OpinionApiResponse<OpinionTopicListResult>>('/topic', {
//           params: {
//             page,
//             limit: PAGE_LIMIT,
//             status: 2, // activated
//             topicType: 2, // all (binary + categorical)
//             sortBy: 5, // volume24h desc
//             chainId: 56, // BNB chain
//             isShow: 1,
//             indicatorType: 0,
//             excludePin: 1,
//           },
//         });

//         if (data?.errno !== 0 || !data?.result?.list) {
//           this.logger.warn(
//             `Opinion API error (page ${page}): errno=${data?.errno}, msg=${data?.errmsg}`,
//           );
//           break;
//         }

//         const topics = data.result.list;
//         if (topics.length === 0) break;

//         allTopics.push(...topics);

//         // Check if we fetched everything
//         if (allTopics.length >= data.result.total || topics.length < PAGE_LIMIT) {
//           break;
//         }

//         // Rate limiting
//         await this.sleep(200);
//       } catch (error) {
//         this.logger.error(`Failed to fetch Opinion topics page ${page}: ${error.message}`);
//         break;
//       }
//     }

//     this.logger.log(`Fetched ${allTopics.length} active topics from Opinion`);

//     return allTopics
//       .map((topic) => this.normalizeTopic(topic))
//       .filter((e): e is NormalizedEvent => e !== null);
//   }

//   // ───────────────────────── fetchPrices ─────────────────────────

//   /**
//    * Re-fetch prices for known markets.
//    * Since the /topic list endpoint already returns prices,
//    * we re-fetch the list and filter for the requested topicIds.
//    */
//   async fetchPrices(externalEventIds: string[]): Promise<Map<string, NormalizedOutcome[]>> {
//     const result = new Map<string, NormalizedOutcome[]>();

//     // Build a set of topicIds we're looking for
//     const targetIds = new Set(
//       externalEventIds.map((id) => {
//         const numId = id.replace(/^(cat|bin)-/, '');
//         return parseInt(numId, 10);
//       }),
//     );

//     // Paginate through topics until we've found all targets (or exhausted pages)
//     let found = 0;

//     for (let page = 1; page <= MAX_PAGES && found < targetIds.size; page++) {
//       try {
//         const { data } = await this.http.get<OpinionApiResponse<OpinionTopicListResult>>('/topic', {
//           params: {
//             page,
//             limit: PAGE_LIMIT,
//             status: 2,
//             topicType: 2,
//             sortBy: 5,
//             chainId: 56,
//             isShow: 1,
//             indicatorType: 0,
//             excludePin: 1,
//           },
//         });

//         if (data?.errno !== 0 || !data?.result?.list) break;

//         const topics = data.result.list;
//         if (topics.length === 0) break;

//         for (const topic of topics) {
//           if (!targetIds.has(topic.marketId)) continue;

//           const normalized = this.normalizeTopic(topic);
//           if (normalized) {
//             result.set(normalized.externalId, normalized.outcomes);
//             found++;
//           }
//         }

//         if (topics.length < PAGE_LIMIT) break;
//         await this.sleep(200);
//       } catch (error) {
//         this.logger.warn(`Failed to fetch Opinion prices page ${page}: ${error.message}`);
//         break;
//       }
//     }

//     return result;
//   }

//   // ───────────────────────── Order Book ─────────────────────────

//   /**
//    * Fetch the order book for a specific arbitrage leg.
//    *
//    * Uses outcome metadata:
//    * - symbol:     position ID (yesPos or noPos) — used as `symbol` param
//    * - symbolType: 0 for Yes, 1 for No — used as `symbol_types` param
//    * - questionId: question hash — used as `question_id` param
//    * - chainId:    blockchain chain ID (56 for BSC)
//    *
//    * API: GET /order/market/depth?symbol=...&chainId=...&question_id=...&symbol_types=...
//    */
//   async fetchOrderBook(leg: ArbitrageLeg): Promise<OrderBook | null> {
//     const meta = leg.metadata;

//     if (!meta?.symbol || !meta?.questionId) {
//       this.logger.warn(
//         `Cannot fetch order book for Opinion leg "${leg.outcomeName}": missing symbol or questionId in metadata`,
//       );
//       return null;
//     }

//     try {
//       const { data } = await this.http.get<OpinionApiResponse<OpinionOrderBookResult>>(
//         '/order/market/depth',
//         {
//           params: {
//             symbol: meta.symbol,
//             chainId: meta.chainId || '56',
//             question_id: meta.questionId,
//             symbol_types: meta.symbolType ?? 0,
//           },
//           timeout: 10_000,
//         },
//       );

//       if (data?.errno !== 0 || !data?.result) {
//         this.logger.warn(`Opinion order book API error: errno=${data?.errno}, msg=${data?.errmsg}`);
//         return null;
//       }

//       const result = data.result;

//       const bids: OrderBookEntry[] = (result.bids || [])
//         .map(([price, qty]) => ({
//           price: parseFloat(price),
//           quantity: parseFloat(qty),
//         }))
//         .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
//         .sort((a, b) => b.price - a.price); // best bid first

//       const asks: OrderBookEntry[] = (result.asks || [])
//         .map(([price, qty]) => ({
//           price: parseFloat(price),
//           quantity: parseFloat(qty),
//         }))
//         .filter((e) => !isNaN(e.price) && !isNaN(e.quantity))
//         .sort((a, b) => a.price - b.price); // best ask first

//       return {
//         bids,
//         asks,
//         lastPrice: result.last_price ? parseFloat(result.last_price) : undefined,
//         timestamp: result.ts || Date.now(),
//       };
//     } catch (error) {
//       this.logger.error(
//         `Failed to fetch Opinion order book for "${leg.outcomeName}": ${error.message}`,
//       );
//       return null;
//     }
//   }

//   // ───────────────────────── Normalization ─────────────────────────

//   /**
//    * Convert an Opinion topic to our normalized format.
//    * Detects categorical vs binary by presence of childList.
//    */
//   private normalizeTopic(topic: OpinionTopic): NormalizedEvent | null {
//     try {
//       // Normalize field aliases
//       const id = topic.marketId ?? topic.topicId;
//       const children = topic.childMarkets ?? topic.childList;
//       const isCategorical = Array.isArray(children) && children.length > 0;

//       // Patch normalized fields onto topic for downstream methods
//       topic.marketId = id;
//       topic.marketTitle = topic.marketTitle ?? topic.title;
//       topic.childMarkets = children;
//       topic.yesTokenId = topic.yesTokenId ?? topic.yesPos;
//       topic.noTokenId = topic.noTokenId ?? topic.noPos;
//       topic.cutoffAt = topic.cutoffAt ?? topic.cutoffTime;
//       topic.createdAt = topic.createdAt ?? topic.createTime;

//       if (!topic.marketId || !topic.marketTitle) return null;

//       if (isCategorical) {
//         return this.normalizeCategoricalTopic(topic);
//       }

//       return this.normalizeBinaryTopic(topic);
//     } catch (error) {
//       this.logger.warn(`Failed to normalize Opinion topic ${topic.marketId ?? topic.topicId}: ${error.message}`);
//       return null;
//     }
//   }

//   /**
//    * Normalize a categorical topic (with childMarkets) to a MULTI event.
//    * Each child market becomes one outcome.
//    */
//   private normalizeCategoricalTopic(topic: OpinionTopic): NormalizedEvent | null {
//     const outcomes = this.parseCategoricalOutcomes(topic.childMarkets!);
//     if (outcomes.length === 0) return null;

//     return {
//       externalId: `cat-${topic.marketId}`,
//       title: topic.marketTitle,
//       description: topic.rules || undefined,
//       endDate: topic.cutoffAt ? new Date(topic.cutoffAt * 1000) : undefined,
//       status: EventStatus.ACTIVE,
//       outcomeType: OutcomeType.MULTI,
//       outcomes,
//       url: `${OPINION_BASE_URL}/detail?topicId=${topic.marketId}`,
//       metadata: {
//         topicId: topic.marketId,
//         type: 'categorical',
//         chainId: topic.chainId,
//         volume: topic.volume,
//         volume24h: topic.volume24h,
//         volume7d: topic.volume7d,
//         childCount: topic.childMarkets!.length,
//       },
//     };
//   }

//   /**
//    * Normalize a binary topic (no childMarkets) to a BINARY event.
//    */
//   private normalizeBinaryTopic(topic: OpinionTopic): NormalizedEvent | null {
//     const outcomes = this.parseBinaryOutcomes(topic);
//     if (outcomes.length === 0) return null;

//     return {
//       externalId: `bin-${topic.marketId}`,
//       title: topic.marketTitle,
//       description: topic.rules || undefined,
//       endDate: topic.cutoffAt ? new Date(topic.cutoffAt * 1000) : undefined,
//       status: EventStatus.ACTIVE,
//       outcomeType: OutcomeType.BINARY,
//       outcomes,
//       url: `${OPINION_BASE_URL}/detail?topicId=${topic.marketId}`,
//       metadata: {
//         topicId: topic.marketId,
//         type: 'binary',
//         chainId: topic.chainId,
//         questionId: topic.questionId,
//         volume: topic.volume,
//         volume24h: topic.volume24h,
//         volume7d: topic.volume7d,
//         yesPos: topic.yesTokenId,
//         noPos: topic.noTokenId,
//       },
//     };
//   }

//   // ───────────────────────── Outcome Parsing ─────────────────────────

//   /**
//    * Parse outcomes from a categorical topic.
//    * Each child market's YES side represents one outcome of the parent question.
//    * We use yesMarketPrice (last trade) when available, falling back to yesBuyPrice (best ask).
//    */
//   private parseCategoricalOutcomes(children: OpinionChildMarket[]): NormalizedOutcome[] {
//     return children
//       .filter((child) => child.status === 2) // activated only
//       .map((child) => {
//         const price = this.parsePrice(child.yesMarketPrice, child.yesBuyPrice);

//         return {
//           externalId: child.questionId || `${child.marketId}-yes`,
//           name: child.marketTitle.trim(),
//           price: this.clampPrice(price),
//           volume24h: child.volume24h ? parseFloat(child.volume24h) : undefined,
//           metadata: {
//             side: 'yes',
//             symbol: child.yesTokenId,
//             symbolType: 0,
//             questionId: child.questionId,
//             chainId: child.chainId,
//             topicId: child.marketId,
//             childTopicId: child.marketId,
//             yesBuyPrice: child.yesBuyPrice,
//             yesMarketPrice: child.yesMarketPrice,
//             noBuyPrice: child.noBuyPrice,
//             noSymbol: child.noTokenId,
//           },
//         };
//       })
//       .filter((o) => o.price > 0); // drop zero-price outcomes
//   }

//   /**
//    * Parse Yes/No outcomes from a binary topic.
//    * Prices come as strings in the 0.0-1.0 range.
//    */
//   private parseBinaryOutcomes(topic: OpinionTopic): NormalizedOutcome[] {
//     const yesPrice = this.parsePrice(topic.yesMarketPrice, topic.yesBuyPrice);
//     const noPrice = this.parsePrice(undefined, topic.noBuyPrice) || 1 - yesPrice;

//     // Skip topics with no meaningful price data
//     if (yesPrice === 0 && noPrice === 0) return [];

//     const volume24h = topic.volume24h ? parseFloat(topic.volume24h) : undefined;

//     return [
//       {
//         externalId: topic.questionId || `${topic.marketId}-yes`,
//         name: topic.yesLabel || 'Yes',
//         price: this.clampPrice(yesPrice),
//         volume24h,
//         metadata: {
//           side: 'yes',
//           symbol: topic.yesTokenId,
//           symbolType: 0,
//           questionId: topic.questionId,
//           chainId: topic.chainId,
//           topicId: topic.marketId,
//           yesBuyPrice: topic.yesBuyPrice,
//           yesMarketPrice: topic.yesMarketPrice,
//         },
//       },
//       {
//         externalId: topic.noTokenId || `${topic.marketId}-no`,
//         name: topic.noLabel || 'No',
//         price: this.clampPrice(noPrice),
//         volume24h,
//         metadata: {
//           side: 'no',
//           symbol: topic.noTokenId,
//           symbolType: 1,
//           questionId: topic.questionId,
//           chainId: topic.chainId,
//           topicId: topic.marketId,
//           noBuyPrice: topic.noBuyPrice,
//         },
//       },
//     ];
//   }

//   // ───────────────────────── Helpers ─────────────────────────

//   /**
//    * Parse a price from string fields.
//    * Prefers `marketPrice` (last trade) over `buyPrice` (best ask).
//    * Returns 0 if both are empty/invalid.
//    */
//   private parsePrice(marketPrice?: string, buyPrice?: string): number {
//     if (marketPrice && marketPrice !== '0' && marketPrice !== '') {
//       const parsed = parseFloat(marketPrice);
//       if (!isNaN(parsed)) return parsed;
//     }
//     if (buyPrice && buyPrice !== '0' && buyPrice !== '') {
//       const parsed = parseFloat(buyPrice);
//       if (!isNaN(parsed)) return parsed;
//     }
//     return 0;
//   }

//   /**
//    * Clamp price to [0.0, 1.0].
//    */
//   private clampPrice(price: number): number {
//     if (!price || price < 0) return 0;
//     if (price > 1) return 1;
//     return price;
//   }

//   /**
//    * Health check — try to fetch one topic.
//    */
//   async healthCheck(): Promise<boolean> {
//     try {
//       const { data } = await this.http.get<OpinionApiResponse<any>>('/topic', {
//         params: { page: 1, limit: 1, status: 2, chainId: 56 },
//         timeout: 5_000,
//       });
//       return data?.errno === 0;
//     } catch {
//       return false;
//     }
//   }
// }
