/* Гипотеза, часть 1: детектор паттерна.
   Гипотеза о работе технического анализа остаётся на пользователе: здесь только
   контракт, на который опирается движок. Детектор по закрытым барам находит
   опорные точки A, B, C и по коэффициентам профиля k1–k3 считает цены уровней.
   Индексация: bar[0] = текущий = kl[n-1]; индекс точки — сколько баров назад.
   Детектор должен читать массив с конца: одна закачка баров обслуживает всю сетку. */
import type { Kline } from './exchanges/types.js';

export interface PatternPoint {
  p: number;  // цена
  i: number;  // индекс бара (0 = текущий)
  t: number;  // время открытия бара, unix ms
}

export interface Coefs { k1: number; k2: number; k3: number }
export interface Levels { k1: number; k2: number; k3: number }   // цены уровней

export interface Pattern {
  dir: 'long' | 'short';
  A: PatternPoint;
  B: PatternPoint;
  C: PatternPoint;
  levels: Levels;
}

/* Заглушка не находит паттернов: движок, журнал и интерфейс работают, но записей не будет. */
export function detectPattern(_kl: Kline[], _R: number, _k: Coefs): Pattern | null {
  return null;
}

/* Цены уровней по точкам A, B и коэффициентам. Без паттернов движок её не вызывает. */
export function levelPrices(_dir: 'long' | 'short', _A: number, _B: number, _k: Coefs): Levels {
  throw new Error('гипотеза не подключена: src/core/detector.ts');
}

/* Допустимые коэффициенты. Сетка пропускает комбинации, которые гипотеза не принимает. */
export function validCoefs(k: Coefs): boolean {
  return [k.k1, k.k2, k.k3].every(x => Number.isFinite(x) && x > 0);
}
