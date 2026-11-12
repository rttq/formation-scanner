/* Snapshot builder: assembles the data container and gzips it.
   Snapshots are built twice: at the signal and when the score becomes final. */
import { gzipSync, gunzipSync } from 'node:zlib';
import type { ExchangeAdapter, Instrument, Kline, Ticker, TF } from './exchanges/types.js';
import { TF_MS } from './exchanges/types.js';
import type { ProfileParams, SnapshotTfCfg } from './config.js';
import { SNAPSHOT_SCHEMA_VERSION } from './config.js';
import type { Levels } from './detector.js';

/* light pattern description: only point prices/times (no bar indexes) */
export interface PatternInfo {
  tf: TF; dir: 'long' | 'short';
  A: { p: number; t: number }; B: { p: number; t: number }; C: { p: number; t: number };
  levels: Levels;
}

export interface ScoredInfo { score: number; scored_at: number; signal_at: number | null }

export interface SnapshotBody {
  schema_version: number;
  captured_at: number;
  kind: 'signal' | 'scored';
  instrument: { exchange: string; market: string; symbol: string; tick_size: number | null };
  ticker24h: { price: number; chg_pct: number; vol_usdt: number } | null;
  pattern: {
    tf: TF; dir: 'long' | 'short'; search_range: number; k1: number; k2: number; k3: number;
    A: { price: number; ts: number }; B: { price: number; ts: number }; C: { price: number; ts: number };
    levels: Levels;
  };
  entry: { price: number; ts: number; side: 'long' | 'short' };
  /* scoring result: only in a kind='scored' snapshot */
  scored?: ScoredInfo;
  scan_profile: { name: string; params: ProfileParams };
  snapshot_config: SnapshotTfCfg[];
  klines: Partial<Record<TF, Array<Kline & { forming?: boolean }>>>;
}

export async function buildSnapshot(args: {
  adapter: ExchangeAdapter;
  instrument: Instrument;
  ticker: Ticker | null;
  profileName: string;
  profile: ProfileParams;
  pattern: PatternInfo;
  entry: { price: number; ts: number; side: 'long' | 'short' };
  cfg: SnapshotTfCfg[];
  kind: 'signal' | 'scored';
  scored?: ScoredInfo;
}): Promise<{ body: SnapshotBody; gz: Buffer }> {
  const { adapter, instrument, ticker, pattern, entry, cfg } = args;
  const now = Date.now();

  /* multi-TF bars: what is visible at build time; the last bar may still be forming */
  const klines: SnapshotBody['klines'] = {};
  await Promise.all(cfg.map(async ({ tf, bars }) => {
    try {
      const kl = await adapter.klines(instrument.symbol, tf, bars);
      klines[tf] = kl.map((k, i) =>
        i === kl.length - 1 && k.t + TF_MS[tf] > now ? { ...k, forming: true } : k
      );
    } catch { /* an unavailable TF must not break the record: its block is just missing */ }
  }));

  const body: SnapshotBody = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    captured_at: now,
    kind: args.kind,
    instrument: {
      exchange: adapter.exchange, market: adapter.market,
      symbol: instrument.symbol, tick_size: instrument.tickSize,
    },
    ticker24h: ticker ? { price: ticker.price, chg_pct: ticker.chg, vol_usdt: ticker.vol } : null,
    pattern: {
      tf: pattern.tf, dir: pattern.dir, search_range: args.profile.search_range,
      k1: args.profile.k1, k2: args.profile.k2, k3: args.profile.k3,
      A: { price: pattern.A.p, ts: pattern.A.t },
      B: { price: pattern.B.p, ts: pattern.B.t },
      C: { price: pattern.C.p, ts: pattern.C.t },
      levels: pattern.levels,
    },
    entry,
    ...(args.scored ? { scored: args.scored } : {}),
    scan_profile: { name: args.profileName, params: args.profile },
    snapshot_config: cfg,
    klines,
  };
  return { body, gz: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')) };
}

export function decodeSnapshot(gz: Buffer): SnapshotBody {
  return JSON.parse(gunzipSync(gz).toString('utf8')) as SnapshotBody;
}

/* ── after-signal add-on ─────────────────────────────────────── */
/* pattern-TF bars strictly from the signal bar to the bar where the score became final, no tail */
export interface AfterBody {
  schema_version: number;
  written_at: number;
  tf: TF;
  klines: Kline[];
}

export function encodeGzJson(obj: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
}
export function decodeGzJson<T>(gz: Buffer): T {
  return JSON.parse(gunzipSync(gz).toString('utf8')) as T;
}
