/* Settings types and defaults: scan profiles, snapshot, update intervals.
   An observation record is created on a signal and closes when its score becomes final. */
import type { TF } from './exchanges/types.js';
import { validCoefs } from './detector.js';

/* ── Scan profile ────────────────────────────────────────────── */
export interface ProfileParams {
  exchange: 'binance';
  market: 'futures';
  tf: TF;                 // pattern timeframe the detector runs on
  search_range: number;   // search window, bars
  k1: number;             // level coefficients: their meaning is set by the hypothesis (src/core/detector.ts)
  k2: number;
  k3: number;
  score_ttl_bars: number; // scoring TTL: bars of observation before the final score
  top_n: number;          // scan only the N most liquid symbols (0 = all)
  min_vol24: number;      // min 24h turnover in USDT (0 = off)
  grid: GridSpec | null;  // ranges for sweeping combinations (null = regular profile)
}

/* Demo values: the hypothesis and its parameters are up to the user */
export const PROFILE_DEFAULTS: ProfileParams = {
  exchange: 'binance',
  market: 'futures',
  tf: '15m',
  search_range: 60,
  k1: 0.6,
  k2: 0.3,
  k3: 0.1,
  score_ttl_bars: 20,
  top_n: 150,
  min_vol24: 0,
  grid: null,
};

export function profileWithDefaults(p: Partial<ProfileParams> | null | undefined): ProfileParams {
  /* take known keys only: extra fields are dropped */
  const out = { ...PROFILE_DEFAULTS };
  if (p) for (const k of Object.keys(PROFILE_DEFAULTS) as Array<keyof ProfileParams>) {
    if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  }
  return out;
}

/* ── Parameter grid ──────────────────────────────────────────
   A profile with ranges expands into a set of combinations. One bar download
   serves the whole grid: the detector reads the array from the end and takes only
   the last search_range bars, so extra bars at the start don't change the result.
   The combination name is part of formation.id, so combination records never merge. */
export type GridRange = [from: number, to: number, step: number];
export interface GridSpec { k1?: GridRange; k2?: GridRange; search_range?: GridRange }
export interface Combo { name: string; params: ProfileParams }

export const MAX_GRID_COMBOS = 500;

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/* values of a [from, to, step] range; missing or invalid → the single profile value */
function gridValues(r: GridRange | undefined, def: number): number[] {
  if (!Array.isArray(r)) return [def];
  const [from, to, step] = r;
  if (![from, to, step].every(Number.isFinite) || !(step > 0) || to < from) return [def];
  const out: number[] = [];
  /* micro-step tolerance: otherwise 0.1 + 0.1×2 = 0.30000000000000004 loses the last value */
  for (let v = from; v <= to + step * 1e-6; v += step) out.push(r3(v));
  return out;
}

export function expandGrid(name: string, p: ProfileParams): Combo[] {
  if (!p.grid) return [{ name, params: p }];
  const as = gridValues(p.grid.k1, p.k1);
  const bs = gridValues(p.grid.k2, p.k2);
  const rs = gridValues(p.grid.search_range, p.search_range).map(v => Math.max(3, Math.round(v)));

  const total = as.length * bs.length * rs.length;
  if (total > MAX_GRID_COMBOS) throw new Error(`grid "${name}": ${total} combinations exceed the cap of ${MAX_GRID_COMBOS}`);

  const out: Combo[] = [];
  for (const k1 of as) for (const k2 of bs) for (const search_range of rs) {
    if (!validCoefs({ k1, k2, k3: p.k3 })) continue;   // a combination the hypothesis rejects is skipped
    /* grid: null on a combination: it is already expanded and is not expanded again */
    out.push({ name: `${name}#k1=${k1},k2=${k2},r=${search_range}`, params: { ...p, k1, k2, search_range, grid: null } });
  }
  if (!out.length) throw new Error(`grid "${name}": no valid combinations`);
  return out;
}

/* base profile name from a combination name (and from formation.id) */
export const baseProfileName = (name: string): string => name.split('#')[0];

/* a grid combination rather than a regular profile: its signals go as a row
   into data/grid.db, with no snapshot and no journal entry */
export const isCombo = (name: string): boolean => name.includes('#');

/* ── Snapshot configuration ──────────────────────────────────── */
export interface SnapshotTfCfg { tf: TF; bars: number }

export const SNAPSHOT_DEFAULTS: SnapshotTfCfg[] = [
  { tf: '5m', bars: 600 },   // ≈ 50 hours
  { tf: '15m', bars: 400 },  // ≈ 4 days
  { tf: '1H', bars: 480 },   // = 20 days
  { tf: '4H', bars: 180 },   // = 30 days
  { tf: '1D', bars: 90 },    // = 3 months
];

/* ── Update intervals ────────────────────────────────────────── */
export interface Intensity {
  track_sec: number;       // tracking loop for observations
  universe_min: number;    // tickers/universe loop
  scan_delay_sec: number;  // delay after the bar close before the scan
}

export const INTENSITY_DEFAULTS: Intensity = {
  track_sec: 30,
  universe_min: 5,
  scan_delay_sec: 5,
};

export const SNAPSHOT_SCHEMA_VERSION = 1;
