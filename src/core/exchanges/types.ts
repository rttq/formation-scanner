/* Normalized market data types */

export interface Kline {
  t: number;  // bar open time, unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;  // volume in the base asset
  q: number;  // volume in the quote asset (USDT)
}

export interface Instrument {
  symbol: string;
  tickSize: number | null;
  base: string;
  quote: string;
}

export interface Ticker {
  symbol: string;
  price: number;
  chg: number;   // 24h change, %
  vol: number;   // 24h turnover, USDT
}

export type TF = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D';

export const TF_LIST: TF[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];

export const TF_MS: Record<TF, number> = {
  '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 1.8e6, '1H': 3.6e6, '4H': 1.44e7, '1D': 8.64e7,
};

export interface ExchangeAdapter {
  id: string;                       // 'binance-futures' etc.
  exchange: string;                 // 'binance' | 'bybit'
  market: string;                   // 'futures' | 'spot'
  ping(): Promise<{ ms: number }>;
  instruments(): Promise<Map<string, Instrument>>;
  tickers(): Promise<Ticker[]>;
  klines(symbol: string, tf: TF, limit: number, startTime?: number): Promise<Kline[]>;
  tradeUrl(symbol: string, base?: string, quote?: string): string;
}
