/* Hypothesis, part 1: the pattern detector.
   The trading hypothesis is up to the user: this file only holds the contract
   the engine relies on. From closed bars the detector finds anchor points A, B, C
   and computes level prices from the profile coefficients k1–k3.
   Indexing: bar[0] = current = kl[n-1]; a point's index is how many bars back it is.
   The detector must read the array from the end: one bar download serves the whole grid. */
import type { Kline } from './exchanges/types.js';

export interface PatternPoint {
  p: number;  // price
  i: number;  // bar index (0 = current)
  t: number;  // bar open time, unix ms
}

export interface Coefs { k1: number; k2: number; k3: number }
export interface Levels { k1: number; k2: number; k3: number }   // level prices

export interface Pattern {
  dir: 'long' | 'short';
  A: PatternPoint;
  B: PatternPoint;
  C: PatternPoint;
  levels: Levels;
}

/* The stub finds no patterns: the engine, journal and UI work, but no records appear. */
export function detectPattern(_kl: Kline[], _R: number, _k: Coefs): Pattern | null {
  return null;
}

/* Level prices from points A, B and the coefficients. The engine doesn't call it while there are no patterns. */
export function levelPrices(_dir: 'long' | 'short', _A: number, _B: number, _k: Coefs): Levels {
  throw new Error('hypothesis not plugged in: src/core/detector.ts');
}

/* Allowed coefficients. The grid skips combinations the hypothesis rejects. */
export function validCoefs(k: Coefs): boolean {
  return [k.k1, k.k2, k.k3].every(x => Number.isFinite(x) && x > 0);
}
