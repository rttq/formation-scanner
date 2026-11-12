/* Binance USDT-M Futures adapter. Public endpoints, no keys required. */
import { qFetch } from '../queue.js';
import type { ExchangeAdapter, Instrument, Kline, Ticker, TF } from './types.js';

const BASE = 'https://fapi.binance.com';
const IV: Record<TF, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1H': '1h', '4H': '4h', '1D': '1d' };

/* 30 s cache: protects against repeated identical requests */
const cache = new Map<string, { ts: number; data: unknown }>();
const CACHE_MS = 30_000;
async function cFetch<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data as T;
  const data = await qFetch<T>(url);
  cache.set(url, { ts: Date.now(), data });
  return data;
}
export function clearMarketCache(): void { cache.clear(); }

interface RawExchangeInfo {
  symbols: Array<{
    symbol: string; quoteAsset: string; baseAsset: string;
    contractType?: string; status: string;
    filters?: Array<{ filterType: string; tickSize?: string }>;
  }>;
}
interface RawTicker { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string; }
type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

export const binanceFut: ExchangeAdapter = {
  id: 'binance-futures',
  exchange: 'binance',
  market: 'futures',

  async ping() {
    const t = performance.now();
    await qFetch(BASE + '/fapi/v1/time');
    return { ms: Math.round(performance.now() - t) };
  },

  async instruments() {
    const info = await cFetch<RawExchangeInfo>(BASE + '/fapi/v1/exchangeInfo');
    const m = new Map<string, Instrument>();
    for (const s of info.symbols) {
      if (s.quoteAsset !== 'USDT' || s.contractType !== 'PERPETUAL' || s.status !== 'TRADING') continue;
      const pf = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER');
      m.set(s.symbol, { symbol: s.symbol, tickSize: pf?.tickSize ? parseFloat(pf.tickSize) : null, base: s.baseAsset, quote: 'USDT' });
    }
    return m;
  },

  async tickers(): Promise<Ticker[]> {
    const a = await cFetch<RawTicker[]>(BASE + '/fapi/v1/ticker/24hr');
    return a.map(t => ({ symbol: t.symbol, price: +t.lastPrice, chg: +t.priceChangePercent, vol: +t.quoteVolume }));
  },

  async klines(sym: string, tf: TF, limit: number, startTime?: number): Promise<Kline[]> {
    const st = startTime ? `&startTime=${startTime}` : '';
    const raw = await cFetch<RawKline[]>(`${BASE}/fapi/v1/klines?symbol=${sym}&interval=${IV[tf]}&limit=${Math.min(limit, 1000)}${st}`);
    return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7] }));
  },

  tradeUrl(s: string) { return `https://www.binance.com/en/futures/${s}`; },
};
