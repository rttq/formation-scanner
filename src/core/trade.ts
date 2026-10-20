/* Чистые функции наблюдения: экскурсии MFE/MAE от цены сигнала. Тестируемы без сети. */

export type Dir = 'long' | 'short';

/* Обновление MFE/MAE по диапазону [lo..hi]; значения в % (оба неотрицательные) */
export function updateExcursions(dir: Dir, entry: number, lo: number, hi: number,
  mfePct: number, maePct: number): { mfePct: number; maePct: number } {
  const fav = dir === 'long' ? (hi - entry) / entry * 100 : (entry - lo) / entry * 100;
  const adv = dir === 'long' ? (entry - lo) / entry * 100 : (hi - entry) / entry * 100;
  return { mfePct: Math.max(mfePct, fav, 0), maePct: Math.max(maePct, adv, 0) };
}
