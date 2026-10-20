/* Сетка настроек и покрытие бэклога барами скана. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandGrid, profileWithDefaults, MAX_GRID_COMBOS } from '../src/core/config.js';
import { scanCoverage } from '../src/core/scoring.js';
import type { Kline } from '../src/core/exchanges/types.js';

test('профиль без сетки разворачивается сам в себя', () => {
  const p = profileWithDefaults({ k1: 0.6, k2: 0.3 });
  const combos = expandGrid('default', p);
  assert.equal(combos.length, 1);
  assert.equal(combos[0].name, 'default');
  assert.equal(combos[0].params, p);
});
test('диапазоны дают полное произведение с уникальными именами', () => {
  const combos = expandGrid('g', profileWithDefaults({
    grid: { k1: [0.5, 0.7, 0.1], k2: [0.1, 0.3, 0.1], search_range: [40, 80, 20] },
  }));
  assert.equal(combos.length, 3 * 3 * 3);                       // границы диапазона входят
  assert.equal(new Set(combos.map(c => c.name)).size, combos.length);
  assert.ok(combos.some(c => c.params.k2 === 0.3), 'верхняя граница k2 потеряна на плавающей точке');
  const c = combos.find(c => c.name === 'g#k1=0.6,k2=0.2,r=60');
  assert.ok(c, 'имя комбинации нестабильно');
  assert.deepEqual([c.params.k1, c.params.k2, c.params.search_range], [0.6, 0.2, 60]);
  assert.equal(c.params.grid, null, 'комбинация не должна разворачиваться повторно');
});
test('невалидные комбинации отсеиваются, мусорный диапазон игнорируется', () => {
  /* гипотеза не принимает коэффициенты ≤ 0: из трёх значений k1 остаётся одно */
  const combos = expandGrid('x', profileWithDefaults({ grid: { k1: [-0.1, 0.1, 0.1], k2: [0.1, 0.2, 0.1] } }));
  assert.ok(combos.every(c => c.params.k1 > 0));
  assert.equal(combos.length, 2);
  /* нет ни одной валидной комбинации — молча пустой скан недопустим */
  assert.throws(() => expandGrid('x', profileWithDefaults({ grid: { k1: [0, 0, 0.1] } })), /валидной/);
  /* мусорный диапазон откатывается на значение профиля, а не роняет скан */
  const one = expandGrid('x', profileWithDefaults({ k1: 0.5, grid: { k1: [0.6, 0.4, 0.05] } }));
  assert.equal(one.length, 1);
  assert.equal(one[0].params.k1, 0.5);
});
test('потолок комбинаций не даёт подвесить скан', () => {
  assert.throws(
    () => expandGrid('big', profileWithDefaults({ grid: { k1: [0.4, 0.9, 0.001] } })),
    new RegExp(String(MAX_GRID_COMBOS)),
  );
});
/* Скоринг едет на барах скана, к бирже обращается только когда их не хватает.
   Ошибка здесь не падает, а тихо двигает автомат по неполным данным либо
   впустую жжёт бюджет запросов на бары, которые скан принесёт через секунды. */
test('покрытие бэклога барами скана', () => {
  const TF = 300_000;
  const bar = (t: number): Kline => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1, q: 1 });
  /* закрытые бары скана: открытия T−5×TF … T−TF, последний закрылся ровно в T */
  const T = 1_000_000 * TF;
  const kl = [5, 4, 3, 2, 1].map(i => bar(T - i * TF));

  assert.equal(scanCoverage(kl, T - 3 * TF, T, TF), 'covers', 'свежий скан должен покрывать');
  assert.equal(scanCoverage(kl, T - 5 * TF, T, TF), 'covers', 'ровно до первого бара — покрывает');

  /* бар только что закрылся, скан ещё не сходил: ждём его, а не тратим запрос */
  assert.equal(scanCoverage(kl, T - 2 * TF, T + TF, TF), 'lags-one-bar');
  /* отстал на два бара — скан монету больше не приносит, нужен запрос */
  assert.equal(scanCoverage(kl, T - 2 * TF, T + 2 * TF, TF), 'insufficient');

  /* не достаёт назад: бэклог начинается раньше первого бара скана */
  assert.equal(scanCoverage(kl, T - 6 * TF, T, TF), 'insufficient');
  assert.equal(scanCoverage(undefined, T, T, TF), 'insufficient', 'монеты нет в скане');
  assert.equal(scanCoverage([], T, T, TF), 'insufficient', 'пустой массив');
});
