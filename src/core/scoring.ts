/* Гипотеза, часть 2: скоринг. Автомат стадий ведёт паттерн от обнаружения до
   финальной оценки 0–4. Он двигается закрытыми барами (lo/hi = low/high бара)
   и тиками (lo = hi = цена) и завершается фиксацией оценки или истечением TTL.
   Когда наступает сигнал, какие стадии проходит паттерн и что означает оценка,
   решает гипотеза пользователя: здесь только контракт для движка и инженерная
   часть (покрытие баров скана, обрезка истории). Без паттернов движок заглушки
   не вызывает. */

import type { Kline } from './exchanges/types.js';
import type { Levels } from './detector.js';

export type Dir = 'long' | 'short';
/* 'watch' — начальная стадия, 'final' — оценка зафиксирована; промежуточные задаёт гипотеза */
export type ScoreStage = string;

export interface ScoreLevels extends Levels { A: number; B: number }

export interface ScoreState {
  stage: ScoreStage;
  score: number | null;     // 0..4, null пока не выставлена
  signalAt: number | null;  // момент сигнала: с него начинается запись в журнале
  scoredAt: number | null;  // момент финализации
}

export function freshScore(): ScoreState {
  return { stage: 'watch', score: null, signalAt: null, scoredAt: null };
}

const hidden = (): never => { throw new Error('гипотеза не подключена: src/core/scoring.ts'); };

/* Продвижка по диапазону цен [lo..hi] на момент t. Возвращает true, если
   стадия или оценка изменились; при сигнале выставляет signalAt. */
export function advance(_st: ScoreState, _dir: Dir, _lv: ScoreLevels, _lo: number, _hi: number, _t: number): boolean {
  return hidden();
}

/* Истечение TTL скоринга: финальная оценка паттерна */
export function finalizeTtl(_st: ScoreState, _deadline: number): boolean {
  return hidden();
}

/* Цена, по которой записывается сигнал */
export function signalPrice(_lv: ScoreLevels): number {
  return hidden();
}

/* Цена закрытия наблюдения при фиксации оценки; refPrice — ближайшая известная цена */
export function exitPrice(_score: number, _lv: ScoreLevels, _refPrice: number): number {
  return hidden();
}

/* Насколько бары последнего скана покрывают бэклог паттерна.
   `covers` — можно двигать автомат прямо по ним, сеть не нужна;
   `lags-one-bar` — бар только что закрылся, скан принесёт его через секунды
   (после закрытия бара скан идёт с задержкой scan_delay_sec): ждём, а не тратим
   запрос и слот бюджета на данные, которые вот-вот придут даром;
   `insufficient` — скан отстал всерьёз или монеты в нём нет (выпала из вселенной,
   был простой): без запроса к бирже автомат поехал бы по неполным данным. */
export type ScanCoverage = 'covers' | 'lags-one-bar' | 'insufficient';

export function scanCoverage(kl: Kline[] | undefined, startTime: number, lastClosed: number, tfMs: number): ScanCoverage {
  if (!kl?.length || kl[0].t > startTime) return 'insufficient';   // не достаёт назад до начала бэклога
  const end = kl[kl.length - 1].t + tfMs;                          // закрытие последнего бара скана
  if (end >= lastClosed) return 'covers';
  return end + tfMs >= lastClosed ? 'lags-one-bar' : 'insufficient';
}
