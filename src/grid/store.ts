/* Grid experiment storage.
   A separate file, data/grid.db: grid data has a different shape (no snapshots, but
   a "combination" dimension), and millions of rows must not slow down the filters
   of the journal, which needs hundreds.

   The key decision: the grid builds no snapshot container at all. 125 combinations
   on one market event would produce 125 containers with practically identical
   bars, 4.5 GB a day. Instead of a container a short row is stored: the signal,
   the combination and the score. If needed, the chart is loaded from the exchange
   through the existing /api/market/klines?start. */
import Database from 'better-sqlite3';
import path from 'node:path';
import { dataDir } from '../db/index.js';

export const gridDbFile = path.join(dataDir, 'grid.db');

const db: Database.Database = new Database(gridDbFile);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS grid_signals (
  formation_id  TEXT PRIMARY KEY,          -- profile#combination|exchange|market|symbol|tf|ts_A|dir
  profile       TEXT NOT NULL,             -- base profile = experiment
  combo         TEXT NOT NULL,             -- full combination name
  k1            REAL NOT NULL,
  k2            REAL NOT NULL,
  search_range  INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  tf            TEXT NOT NULL,
  dir           TEXT NOT NULL,
  entered_at    INTEGER NOT NULL,          -- signal moment
  entry_price   REAL NOT NULL,             -- signal price
  score         INTEGER,                   -- 0..4, NULL until final
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

/* which grid patterns are already recorded, so they aren't duplicated after a restart */
export function signalIds(): Set<string> {
  return new Set((db.prepare(`SELECT formation_id FROM grid_signals`).all() as Array<{ formation_id: string }>).map(r => r.formation_id));
}

const updScore = db.prepare(`UPDATE grid_signals SET score=?, scored_at=? WHERE formation_id=?`);
export function setScore(formationId: string, score: number, scoredAt: number): void {
  updScore.run(score, scoredAt, formationId);
}

export const tx = db.transaction((fn: () => void) => { fn(); });

/* Per-combination aggregate: the score distribution for each one.
   Computed by a query on the fly rather than kept in a table: 125 rows by index
   come back instantly, while an aggregate table would need syncing.
   Counters use CASE rather than SUM(score = N): for a combination without a single score,
   SUM over NULLs alone would return NULL, and the heat map would get holes. */
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

/* delete a whole experiment: a failed run is thrown away without touching
   either the main journal or other experiments */
export function dropProfile(profile: string): number {
  return db.prepare(`DELETE FROM grid_signals WHERE profile=?`).run(profile).changes;
}
