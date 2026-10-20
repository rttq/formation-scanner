/* Тесты функций наблюдения: экскурсии MFE/MAE */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateExcursions } from '../src/core/trade.js';

test('updateExcursions: MFE/MAE только растут', () => {
  let e = updateExcursions('long', 100, 99, 103, 0, 0);
  assert.equal(e.mfePct, 3); assert.equal(e.maePct, 1);
  e = updateExcursions('long', 100, 99.5, 101, e.mfePct, e.maePct);
  assert.equal(e.mfePct, 3); assert.equal(e.maePct, 1);   // не уменьшились
});

test('updateExcursions (short): благоприятно вниз, неблагоприятно вверх', () => {
  const e = updateExcursions('short', 200, 190, 204, 0, 0);
  assert.equal(e.mfePct, 5); assert.equal(e.maePct, 2);
});
