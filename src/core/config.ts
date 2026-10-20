/* Типы и дефолты настроек: скан-профили, снапшот, интенсивность.
   Запись наблюдения создаётся на сигнале и завершается фиксацией оценки скоринга. */
import type { TF } from './exchanges/types.js';
import { validCoefs } from './detector.js';

/* ── Скан-профиль ────────────────────────────────────────────── */
export interface ProfileParams {
  exchange: 'binance';
  market: 'futures';
  tf: TF;                 // рабочий ТФ детектора
  search_range: number;   // окно поиска, бары
  k1: number;             // коэффициенты уровней: смысл задаёт гипотеза (src/core/detector.ts)
  k2: number;
  k3: number;
  score_ttl_bars: number; // TTL скоринга: баров наблюдения до финальной оценки
  top_n: number;          // сканировать только N самых ликвидных (0 = все)
  min_vol24: number;      // мин. оборот 24ч в USDT (0 = выкл)
  grid: GridSpec | null;  // диапазоны для перебора комбинаций (null = обычный профиль)
}

/* Демо-значения: гипотеза и её параметры остаются на пользователе */
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
  /* берём только известные ключи — лишние поля отбрасываются */
  const out = { ...PROFILE_DEFAULTS };
  if (p) for (const k of Object.keys(PROFILE_DEFAULTS) as Array<keyof ProfileParams>) {
    if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  }
  return out;
}

/* ── Сетка настроек ──────────────────────────────────────────
   Профиль с диапазонами разворачивается в набор комбинаций. Одна закачка баров
   обслуживает всю сетку: детектор читает массив с конца и берёт только последние
   search_range баров, поэтому лишние бары в начале не меняют результат.
   Имя комбинации входит в formation.id, поэтому записи комбинаций не сливаются. */
export type GridRange = [from: number, to: number, step: number];
export interface GridSpec { k1?: GridRange; k2?: GridRange; search_range?: GridRange }
export interface Combo { name: string; params: ProfileParams }

export const MAX_GRID_COMBOS = 500;

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/* значения диапазона [от, до, шаг]; отсутствует или невалиден → одно значение профиля */
function gridValues(r: GridRange | undefined, def: number): number[] {
  if (!Array.isArray(r)) return [def];
  const [from, to, step] = r;
  if (![from, to, step].every(Number.isFinite) || !(step > 0) || to < from) return [def];
  const out: number[] = [];
  /* допуск в микрошаг: 0.1 + 0.1×2 = 0.30000000000000004 иначе теряет последнее значение */
  for (let v = from; v <= to + step * 1e-6; v += step) out.push(r3(v));
  return out;
}

export function expandGrid(name: string, p: ProfileParams): Combo[] {
  if (!p.grid) return [{ name, params: p }];
  const as = gridValues(p.grid.k1, p.k1);
  const bs = gridValues(p.grid.k2, p.k2);
  const rs = gridValues(p.grid.search_range, p.search_range).map(v => Math.max(3, Math.round(v)));

  const total = as.length * bs.length * rs.length;
  if (total > MAX_GRID_COMBOS) throw new Error(`сетка «${name}»: ${total} комбинаций при потолке ${MAX_GRID_COMBOS}`);

  const out: Combo[] = [];
  for (const k1 of as) for (const k2 of bs) for (const search_range of rs) {
    if (!validCoefs({ k1, k2, k3: p.k3 })) continue;   // невалидная для гипотезы комбинация пропускается
    /* grid: null у комбинации — она уже развёрнута и повторно не разворачивается */
    out.push({ name: `${name}#k1=${k1},k2=${k2},r=${search_range}`, params: { ...p, k1, k2, search_range, grid: null } });
  }
  if (!out.length) throw new Error(`сетка «${name}»: ни одной валидной комбинации`);
  return out;
}

/* имя базового профиля из имени комбинации (и из formation.id) */
export const baseProfileName = (name: string): string => name.split('#')[0];

/* комбинация сетки, а не обычный профиль: её сигналы идут строкой
   в data/grid.db, без снапшота и без записи в журнал */
export const isCombo = (name: string): boolean => name.includes('#');

/* ── Конфигурация снапшота ───────────────────────────────────── */
export interface SnapshotTfCfg { tf: TF; bars: number }

export const SNAPSHOT_DEFAULTS: SnapshotTfCfg[] = [
  { tf: '5m', bars: 600 },   // ≈ 50 часов
  { tf: '15m', bars: 400 },  // ≈ 4 дня
  { tf: '1H', bars: 480 },   // = 20 дней
  { tf: '4H', bars: 180 },   // = 30 дней
  { tf: '1D', bars: 90 },    // = 3 месяца
];

/* ── Интенсивность обновлений ────────────────────────────────── */
export interface Intensity {
  track_sec: number;       // контур сопровождения наблюдений
  universe_min: number;    // контур тикеров/вселенной
  scan_delay_sec: number;  // задержка после закрытия бара перед сканом
}

export const INTENSITY_DEFAULTS: Intensity = {
  track_sec: 30,
  universe_min: 5,
  scan_delay_sec: 5,
};

export const SNAPSHOT_SCHEMA_VERSION = 1;
