/* Hypothesis, part 2: scoring. A stage machine takes a pattern from detection to
   a final score of 0–4. It advances on closed bars (lo/hi = bar low/high)
   and on ticks (lo = hi = price) and ends when the score becomes final or the TTL expires.
   When the signal fires, which stages the pattern goes through and what the score means
   is decided by the user's hypothesis: this file only holds the engine contract and the
   engineering part (scan bar coverage). The engine doesn't call the stubs while there
   are no patterns. */

import type { Kline } from './exchanges/types.js';
import type { Levels } from './detector.js';

export type Dir = 'long' | 'short';
/* 'watch' is the initial stage, 'final' means the score is final; intermediate stages are set by the hypothesis */
export type ScoreStage = string;

export interface ScoreLevels extends Levels { A: number; B: number }

export interface ScoreState {
  stage: ScoreStage;
  score: number | null;     // 0..4, null until set
  signalAt: number | null;  // signal moment: the journal record starts here
  scoredAt: number | null;  // moment the score became final
}

export function freshScore(): ScoreState {
  return { stage: 'watch', score: null, signalAt: null, scoredAt: null };
}

const hidden = (): never => { throw new Error('hypothesis not plugged in: src/core/scoring.ts'); };

/* Advance over the price range [lo..hi] at moment t. Returns true if the
   stage or the score changed; sets signalAt when the signal fires. */
export function advance(_st: ScoreState, _dir: Dir, _lv: ScoreLevels, _lo: number, _hi: number, _t: number): boolean {
  return hidden();
}

/* Scoring TTL expired: the pattern's final score */
export function finalizeTtl(_st: ScoreState, _deadline: number): boolean {
  return hidden();
}

/* Price at which the signal is recorded */
export function signalPrice(_lv: ScoreLevels): number {
  return hidden();
}

/* Observation close price when the score becomes final; refPrice is the nearest known price */
export function exitPrice(_score: number, _lv: ScoreLevels, _refPrice: number): number {
  return hidden();
}

/* How well the last scan's bars cover a pattern's backlog.
   `covers`: the machine can advance on them directly, no network needed;
   `lags-one-bar`: a bar has just closed and the scan will bring it within seconds
   (the scan runs scan_delay_sec after the bar close): wait instead of spending
   a request and a budget slot on data that is about to arrive for free;
   `insufficient`: the scan is seriously behind or the symbol isn't in it (it dropped out
   of the universe, or there was downtime): without a request to the exchange the machine
   would run on incomplete data. */
export type ScanCoverage = 'covers' | 'lags-one-bar' | 'insufficient';

export function scanCoverage(kl: Kline[] | undefined, startTime: number, lastClosed: number, tfMs: number): ScanCoverage {
  if (!kl?.length || kl[0].t > startTime) return 'insufficient';   // doesn't reach back to the backlog start
  const end = kl[kl.length - 1].t + tfMs;                          // close of the last scan bar
  if (end >= lastClosed) return 'covers';
  return end + tfMs >= lastClosed ? 'lags-one-bar' : 'insufficient';
}
