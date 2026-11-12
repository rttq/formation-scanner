/* Parameter grid and backlog coverage by scan bars. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandGrid, profileWithDefaults, MAX_GRID_COMBOS } from '../src/core/config.js';
import { scanCoverage } from '../src/core/scoring.js';
import type { Kline } from '../src/core/exchanges/types.js';

test('a profile without a grid expands into itself', () => {
  const p = profileWithDefaults({ k1: 0.6, k2: 0.3 });
  const combos = expandGrid('default', p);
  assert.equal(combos.length, 1);
  assert.equal(combos[0].name, 'default');
  assert.equal(combos[0].params, p);
});
test('ranges give the full product with unique names', () => {
  const combos = expandGrid('g', profileWithDefaults({
    grid: { k1: [0.5, 0.7, 0.1], k2: [0.1, 0.3, 0.1], search_range: [40, 80, 20] },
  }));
  assert.equal(combos.length, 3 * 3 * 3);                       // range bounds are included
  assert.equal(new Set(combos.map(c => c.name)).size, combos.length);
  assert.ok(combos.some(c => c.params.k2 === 0.3), 'upper bound of k2 lost to floating point');
  const c = combos.find(c => c.name === 'g#k1=0.6,k2=0.2,r=60');
  assert.ok(c, 'combination name is unstable');
  assert.deepEqual([c.params.k1, c.params.k2, c.params.search_range], [0.6, 0.2, 60]);
  assert.equal(c.params.grid, null, 'a combination must not expand again');
});
test('invalid combinations are dropped, a garbage range is ignored', () => {
  /* the hypothesis rejects coefficients ≤ 0: of three k1 values one remains */
  const combos = expandGrid('x', profileWithDefaults({ grid: { k1: [-0.1, 0.1, 0.1], k2: [0.1, 0.2, 0.1] } }));
  assert.ok(combos.every(c => c.params.k1 > 0));
  assert.equal(combos.length, 2);
  /* not a single valid combination: a silently empty scan is not acceptable */
  assert.throws(() => expandGrid('x', profileWithDefaults({ grid: { k1: [0, 0, 0.1] } })), /no valid/);
  /* a garbage range falls back to the profile value instead of breaking the scan */
  const one = expandGrid('x', profileWithDefaults({ k1: 0.5, grid: { k1: [0.6, 0.4, 0.05] } }));
  assert.equal(one.length, 1);
  assert.equal(one[0].params.k1, 0.5);
});
test('the combination cap keeps the scan from hanging', () => {
  assert.throws(
    () => expandGrid('big', profileWithDefaults({ grid: { k1: [0.4, 0.9, 0.001] } })),
    new RegExp(String(MAX_GRID_COMBOS)),
  );
});
/* Scoring runs on scan bars and goes to the exchange only when they fall short.
   A bug here doesn't crash: it silently advances the machine on incomplete data or
   burns the request budget on bars the scan will bring within seconds. */
test('backlog coverage by scan bars', () => {
  const TF = 300_000;
  const bar = (t: number): Kline => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1, q: 1 });
  /* closed scan bars: opens at T−5×TF … T−TF, the last one closed exactly at T */
  const T = 1_000_000 * TF;
  const kl = [5, 4, 3, 2, 1].map(i => bar(T - i * TF));

  assert.equal(scanCoverage(kl, T - 3 * TF, T, TF), 'covers', 'a fresh scan must cover');
  assert.equal(scanCoverage(kl, T - 5 * TF, T, TF), 'covers', 'exactly up to the first bar: covers');

  /* a bar has just closed and the scan hasn't run yet: wait for it instead of spending a request */
  assert.equal(scanCoverage(kl, T - 2 * TF, T + TF, TF), 'lags-one-bar');
  /* two bars behind: the scan no longer brings this symbol, a request is needed */
  assert.equal(scanCoverage(kl, T - 2 * TF, T + 2 * TF, TF), 'insufficient');

  /* doesn't reach back: the backlog starts before the first scan bar */
  assert.equal(scanCoverage(kl, T - 6 * TF, T, TF), 'insufficient');
  assert.equal(scanCoverage(undefined, T, T, TF), 'insufficient', 'symbol is not in the scan');
  assert.equal(scanCoverage([], T, T, TF), 'insufficient', 'empty array');
});
