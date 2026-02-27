/**
 * Arb Listener — test script that connects to the engine and shows everything in real-time.
 *
 * What it does:
 *   1. Connects to WebSocket at /arbitrage namespace
 *   2. Listens for new / updated / expired opportunities
 *   3. Polls REST API every 30s for stats
 *   4. Pretty-prints everything to the console
 *
 * Usage:
 *   npx ts-node scripts/listen-arb.ts
 *   # or with custom server:
 *   SERVER_URL=http://localhost:3000 npx ts-node scripts/listen-arb.ts
 */

import { io, Socket } from 'socket.io-client';

// ─── Config ────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const STATS_POLL_INTERVAL = 30_000; // 30s

// ─── Colors (ANSI escape codes, no dependencies) ──────────────────────────

const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

function timestamp(): string {
  return `${c.dim}[${new Date().toLocaleTimeString()}]${c.reset}`;
}

// ─── Pretty printers ──────────────────────────────────────────────────────

function printBanner() {
  console.log(`
${c.cyan}${c.bright}╔══════════════════════════════════════════════════╗
║           ANDEX ARB ENGINE — LISTENER            ║
╚══════════════════════════════════════════════════╝${c.reset}

  Server:    ${c.white}${SERVER_URL}${c.reset}
  WebSocket: ${c.white}${SERVER_URL}/arbitrage${c.reset}
  REST API:  ${c.white}${SERVER_URL}/arbitrage/opportunities${c.reset}
`);
}

function printNewOpportunity(data: any) {
  const profit = Number(data.profitPercentage).toFixed(2);
  const cost = Number(data.totalCost).toFixed(4);

  console.log(`
${timestamp()} ${c.bgGreen}${c.bright} NEW ARB OPPORTUNITY ${c.reset}
  ${c.bright}${data.matchTitle || 'Unknown event'}${c.reset}
  ${c.green}${c.bright}Profit: ${profit}%${c.reset}  |  Cost: $${cost}  |  Type: ${data.type}
  ${c.dim}ID: ${data.id}${c.reset}`);

  if (data.legs && data.legs.length > 0) {
    console.log(`  ${c.bright}Legs:${c.reset}`);
    for (const leg of data.legs) {
      const price = Number(leg.price).toFixed(4);
      console.log(
        `    ${c.cyan}${leg.platformName}${c.reset} → Buy ${c.yellow}${leg.outcomeName}${c.reset} @ ${c.bright}$${price}${c.reset}` +
          (leg.url ? `  ${c.dim}${leg.url}${c.reset}` : ''),
      );
    }
  }

  console.log(`  ${c.dim}Found at: ${data.foundAt}${c.reset}`);
  console.log('');
}

function printUpdatedOpportunity(data: any) {
  const profit = Number(data.profitPercentage).toFixed(2);
  const cost = Number(data.totalCost).toFixed(4);

  console.log(
    `${timestamp()} ${c.bgYellow}${c.bright} ARB UPDATED ${c.reset}  ${c.dim}${data.id}${c.reset}  Profit: ${c.yellow}${profit}%${c.reset}  Cost: $${cost}`,
  );
}

function printExpiredOpportunity(data: any) {
  console.log(
    `${timestamp()} ${c.bgRed}${c.bright} ARB EXPIRED ${c.reset}  ${c.dim}${data.id}${c.reset}  ${c.red}Opportunity no longer available${c.reset}`,
  );
}

function printStats(stats: any) {
  console.log(
    `${timestamp()} ${c.magenta}STATS${c.reset}  Active: ${c.bright}${stats.activeCount}${c.reset}  Avg profit: ${c.green}${Number(stats.avgProfit).toFixed(2)}%${c.reset}  Max profit: ${c.green}${Number(stats.maxProfit).toFixed(2)}%${c.reset}  Total found: ${stats.totalFound}  WS clients: ${stats.connectedClients}`,
  );
}

function printOpportunities(data: any) {
  if (!data.items || data.items.length === 0) {
    console.log(`${timestamp()} ${c.dim}No active opportunities at the moment${c.reset}`);
    return;
  }

  console.log(
    `\n${timestamp()} ${c.cyan}${c.bright}Active opportunities (${data.total}):${c.reset}`,
  );

  for (const opp of data.items) {
    const profit = Number(opp.profitPercentage).toFixed(2);
    const cost = Number(opp.totalCost).toFixed(4);
    const platforms = (opp.legs || [])
      .map((l: any) => `${l.platformName}:${l.outcomeName}@$${Number(l.price).toFixed(3)}`)
      .join(' vs ');

    console.log(
      `  ${c.green}+${profit}%${c.reset}  $${cost}  ${c.bright}${opp.matchTitle || '?'}${c.reset}  [${platforms}]`,
    );
  }
  console.log('');
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function fetchJson(path: string, method = 'GET'): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, { method });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json() as Promise<any>;
}

async function pollStats() {
  try {
    const stats = await fetchJson('/arbitrage/stats');
    printStats(stats);
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Failed to fetch stats: ${err.message}${c.reset}`);
  }
}

async function pollPlatformStats() {
  try {
    const platforms = await fetchJson('/arbitrage/platforms/stats') as any[];
    const parts = platforms.map(
      (p: any) => `${c.cyan}${p.name}${c.reset}: ${c.bright}${p.eventCount}${c.reset} events`,
    );
    console.log(`${timestamp()} ${c.magenta}PLATFORMS${c.reset}  ${parts.join('  |  ')}`);
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Failed to fetch platform stats: ${err.message}${c.reset}`);
  }
}

async function pollMatches() {
  try {
    const matches = await fetchJson('/arbitrage/matches') as any[];
    if (matches.length === 0) {
      console.log(`${timestamp()} ${c.dim}No event matches between platforms yet${c.reset}`);
      return;
    }

    console.log(
      `\n${timestamp()} ${c.cyan}${c.bright}Matched events across platforms (${matches.length}):${c.reset}`,
    );

    for (const m of matches.slice(0, 15)) {
      const conf = (Number(m.confidence) * 100).toFixed(0);
      const status = m.status === 'confirmed'
        ? `${c.green}confirmed${c.reset}`
        : m.status === 'pending'
          ? `${c.yellow}pending${c.reset}`
          : `${c.red}${m.status}${c.reset}`;

      const platforms = (m.events || [])
        .map((e: any) => {
          const prices = (e.outcomes || [])
            .map((o: any) => `${o.name}@${Number(o.price).toFixed(2)}`)
            .join('/');
          return `${c.cyan}${e.platformSlug}${c.reset}(${prices})`;
        })
        .join(' vs ');

      console.log(
        `  ${status} ${c.bright}${conf}%${c.reset} match  "${m.title}"  [${platforms}]`,
      );
    }

    if (matches.length > 15) {
      console.log(`  ${c.dim}...and ${matches.length - 15} more${c.reset}`);
    }
    console.log('');
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Failed to fetch matches: ${err.message}${c.reset}`);
  }
}

async function pollOpportunities() {
  try {
    const data = await fetchJson('/arbitrage/opportunities?limit=10');
    printOpportunities(data);
  } catch (err: any) {
    console.log(
      `${timestamp()} ${c.red}Failed to fetch opportunities: ${err.message}${c.reset}`,
    );
  }
}

async function triggerPoll() {
  try {
    console.log(`${timestamp()} ${c.yellow}Triggering manual poll cycle...${c.reset}`);
    const data = await fetchJson('/arbitrage/trigger/poll', 'POST');
    console.log(`${timestamp()} ${c.green}Poll done:${c.reset}`, JSON.stringify(data.eventsFetched));
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Trigger poll failed: ${err.message}${c.reset}`);
  }
}

async function triggerMatch() {
  try {
    console.log(`${timestamp()} ${c.yellow}Triggering manual match...${c.reset}`);
    const data = await fetchJson('/arbitrage/trigger/match', 'POST');
    console.log(`${timestamp()} ${c.green}Match done:${c.reset} ${data.newMatches} new matches`);
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Trigger match failed: ${err.message}${c.reset}`);
  }
}

async function triggerScan() {
  try {
    console.log(`${timestamp()} ${c.yellow}Triggering manual scan...${c.reset}`);
    const data = await fetchJson('/arbitrage/trigger/scan', 'POST');
    console.log(
      `${timestamp()} ${c.green}Scan done:${c.reset} ${data.newOpportunities} new opportunities`,
    );
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Trigger scan failed: ${err.message}${c.reset}`);
  }
}

async function triggerVerify() {
  try {
    console.log(`${timestamp()} ${c.yellow}Triggering AI verification of pending matches...${c.reset}`);
    const data = await fetchJson('/arbitrage/trigger/verify', 'POST');
    console.log(
      `${timestamp()} ${c.green}AI verify done:${c.reset} ` +
        `${c.bright}${data.processed}${c.reset} processed — ` +
        `${c.green}${data.confirmed} confirmed${c.reset}, ` +
        `${c.red}${data.rejected} rejected${c.reset}, ` +
        `${c.yellow}${data.uncertain} uncertain${c.reset}`,
    );
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Trigger verify failed: ${err.message}${c.reset}`);
  }
}

async function pollVerificationStats() {
  try {
    const data = await fetchJson('/arbitrage/verification/stats');
    console.log(
      `${timestamp()} ${c.magenta}AI STATS${c.reset}  ` +
        `Pending: ${c.yellow}${data.totalPending}${c.reset}  ` +
        `Confirmed: ${c.green}${data.totalConfirmed}${c.reset}  ` +
        `Rejected: ${c.red}${data.totalRejected}${c.reset}  ` +
        `AI-verified: ${c.cyan}${data.aiVerified}${c.reset}`,
    );
  } catch (err: any) {
    console.log(`${timestamp()} ${c.red}Failed to fetch verification stats: ${err.message}${c.reset}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  // 1. Connect WebSocket
  console.log(`${timestamp()} Connecting to WebSocket...`);

  const socket: Socket = io(`${SERVER_URL}/arbitrage`, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    console.log(
      `${timestamp()} ${c.green}${c.bright}WebSocket connected!${c.reset} (id: ${socket.id})`,
    );
  });

  socket.on('disconnect', (reason) => {
    console.log(`${timestamp()} ${c.red}WebSocket disconnected: ${reason}${c.reset}`);
  });

  socket.on('connect_error', (err) => {
    console.log(`${timestamp()} ${c.red}WebSocket error: ${err.message}${c.reset}`);
  });

  // 2. Listen for arb events
  socket.on('opportunity:new', (data) => printNewOpportunity(data));
  socket.on('opportunity:updated', (data) => printUpdatedOpportunity(data));
  socket.on('opportunity:expired', (data) => printExpiredOpportunity(data));

  // 3. Wait for connection, then do initial check
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(
        `${timestamp()} ${c.yellow}WebSocket not connected yet, continuing anyway...${c.reset}`,
      );
      resolve();
    }, 5000);

    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // 4. Initial REST check
  console.log(`\n${timestamp()} ${c.cyan}Checking current state via REST API...${c.reset}\n`);
  await pollPlatformStats();
  await pollStats();
  await pollMatches();
  await pollOpportunities();

  // 5. Poll stats periodically
  setInterval(async () => {
    await pollPlatformStats();
    await pollStats();
  }, STATS_POLL_INTERVAL);

  // 6. Handle keyboard input for manual triggers
  console.log(`${c.bright}Keyboard commands:${c.reset}`);
  console.log(`  ${c.cyan}p${c.reset} — trigger manual poll (fetch events from all platforms)`);
  console.log(`  ${c.cyan}m${c.reset} — trigger manual match (match events across platforms)`);
  console.log(`  ${c.cyan}v${c.reset} — trigger AI verification (verify pending matches with GPT)`);
  console.log(`  ${c.cyan}s${c.reset} — trigger manual scan (scan for arbitrage)`);
  console.log(`  ${c.cyan}a${c.reset} — run full pipeline: poll → match → AI verify → scan`);
  console.log(`  ${c.cyan}i${c.reset} — show matched events (cross-platform matches)`);
  console.log(`  ${c.cyan}o${c.reset} — show current opportunities`);
  console.log(`  ${c.cyan}q${c.reset} — quit`);
  console.log(`\n${c.dim}Listening for real-time arb events via WebSocket...${c.reset}\n`);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', async (key: string) => {
      switch (key) {
        case 'p':
          await triggerPoll();
          await pollPlatformStats();
          console.log(`${timestamp()} ${c.green}Poll finished ✓${c.reset}\n`);
          break;
        case 'm':
          await triggerMatch();
          await pollMatches();
          console.log(`${timestamp()} ${c.green}Match finished ✓${c.reset}\n`);
          break;
        case 's':
          await triggerScan();
          await pollOpportunities();
          console.log(`${timestamp()} ${c.green}Scan finished ✓${c.reset}\n`);
          break;
        case 'v':
          await triggerVerify();
          await pollVerificationStats();
          console.log(`${timestamp()} ${c.green}Verification finished ✓${c.reset}\n`);
          break;
        case 'a': {
          console.log(`\n${timestamp()} ${c.cyan}${c.bright}═══ Running full pipeline: poll → match → AI verify → scan ═══${c.reset}\n`);

          console.log(`${timestamp()} ${c.yellow}[1/4] POLL — fetching events from all platforms...${c.reset}`);
          await triggerPoll();
          await pollPlatformStats();
          console.log(`${timestamp()} ${c.green}[1/4] POLL — done ✓${c.reset}\n`);

          console.log(`${timestamp()} ${c.yellow}[2/4] MATCH — matching events across platforms...${c.reset}`);
          await triggerMatch();
          console.log(`${timestamp()} ${c.green}[2/4] MATCH — done ✓${c.reset}\n`);

          console.log(`${timestamp()} ${c.yellow}[3/4] AI VERIFY — verifying matches with GPT...${c.reset}`);
          await triggerVerify();
          await pollVerificationStats();
          console.log(`${timestamp()} ${c.green}[3/4] AI VERIFY — done ✓${c.reset}\n`);

          console.log(`${timestamp()} ${c.yellow}[4/4] SCAN — scanning confirmed matches for arbitrage...${c.reset}`);
          await triggerScan();
          console.log(`${timestamp()} ${c.green}[4/4] SCAN — done ✓${c.reset}\n`);

          console.log(`${timestamp()} ${c.cyan}═══ Pipeline complete, fetching results... ═══${c.reset}\n`);
          await pollMatches();
          await pollOpportunities();
          console.log(`${timestamp()} ${c.green}${c.bright}═══ All done! ═══${c.reset}\n`);
          break;
        }
        case 'i':
          await pollMatches();
          break;
        case 'o':
          await pollOpportunities();
          break;
        case 'q':
        case '\u0003': // Ctrl+C
          console.log(`\n${timestamp()} ${c.yellow}Shutting down...${c.reset}`);
          socket.disconnect();
          process.exit(0);
          break;
      }
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
