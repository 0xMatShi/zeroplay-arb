/**
 * Test script: find the correct way to fetch all Polymarket sports events.
 * Run: npx ts-node scripts/test-pm-sports-fetch.ts
 */

import axios from 'axios';

const GAMMA_API = 'https://gamma-api.polymarket.com';

const SPORT_TAGS = new Set([
  'basketball', 'tennis', 'hockey', 'soccer', 'counter-strike-2',
  'ufc', 'zuffa', 'dota-2', 'call-of-duty', 'mlb', 'wbc', 'baseball',
  'league-of-legends', 'valorant',
]);

function matchesSport(ev: any): boolean {
  const tags: Array<{ slug: string }> = ev.tags ?? [];
  return tags.some(t => SPORT_TAGS.has(t.slug));
}

async function fetchAndAnalyze(label: string, params: Record<string, unknown>): Promise<void> {
  let offset = 0;
  let totalFetched = 0;
  let totalMatched = 0;
  let pages = 0;

  while (true) {
    const { data } = await axios.get(`${GAMMA_API}/events`, {
      params: { ...params, limit: 100, offset },
      timeout: 30_000,
    });

    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) break;

    pages++;
    totalFetched += batch.length;

    const matched = batch.filter((ev: any) => ev.seriesSlug && matchesSport(ev));
    totalMatched += matched.length;

    if (pages <= 3 || matched.length > 0) {
      console.log(`  page ${pages} (offset=${offset}): fetched=${batch.length}, sport+seriesSlug=${matched.length}`);
      if (matched.length > 0 && pages <= 5) {
        for (const ev of matched.slice(0, 3)) {
          const tags = (ev.tags ?? []).map((t: any) => t.slug).join(', ');
          console.log(`    → "${ev.title}" seriesSlug=${ev.seriesSlug} restricted=${ev.restricted} tags=[${tags}]`);
        }
      }
    }

    if (batch.length < 100) break;
    offset += 100;
    if (pages >= 20) { console.log('  (stopping at 20 pages)'); break; }
  }

  console.log(`  [${label}] RESULT: ${totalFetched} fetched in ${pages} pages, ${totalMatched} matched sport+seriesSlug\n`);
}

async function main(): Promise<void> {
  console.log('=== Polymarket sports events fetch test ===\n');

  console.log('1. tag_slug=sports, order=start_date asc (upcoming games first):');
  await fetchAndAnalyze('tag_slug+start_date', {
    active: true, closed: false, tag_slug: 'sports',
    order: 'start_date', ascending: true,
  });

  console.log('2. tag_slug=sports, без ordering (дефолт):');
  await fetchAndAnalyze('tag_slug no order', {
    active: true, closed: false, tag_slug: 'sports',
  });

  console.log('3. tag_id=1, order=start_date asc:');
  await fetchAndAnalyze('tag_id=1+start_date', {
    active: true, closed: false, tag_id: 1,
    order: 'start_date', ascending: true,
  });

  console.log('4. Без фильтра по тегу, order=start_date asc (все активные):');
  await fetchAndAnalyze('no tag+start_date', {
    active: true, closed: false,
    order: 'start_date', ascending: true,
  });

  // Прямая проверка конкретного матча из примера пользователя
  console.log('5. Прямой запрос известного матча по slug:');
  const { data } = await axios.get(`${GAMMA_API}/events`, {
    params: { slug: 'mlb-tor-det-2026-05-16' },
    timeout: 15_000,
  });
  const ev = Array.isArray(data) ? data[0] : null;
  if (ev) {
    console.log(`  Найден: "${ev.title}" active=${ev.active} restricted=${ev.restricted} seriesSlug=${ev.seriesSlug}`);
    console.log(`  Tags: ${(ev.tags ?? []).map((t: any) => `${t.slug}(id=${t.id})`).join(', ')}`);
  } else {
    console.log('  Не найден!');
  }
}

main().catch(console.error);
