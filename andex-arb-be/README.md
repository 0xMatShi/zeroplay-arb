# Andex Arbitrage Engine

Cross-platform arbitrage detection engine for prediction markets. It continuously monitors multiple prediction market platforms, matches identical events across them, and finds price discrepancies that guarantee a profit regardless of the outcome.

## Table of Contents

- [How Prediction Market Arbitrage Works](#how-prediction-market-arbitrage-works)
- [Real-World Example](#real-world-example)
- [Step-by-Step Walkthrough](#step-by-step-walkthrough)
- [Architecture](#architecture)
- [Supported Platforms](#supported-platforms)
- [Setup](#setup)
- [Usage](#usage)
- [Configuration](#configuration)
- [API Reference](#api-reference)

---

## How Prediction Market Arbitrage Works

### The Basics

Prediction markets let you buy contracts on the outcome of real-world events. Each contract has two sides:

- **Yes** — pays $1.00 if the event happens
- **No** — pays $1.00 if the event does NOT happen

Prices range from $0.01 to $0.99 and represent the market's implied probability. On a single platform, Yes + No always equals ~$1.00 (the platform enforces this).

**But across different platforms, prices can differ.** If one platform thinks "Yes" is worth $0.40 and another thinks "No" is worth $0.50, you can buy both for $0.90 total — and one of them is *guaranteed* to pay out $1.00. That's a **$0.10 risk-free profit (11.1% return)**.

### The Formula

For a binary market (Yes/No), arbitrage exists when:

```
Best "Yes" price (across all platforms) + Best "No" price (across all platforms) < $1.00
```

The profit is:

```
Profit = $1.00 - (Yes price + No price)
Profit % = Profit / (Yes price + No price) * 100
```

### Why Do Price Differences Exist?

- **Different user bases** — Polymarket traders may be more crypto-savvy, Kalshi traders more finance-oriented
- **Different liquidity** — thin markets move on small orders
- **Information lag** — news hits one platform before another
- **Regional bias** — US-focused vs. global perspectives
- **Market microstructure** — different fee structures and order book dynamics

---

## Real-World Example

Here's a real opportunity the engine found:

### "Will the New York Knicks win the NBA Eastern Conference Finals?"

| Platform    | Outcome | Price  |
|-------------|---------|--------|
| Kalshi      | No      | $0.01  |
| Polymarket  | Yes     | $0.19  |

**What you do:**

1. Buy **"No"** on Kalshi for **$0.01**
2. Buy **"Yes"** on Polymarket for **$0.19**
3. Total cost: **$0.20**

**What happens next:**

- If the Knicks **WIN** the Eastern Conference Finals:
  - Your Polymarket "Yes" pays **$1.00**
  - Your Kalshi "No" expires worthless ($0.00)
  - **Net profit: $1.00 - $0.20 = $0.80 (400% return)**

- If the Knicks **DON'T WIN**:
  - Your Kalshi "No" pays **$1.00**
  - Your Polymarket "Yes" expires worthless ($0.00)
  - **Net profit: $1.00 - $0.20 = $0.80 (400% return)**

**You profit $0.80 no matter what happens.** That's the essence of arbitrage.

### Another Example (Smaller Spread)

**"Will the Colorado Avalanche win the 2026 NHL Stanley Cup?"**

| Platform    | Outcome | Price  |
|-------------|---------|--------|
| Kalshi      | No      | $0.02  |
| Polymarket  | Yes     | $0.009 |

- Total cost: $0.029
- Guaranteed payout: $1.00
- **Profit: $0.971 (3,348% return)**

> **Note:** Extremely high percentage returns usually happen on very low-priced markets (penny contracts). The dollar profit per contract may be small, but the *percentage* return is enormous. Always check absolute dollar amounts and available liquidity before trading.

---

## Step-by-Step Walkthrough

Here's exactly what the engine does every cycle:

### Step 1: Poll — Fetch Events

The engine hits each platform's API and downloads all active markets:

```
Polymarket API → 3,000 active markets
Kalshi API     → 33,000 active markets
```

Each market is normalized into a common format:
```
{
  title: "Will the Knicks win the NBA Eastern Conference Finals?",
  outcomes: [
    { name: "Yes", price: 0.19 },
    { name: "No",  price: 0.81 }
  ],
  platform: "polymarket",
  url: "https://polymarket.com/event/..."
}
```

### Step 2: Match — Find the Same Event on Different Platforms

The engine uses **text similarity** to find events that are asking the same question on different platforms.

For example, these two titles get matched:

| Polymarket | Kalshi |
|---|---|
| "Will the Colorado Avalanche win the 2026 NHL Stanley Cup?" | "Colorado Avalanche: Stanley Cup winner?" |

The matching algorithm:
1. Tokenizes titles into keywords (removes stop words like "the", "will", "a")
2. Builds an **inverted index** mapping keywords → events (for speed)
3. Finds event pairs from *different* platforms that share keywords
4. Computes text similarity (Jaccard + word order)
5. Creates a match if similarity > threshold (default 35%)

### Step 3: Scan — Detect Arbitrage

For each matched pair, the scanner compares prices:

```
Polymarket "Knicks Eastern Conference":  Yes=$0.19, No=$0.81
Kalshi "Knicks Eastern Conference":      Yes=$0.03, No=$0.97
```

The engine checks all combinations:
- Polymarket Yes ($0.19) + Kalshi No ($0.97) = $1.16 → no arb
- Kalshi Yes ($0.03) + Polymarket No ($0.81) = $0.84 → no arb
- **Kalshi No ($0.01*) + Polymarket Yes ($0.19) = $0.20 → ARB!** ← profit = $0.80

> \* Prices can differ from last_price vs. ask; the engine uses the best available price

When it finds a combination where the total cost < $1.00, it records an arbitrage opportunity.

### Step 4: Notify

New opportunities are:
- Saved to the database
- Pushed in real-time via WebSocket to all connected clients
- Available via REST API

### Step 5: Revalidate

Every 30 seconds, the engine re-checks all active opportunities:
- If prices changed and the arb still exists → update profit %
- If the arb disappeared → mark as expired
- If the event ended → mark as resolved

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Arbitrage Module                       │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │  Polymarket   │   │    Kalshi     │   │  Future...   │ │
│  │   Adapter     │   │   Adapter     │   │   Adapter    │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘ │
│         │                  │                   │         │
│         ▼                  ▼                   ▼         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Adapter Registry                       │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                │
│         ┌───────────────┼───────────────┐                │
│         ▼               ▼               ▼                │
│  ┌──────────┐   ┌──────────────┐  ┌───────────┐         │
│  │  Event    │   │  Matching    │  │  Scanner   │         │
│  │  Fetcher  │   │  Service     │  │  Service   │         │
│  └──────────┘   └──────────────┘  └───────────┘         │
│         │               │               │                │
│         ▼               ▼               ▼                │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                  PostgreSQL DB                      │ │
│  │  platforms | events | outcomes | matches | opps     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐                     │
│  │  Poll         │   │  Revalidation│                     │
│  │  Scheduler    │   │  Scheduler   │                     │
│  └──────────────┘   └──────────────┘                     │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐                     │
│  │  REST API     │   │  WebSocket   │                     │
│  │  Controller   │   │  Gateway     │                     │
│  └──────────────┘   └──────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### Adding a New Platform

1. Create a new adapter in `src/arbitrage/adapters/<platform>/`
2. Implement the `ISourceAdapter` interface
3. Register it in the `AdapterRegistry` via `onModuleInit()`
4. Add it to the `ArbitrageModule` providers

That's it — the engine will automatically include the new platform in the poll-match-scan cycle.

---

## Supported Platforms

| Platform | Type | Markets | API |
|----------|------|---------|-----|
| [Polymarket](https://polymarket.com) | Prediction Market (crypto) | ~3,000 active | Gamma API (public) |
| [Kalshi](https://kalshi.com) | Prediction Market (regulated US) | ~33,000 active | Trade API v2 (public) |

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- pnpm

### Installation

```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env
# Edit .env with your database credentials

# Run database migrations
pnpm migration:run

# Start the server
pnpm start:dev
```

### Environment Variables

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=andex_arb

# Engine tuning
ARB_MIN_PROFIT_PERCENTAGE=0.01        # Minimum profit % to report (0.01 = 1%)
MATCH_CONFIDENCE_THRESHOLD=0.35       # Text similarity threshold for matching
POLL_INTERVAL_MS=60000                # How often to fetch new events (ms)
REVALIDATION_INTERVAL_MS=30000        # How often to re-check opportunities (ms)
```

---

## Usage

### Start the Server

```bash
pnpm start:dev
```

### Interactive Listener (Test Script)

```bash
pnpm arb:listen
```

Keyboard commands in the listener:

| Key | Action |
|-----|--------|
| `p` | Trigger manual poll (fetch events) |
| `m` | Trigger manual match (match events across platforms) |
| `s` | Trigger manual scan (scan for arbitrage) |
| `a` | Run all three: poll → match → scan |
| `i` | Show matched events |
| `o` | Show current opportunities |
| `q` | Quit |

### Typical First Run

1. Start the server: `pnpm start:dev`
2. In another terminal: `pnpm arb:listen`
3. Press `a` to run the full pipeline
4. Wait ~30 seconds for poll to complete
5. See matched events and arbitrage opportunities

---

## Configuration

### Match Threshold

The `MATCH_CONFIDENCE_THRESHOLD` controls how similar two event titles need to be to be considered the same event. Lower = more matches (but more false positives).

| Value | Behavior |
|-------|----------|
| 0.80+ | Very strict — only near-identical titles |
| 0.50  | Moderate — good for well-named events |
| 0.35  | Loose — catches events with different wording |
| 0.20  | Very loose — many false positives |

### Minimum Profit

The `ARB_MIN_PROFIT_PERCENTAGE` controls the minimum profit to report. Set lower to see more (smaller) opportunities.

| Value | Meaning |
|-------|---------|
| 5.0   | Only report 5%+ profit opportunities |
| 1.0   | Report 1%+ opportunities |
| 0.01  | Report almost everything (good for testing) |

---

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/arbitrage/opportunities` | List active opportunities (paginated) |
| GET | `/arbitrage/opportunities/:id` | Get opportunity details |
| GET | `/arbitrage/stats` | Engine statistics |
| GET | `/arbitrage/matches` | List event matches across platforms |
| GET | `/arbitrage/platforms/stats` | Event counts per platform |
| POST | `/arbitrage/trigger/poll` | Manually trigger event fetch |
| POST | `/arbitrage/trigger/match` | Manually trigger event matching |
| POST | `/arbitrage/trigger/scan` | Manually trigger arb scan |

### WebSocket Events

Connect to namespace `/arbitrage`:

```javascript
const socket = io('http://localhost:3000/arbitrage');

socket.on('opportunity:new', (data) => { /* new arb found */ });
socket.on('opportunity:updated', (data) => { /* prices changed */ });
socket.on('opportunity:expired', (data) => { /* arb gone */ });
```

---

## Important Caveats

1. **This is a detection engine, not a trading bot.** It finds opportunities — execution is up to you.

2. **Prices move fast.** By the time you see an opportunity and place orders on two platforms, the prices may have changed. This is called "execution risk."

3. **Liquidity matters.** A 400% profit on a $0.01 contract means you can only deploy small amounts. Always check the order book depth.

4. **Fees eat profits.** Both platforms charge fees (trading fees, withdrawal fees, etc.). A 2% arb might be -1% after fees.

5. **Platform risk.** Each platform has its own rules, settlement mechanisms, and counterparty risk.

6. **False matches.** The text-matching algorithm isn't perfect. Two events with similar names might have different resolution criteria. Always verify manually before trading.

7. **Capital lockup.** Prediction markets can take weeks or months to resolve. Your capital is locked until settlement.
