/**
 * Kalshi API response types.
 * Based on: https://docs.kalshi.com/api-reference
 * Base URL: https://api.elections.kalshi.com/trade-api/v2
 */

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive: boolean;
  collateral_return_type?: string;
  strike_date?: string;
  strike_period?: string;
  available_on_brokers?: boolean;
  product_metadata?: Record<string, any>;
  markets?: KalshiMarket[];
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: 'binary';
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;

  // Timestamps
  created_time: string;
  updated_time?: string;
  open_time?: string;
  close_time: string;
  expiration_time: string;
  latest_expiration_time?: string;
  expected_expiration_time?: string;

  // Status
  status: 'initialized' | 'unopened' | 'open' | 'paused' | 'closed' | 'settled' | 'active';
  result?: 'yes' | 'no' | 'void';

  // Prices in cents (0-99)
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_price: number;
  previous_yes_bid: number;
  previous_yes_ask: number;

  // Prices as dollar strings "0.5600"
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  previous_yes_bid_dollars?: string;
  previous_yes_ask_dollars?: string;

  // Volume
  volume: number;
  volume_fp?: string;
  volume_24h: number;
  volume_24h_fp?: string;

  // Other
  open_interest?: number;
  open_interest_fp?: string;
  liquidity?: number;
  liquidity_dollars?: string;
  notional_value?: number;
  notional_value_dollars?: string;
  can_close_early?: boolean;
  settlement_timer_seconds?: number;
  tick_size?: number;
  rules_primary?: string;
  rules_secondary?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  functional_strike?: string;
}

export interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor: string;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

/**
 * Kalshi orderbook response.
 * GET /markets/{ticker}/orderbook
 *
 * yes/no arrays: [[price_in_cents, quantity], ...]
 * yes array = bids for Yes (i.e. people paying X cents to get Yes)
 * no array  = bids for No  (i.e. people paying X cents to get No)
 */
export interface KalshiOrderBookResponse {
  orderbook: {
    yes: [number, number][];
    no: [number, number][];
  };
}
