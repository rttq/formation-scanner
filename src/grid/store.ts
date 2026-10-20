/* Хранилище эксперимента по сетке.
   Отдельный файл data/grid.db: у сетки другая форма данных (нет снапшотов, зато
   есть измерение «комбинация»), и миллионы строк не должны замедлять фильтры
   Журнала, которому нужны сотни.

   Главное решение: контейнер-снапшот в сетке не собирается вовсе. 125 комбинаций
   на одном событии рынка дали бы 125 контейнеров с практически одинаковыми
   барами — 4,5 ГБ в сутки. Вместо контейнера хранится короткая строка: сигнал,
   комбинация и оценка. График при надобности догружается с биржи через
   существующий /api/market/klines?start. */
import Database from 'better-sqlite3';
import path from 'node:path';
import { dataDir } from '../db/index.js';

export const gridDbFile = path.join(dataDir, 'grid.db');

const db: Database.Database = new Database(gridDbFile);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS grid_signals (
  formation_id  TEXT PRIMARY KEY,          -- profile#комбинация|exchange|market|symbol|tf|ts_A|dir
  profile       TEXT NOT NULL,             -- базовый профиль = эксперимент
  combo         TEXT NOT NULL,             -- имя комбинации целиком
  k1            REAL NOT NULL,
  k2            REAL NOT NULL,
  search_range  INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  tf            TEXT NOT NULL,
  dir           TEXT NOT NULL,
  entered_at    INTEGER NOT NULL,          -- момент сигнала
  entry_price   REAL NOT NULL,             -- цена сигнала
  score         INTEGER,                   -- 0..4, NULL пока не зафиксирована
  scored_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grid_combo ON grid_signals(profile, combo, score);
CREATE INDEX IF NOT EXISTS idx_grid_time ON grid_signals(entered_at);
`);

const insSignal = db.prepare(`INSERT OR IGNORE INTO grid_signals
  (formation_id,profile,combo,k1,k2,search_range,symbol,tf,dir,entered_at,entry_price)
  VALUES (@formation_id,@profile,@combo,@k1,@k2,@search_range,@symbol,@tf,@dir,@entered_at,@entry_price)`);

export interface GridSignal {
  formation_id: string;
  profile: string; combo: string;
  k1: number; k2: number; search_range: number;
  symbol: string; tf: string; dir: 'long' | 'short';
  entered_at: number; entry_price: number;
}

export function insertSignal(s: GridSignal): void {
  insSignal.run(s);
}

/* какие паттерны сетки уже записаны — чтобы после перезапуска не задваивать */
export function signalIds(): Set<string> {
  return new Set((db.prepare(`SELECT formation_id FROM grid_signals`).all() as Array<{ formation_id: string }>).map(r => r.formation_id));
}

const updScore = db.prepare(`UPDATE grid_signals SET score=?, scored_at=? WHERE formation_id=?`);
export function setScore(formationId: string, score: number, scoredAt: number): void {
  updScore.run(score, scoredAt, formationId);
}

export const tx = db.transaction((fn: () => void) => { fn(); });

/* Агрегат по комбинациям: распределение оценок для каждой.
   Считается запросом на лету, а не отдельной таблицей: 125 строк по индексу
   берутся мгновенно, а таблица-агрегат потребовала бы синхронизации.
   Счётчики через CASE, а не SUM(score = N): у комбинации без единой оценки
   SUM по одним NULL вернул бы NULL, и тепловая карта получила бы дыры. */
export interface ComboStats {
  combo: string; k1: number; k2: number; search_range: number;
  n: number; pending: number;
  s0: number; s1: number; s2: number; s3: number; s4: number;
  avg_score: number | null;
}

export function comboStats(profile?: string): ComboStats[] {
  const where = profile ? `WHERE profile = ?` : '';
  return db.prepare(`
    SELECT combo, k1, k2, search_range,
           COUNT(*)                                            AS n,
           SUM(CASE WHEN score IS NULL THEN 1 ELSE 0 END)      AS pending,
           SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END)          AS s0,
           SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END)          AS s1,
           SUM(CASE WHEN score = 2 THEN 1 ELSE 0 END)          AS s2,
           SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END)          AS s3,
           SUM(CASE WHEN score = 4 THEN 1 ELSE 0 END)          AS s4,
           AVG(score)                                          AS avg_score
    FROM grid_signals ${where}
    GROUP BY combo
    ORDER BY k1, k2, search_range
  `).all(...(profile ? [profile] : [])) as ComboStats[];
}

export function stats(): { signals: number; scored: number; profiles: string[]; bytes: number; oldest: number | null } {
  const r = db.prepare(`SELECT COUNT(*) n, SUM(score IS NOT NULL) scored, MIN(entered_at) oldest FROM grid_signals`)
    .get() as { n: number; scored: number | null; oldest: number | null };
  const page = db.pragma('page_count', { simple: true }) as number;
  const size = db.pragma('page_size', { simple: true }) as number;
  return {
    signals: r.n, scored: r.scored ?? 0, oldest: r.oldest,
    profiles: (db.prepare(`SELECT DISTINCT profile FROM grid_signals`).all() as Array<{ profile: string }>).map(x => x.profile),
    bytes: page * size,
  };
}

/* удаление эксперимента целиком — неудачный прогон выбрасывается, не задевая
   ни рабочий журнал, ни другие эксперименты */
export function dropProfile(profile: string): number {
  return db.prepare(`DELETE FROM grid_signals WHERE profile=?`).run(profile).changes;
}
