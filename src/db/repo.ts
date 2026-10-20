/* Слой доступа к данным: formations / entries / snapshots / profiles / settings */
import { db } from './index.js';
import {
  PROFILE_DEFAULTS, SNAPSHOT_DEFAULTS, INTENSITY_DEFAULTS, profileWithDefaults,
  type ProfileParams, type SnapshotTfCfg, type Intensity,
} from '../core/config.js';

/* ── settings (значения — JSON) ──────────────────────────────── */
const stGet = db.prepare(`SELECT value FROM settings WHERE key=?`);
const stSet = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

export function getSetting<T>(key: string, def: T): T {
  const row = stGet.get(key) as { value: string } | undefined;
  if (!row) return def;
  try { return JSON.parse(row.value) as T; } catch { return def; }
}
export function setSetting(key: string, value: unknown): void {
  stSet.run(key, JSON.stringify(value));
}

export const getSnapshotCfg = (): SnapshotTfCfg[] => getSetting('snapshot_config', SNAPSHOT_DEFAULTS);
export const getIntensity = (): Intensity => ({ ...INTENSITY_DEFAULTS, ...getSetting<Partial<Intensity>>('intensity', {}) });

/* ── скан-профили ────────────────────────────────────────────── */
export interface ProfileRow { name: string; params: ProfileParams; enabled: boolean; updated_at: number }

export function listProfiles(): ProfileRow[] {
  return (db.prepare(`SELECT name,params,enabled,updated_at FROM scan_profiles ORDER BY name`).all() as Array<{ name: string; params: string; enabled: number; updated_at: number }>)
    .map(r => ({ name: r.name, params: profileWithDefaults(JSON.parse(r.params)), enabled: !!r.enabled, updated_at: r.updated_at }));
}
export function getProfile(name: string): ProfileRow | null {
  const r = db.prepare(`SELECT name,params,enabled,updated_at FROM scan_profiles WHERE name=?`).get(name) as { name: string; params: string; enabled: number; updated_at: number } | undefined;
  return r ? { name: r.name, params: profileWithDefaults(JSON.parse(r.params)), enabled: !!r.enabled, updated_at: r.updated_at } : null;
}
export function upsertProfile(name: string, params: Partial<ProfileParams>, enabled: boolean): ProfileRow {
  const full = profileWithDefaults(params);
  db.prepare(`INSERT INTO scan_profiles(name,params,enabled,updated_at) VALUES(?,?,?,?)
              ON CONFLICT(name) DO UPDATE SET params=excluded.params, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(name, JSON.stringify(full), enabled ? 1 : 0, Date.now());
  return { name, params: full, enabled, updated_at: Date.now() };
}
export function deleteProfile(name: string): boolean {
  return db.prepare(`DELETE FROM scan_profiles WHERE name=?`).run(name).changes > 0;
}

/* Одна транзакция на пачку записей. Скан по сетке вставляет сотни формаций
   за проход; поодиночке это сотни коммитов WAL, подвешивающих цикл на сотни мс. */
export const tx = db.transaction((fn: () => void) => { fn(); });

/* ── формации ────────────────────────────────────────────────── */
export interface FormationRow {
  id: string; exchange: string; market: string; symbol: string; tf: string;
  dir: 'long' | 'short';
  ts_A: number; price_A: number; ts_B: number; price_B: number; ts_C: number; price_C: number;
  k1: number; k2: number; k3: number; search_range: number;
  status: 'armed' | 'triggered' | 'cancelled' | 'expired';
  detected_at: number; resolved_at: number | null; cancel_reason: string | null;
  score: number | null; score_stage: string; score_signal_at: number | null;
  scored_at: number | null; score_seen_until: number | null; score_ttl_bars: number | null;
}

const insFormation = db.prepare(`INSERT OR IGNORE INTO formations
  (id,exchange,market,symbol,tf,dir,ts_A,price_A,ts_B,price_B,ts_C,price_C,k1,k2,k3,search_range,status,detected_at,score_ttl_bars)
  VALUES (@id,@exchange,@market,@symbol,@tf,@dir,@ts_A,@price_A,@ts_B,@price_B,@ts_C,@price_C,@k1,@k2,@k3,@search_range,@status,@detected_at,@score_ttl_bars)`);

export function insertFormation(f: Omit<FormationRow, 'resolved_at' | 'cancel_reason' | 'score' | 'score_stage' | 'score_signal_at' | 'scored_at' | 'score_seen_until'>): boolean {
  return insFormation.run(f).changes > 0;   // false = такая формация уже есть (дедуп)
}
export function getFormation(id: string): FormationRow | undefined {
  return db.prepare(`SELECT * FROM formations WHERE id=?`).get(id) as FormationRow | undefined;
}
/* паттерн дошёл до сигнала (у сетки записи в журнале нет, статус ставим отдельно) */
export function markTriggered(id: string): void {
  db.prepare(`UPDATE formations SET status='triggered', resolved_at=? WHERE id=?`).run(Date.now(), id);
}
export function resolveFormation(id: string, status: 'expired' | 'cancelled', reason: string | null): void {
  db.prepare(`UPDATE formations SET status=?, resolved_at=?, cancel_reason=? WHERE id=?`)
    .run(status, Date.now(), reason, id);
}
export function listFormations(status?: string, limit = 100): FormationRow[] {
  if (status) return db.prepare(`SELECT * FROM formations WHERE status=? ORDER BY detected_at DESC LIMIT ?`).all(status, limit) as FormationRow[];
  return db.prepare(`SELECT * FROM formations ORDER BY detected_at DESC LIMIT ?`).all(limit) as FormationRow[];
}

/* ── скоринг ─────────────────────────────────────────────────── */
export function scoringFormations(): FormationRow[] {
  return db.prepare(`SELECT * FROM formations WHERE score_stage != 'final'`).all() as FormationRow[];
}
export function updateFormationScore(id: string, s: {
  score: number | null; score_stage: string; score_signal_at: number | null;
  scored_at: number | null; score_seen_until: number | null;
}): void {
  db.prepare(`UPDATE formations SET score=?, score_stage=?, score_signal_at=?, scored_at=?, score_seen_until=? WHERE id=?`)
    .run(s.score, s.score_stage, s.score_signal_at, s.scored_at, s.score_seen_until, id);
}

/* ── наблюдения (от сигнала до оценки) ─────────────────────────── */
export interface EntryRow {
  id: number; formation_id: string | null;
  exchange: string; market: string; symbol: string; tf: string; dir: 'long' | 'short';
  entered_at: number; entry_price: number;
  status: 'open' | 'closed';
  exited_at: number | null; exit_price: number | null; exit_reason: string | null;
  mfe_pct: number | null; mae_pct: number | null;
  bars_held: number | null;
}

/* строка журнала: наблюдение + оценка его паттерна */
export interface EntryWithScore extends EntryRow {
  score: number | null; score_stage: string | null;
  score_signal_at: number | null; scored_at: number | null;
}

const insEntry = db.prepare(`INSERT INTO entries
  (formation_id,exchange,market,symbol,tf,dir,entered_at,entry_price,status,mfe_pct,mae_pct)
  VALUES (@formation_id,@exchange,@market,@symbol,@tf,@dir,@entered_at,@entry_price,'open',0,0)`);

const insSnapshot = db.prepare(`INSERT INTO snapshots(entry_id,schema_version,captured_at,body) VALUES(?,?,?,?)`);
const updFormationTriggered = db.prepare(`UPDATE formations SET status='triggered', resolved_at=? WHERE id=?`);

/* атомарная запись: наблюдение + снапшот на сигнале + статус паттерна */
export const insertEntryWithSnapshot = db.transaction(
  (e: Record<string, unknown>, schemaVersion: number, capturedAt: number, body: Buffer): number => {
    const id = Number(insEntry.run(e).lastInsertRowid);
    insSnapshot.run(id, schemaVersion, capturedAt, body);
    if (e.formation_id) updFormationTriggered.run(capturedAt, e.formation_id);
    return id;
  }
);

export function updateEntryExcursions(id: number, mfePct: number, maePct: number): void {
  db.prepare(`UPDATE entries SET mfe_pct=?, mae_pct=? WHERE id=?`).run(mfePct, maePct, id);
}
export function closeEntry(id: number, exitedAt: number, exitPrice: number, reason: string, barsHeld: number): void {
  db.prepare(`UPDATE entries SET status='closed', exited_at=?, exit_price=?, exit_reason=?, bars_held=? WHERE id=?`)
    .run(exitedAt, exitPrice, reason, barsHeld, id);
}
export function openEntries(): EntryRow[] {
  return db.prepare(`SELECT * FROM entries WHERE status='open'`).all() as EntryRow[];
}
/* паттерны, по которым сигнал уже записан (для восстановления hasEntry) */
export function entryFormationIds(): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT formation_id FROM entries WHERE formation_id IS NOT NULL`).all() as Array<{ formation_id: string }>;
  return new Set(rows.map(r => r.formation_id));
}

const ENTRY_SCORE_SELECT = `SELECT e.*, f.score, f.score_stage, f.score_signal_at, f.scored_at
  FROM entries e LEFT JOIN formations f ON f.id = e.formation_id`;

export function listEntries(q: { status?: string; symbol?: string; dir?: string; score?: string; from?: number; to?: number; limit?: number }): EntryWithScore[] {
  const cond: string[] = []; const args: unknown[] = [];
  if (q.status) { cond.push('e.status=?'); args.push(q.status); }
  if (q.symbol) { cond.push('e.symbol LIKE ?'); args.push('%' + q.symbol.toUpperCase() + '%'); }
  if (q.dir) { cond.push('e.dir=?'); args.push(q.dir); }
  if (q.score === 'pending') cond.push(`f.score_stage IS NOT NULL AND f.score_stage != 'final'`);
  else if (q.score != null && q.score !== '') { cond.push(`f.score_stage='final' AND f.score=?`); args.push(parseInt(q.score, 10)); }
  if (q.from) { cond.push('e.entered_at>=?'); args.push(q.from); }
  if (q.to) { cond.push('e.entered_at<=?'); args.push(q.to); }
  const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
  args.push(Math.min(1000, q.limit ?? 200));
  return db.prepare(ENTRY_SCORE_SELECT + where + ' ORDER BY e.entered_at DESC LIMIT ?').all(...args) as EntryWithScore[];
}
export function getEntry(id: number): EntryWithScore | null {
  return (db.prepare(ENTRY_SCORE_SELECT + ' WHERE e.id=?').get(id) as EntryWithScore | undefined) ?? null;
}
export function getSnapshotBody(entryId: number): Buffer | null {
  const r = db.prepare(`SELECT body FROM snapshots WHERE entry_id=?`).get(entryId) as { body: Buffer } | undefined;
  return r ? r.body : null;
}

/* ── дозапись klines_after: бары от сигнала до фиксации ───────── */
export function listEntriesNeedingAfter(limit: number): Array<{ id: number; symbol: string; tf: string; entered_at: number; exited_at: number }> {
  return db.prepare(`SELECT e.id, e.symbol, e.tf, e.entered_at, e.exited_at
    FROM entries e JOIN snapshots s ON s.entry_id = e.id
    WHERE e.status='closed' AND e.exited_at IS NOT NULL AND s.body_after IS NULL
    ORDER BY e.exited_at ASC LIMIT ?`).all(limit) as Array<{ id: number; symbol: string; tf: string; entered_at: number; exited_at: number }>;
}
export function saveBodyAfter(entryId: number, body: Buffer): void {
  db.prepare(`UPDATE snapshots SET body_after=? WHERE entry_id=?`).run(body, entryId);
}
export function getAfterBody(entryId: number): Buffer | null {
  const r = db.prepare(`SELECT body_after FROM snapshots WHERE entry_id=?`).get(entryId) as { body_after: Buffer | null } | undefined;
  return r?.body_after ?? null;
}

/* ── снапшот на фиксации оценки ──────────────────────────────── */
export function listEntriesNeedingScoredSnapshot(limit: number): Array<{ id: number; formation_id: string | null; symbol: string }> {
  return db.prepare(`SELECT e.id, e.formation_id, e.symbol
    FROM entries e JOIN snapshots s ON s.entry_id = e.id
    WHERE e.status='closed' AND e.exit_reason='scored' AND s.body_scored IS NULL
    ORDER BY e.exited_at ASC LIMIT ?`).all(limit) as Array<{ id: number; formation_id: string | null; symbol: string }>;
}
export function saveBodyScored(entryId: number, body: Buffer): void {
  db.prepare(`UPDATE snapshots SET body_scored=? WHERE entry_id=?`).run(body, entryId);
}
export function getScoredBody(entryId: number): Buffer | null {
  const r = db.prepare(`SELECT body_scored FROM snapshots WHERE entry_id=?`).get(entryId) as { body_scored: Buffer | null } | undefined;
  return r?.body_scored ?? null;
}

export function countEntries(): { total: number; open: number } {
  const r = db.prepare(`SELECT count(*) AS total, sum(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM entries`).get() as { total: number; open: number | null };
  return { total: r.total, open: r.open ?? 0 };
}

/* ── обслуживание БД ─────────────────────────────────────────── */
export function maintenanceStats() {
  const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const s = db.prepare(`SELECT coalesce(sum(length(body)),0) AS sig, coalesce(sum(length(body_after)),0) AS aft,
    coalesce(sum(length(body_scored)),0) AS sc FROM snapshots`).get() as { sig: number; aft: number; sc: number };
  const oldest = (db.prepare(`SELECT min(entered_at) AS t FROM entries`).get() as { t: number | null }).t;
  return {
    formations: n('formations'), entries: n('entries'), snapshots: n('snapshots'),
    snapshot_bytes: s.sig + s.aft + s.sc,
    oldest_entry_at: oldest,
  };
}

/* Чистка завершённого старше N дней: снапшоты → закрытые наблюдения → паттерны без наблюдений.
   Не трогает: armed-паттерны, открытые наблюдения и их паттерны — движок продолжает работу без рестарта. */
export function cleanupOlderThan(days: number): { entries: number; snapshots: number; formations: number } {
  const cutoff = Date.now() - days * 86400000;
  const tx = db.transaction(() => {
    const snapshots = db.prepare(
      `DELETE FROM snapshots WHERE entry_id IN (SELECT id FROM entries WHERE status='closed' AND entered_at < ?)`).run(cutoff).changes;
    const entries = db.prepare(`DELETE FROM entries WHERE status='closed' AND entered_at < ?`).run(cutoff).changes;
    const formations = db.prepare(
      `DELETE FROM formations WHERE status <> 'armed' AND detected_at < ?
         AND id NOT IN (SELECT formation_id FROM entries WHERE formation_id IS NOT NULL)`).run(cutoff).changes;
    return { entries, snapshots, formations };
  });
  return tx();
}

/* ── сидинг дефолтов при первом запуске ──────────────────────── */
export function seedDefaults(): void {
  const profiles = listProfiles();
  if (!profiles.length) upsertProfile('default', PROFILE_DEFAULTS, true);
  if (!stGet.get('snapshot_config')) setSetting('snapshot_config', SNAPSHOT_DEFAULTS);
  if (!stGet.get('intensity')) setSetting('intensity', INTENSITY_DEFAULTS);
  if (!stGet.get('engine_autostart')) setSetting('engine_autostart', true);
}
