/* Scanner engine. A detected pattern is scored (score 0–4).
   When the hypothesis's scoring fires a signal, an observation record is created
   with a snapshot; patterns without a signal never reach the journal, only scoring.
   When the score becomes final, the record closes and gets a second snapshot.
   Loops:
   1) pattern scan: at each bar close of the pattern TF (+ delay);
   2) tracking: every track_sec, one tickers request for everything;
   3) universe: every universe_min minutes. */
import { binanceFut } from './exchanges/binance-fut.js';
import { TF_MS, type TF, type Instrument, type Kline, type Ticker } from './exchanges/types.js';
import { detectPattern, levelPrices, type Levels } from './detector.js';
import * as trade from './trade.js';
import * as scoring from './scoring.js';
import { buildSnapshot, encodeGzJson, type AfterBody, type PatternInfo } from './snapshot.js';
import * as repo from '../db/repo.js';
import * as grid from '../grid/store.js';
import {
  SNAPSHOT_SCHEMA_VERSION, PROFILE_DEFAULTS, profileWithDefaults, expandGrid, baseProfileName, isCombo,
  type ProfileParams, type Combo,
} from './config.js';

type Dir = 'long' | 'short';

/* open observation (from the signal to the final score) */
interface OpenPos {
  entryId: number;
  formationId: string | null;
  symbol: string; tf: TF; dir: Dir;
  entry: number;
  enteredAt: number;
  mfePct: number; maePct: number;
  /* pattern points and levels, drawn on the live scanner cards */
  pattern: CardPattern | null;
}

interface CardPattern {
  A: { p: number; t: number }; B: { p: number; t: number };
  levels: Levels;
}

/* pattern being scored */
interface ScoringItem {
  id: string;
  symbol: string; tf: TF; dir: Dir;
  lv: scoring.ScoreLevels;
  detectedAt: number;
  deadline: number;          // detectedAt + score_ttl_bars × tfMs
  seenUntil: number;         // close of the last processed bar
  st: scoring.ScoreState;
  hasEntry: boolean;         // signal already recorded
  isGrid: boolean;           // grid combination: a row in grid.db instead of a journal entry and snapshot
  card: CardPattern;         // points/levels for the live scanner cards
}

const adapter = binanceFut;

let running = false;
let instruments = new Map<string, Instrument>();
const tickerMap = new Map<string, Ticker>();
const universes = new Map<string, string[]>();      // profileName -> symbols
const open = new Map<number, OpenPos>();
const scoringMap = new Map<string, ScoringItem>();
const entering = new Set<string>();                 // guards against recording a signal twice
const lastScanAt = new Map<string, number>();       // profileName -> ts

/* bars of the last scan per TF, closed ones only: scoring advances on them */
const scanBars = new Map<TF, Map<string, Kline[]>>();
/* how many times scoring still went to the network: with a live grid this should
   barely move, otherwise scan bars don't cover the backlog and the request savings don't work */
let scoringFetches = 0;

let universeTimer: NodeJS.Timeout | null = null;
let trackTimer: NodeJS.Timeout | null = null;
const scanTimers = new Map<TF, NodeJS.Timeout>();
let tracking = false;
const scanning = new Set<TF>();
let lastError: string | null = null;
let lastReplay: { at: number; updatedPositions: number } | null = null;

/* pattern level prices from a DB row */
function levelsOf(f: repo.FormationRow): Levels {
  return levelPrices(f.dir, f.price_A, f.price_B, { k1: f.k1, k2: f.k2, k3: f.k3 });
}
function cardPatternOf(f: repo.FormationRow | undefined): CardPattern | null {
  if (!f) return null;
  return { A: { p: f.price_A, t: f.ts_A }, B: { p: f.price_B, t: f.ts_B }, levels: levelsOf(f) };
}
/* profile parameters for a formation. The profile name is stored in its id; a grid
   combination (`base#k1=..,k2=..,r=..`) has no profile row of its own, so the base comes
   from the base name and the swept keys from the formation row itself. The same path
   covers a deleted profile: no base → the defaults remain. */
function profileOfFormation(f: repo.FormationRow): { name: string; params: ProfileParams } {
  const name = f.id.split('|')[0];
  return {
    name,
    params: profileWithDefaults({
      ...repo.getProfile(baseProfileName(name))?.params,
      tf: f.tf as TF, search_range: f.search_range, k1: f.k1, k2: f.k2, k3: f.k3,
      score_ttl_bars: f.score_ttl_bars ?? undefined,
      grid: null,
    }),
  };
}

function fullPatternOf(f: repo.FormationRow): PatternInfo {
  return {
    tf: f.tf as TF, dir: f.dir,
    A: { p: f.price_A, t: f.ts_A }, B: { p: f.price_B, t: f.ts_B }, C: { p: f.price_C, t: f.ts_C },
    levels: levelsOf(f),
  };
}

/* ═══ START / STOP ═══════════════════════════════════════════ */
export async function start(): Promise<void> {
  if (running) return;
  lastError = null;
  instruments = await adapter.instruments();
  await refreshUniverse();
  restoreFromDb();
  loadScoring();
  reconcileScored();               // observations whose score became final during downtime are closed right away
  await reconcileMissingEntries(); // signals that fired during downtime or a failure are recorded now
  await catchUpExcursions();       // MFE/MAE over the downtime (the scoring sweep does the closing)
  running = true;

  const it = repo.getIntensity();
  universeTimer = setInterval(() => { refreshUniverse().catch(e => { lastError = String(e); }); }, Math.max(1, it.universe_min) * 60_000);
  trackTimer = setInterval(() => { trackTick().catch(e => { lastError = String(e); }); }, Math.max(5, it.track_sec) * 1000);
  for (const tf of enabledTfs()) scheduleScan(tf);
  /* the first scan runs right away, without waiting for a bar close */
  for (const tf of enabledTfs()) runScans(tf).catch(e => { lastError = String(e); });
}

export function stop(): void {
  running = false;
  if (universeTimer) { clearInterval(universeTimer); universeTimer = null; }
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  for (const t of scanTimers.values()) clearTimeout(t);
  scanTimers.clear();
}

export function status() {
  return {
    running,
    lastError,
    lastReplay,
    profiles: repo.listProfiles().map(p => ({
      name: p.name, enabled: p.enabled, tf: p.params.tf,
      universe: (universes.get(p.name) ?? []).length,
      lastScanAt: lastScanAt.get(p.name) ?? null,
    })),
    openCount: open.size,
    scoringCount: scoringMap.size,
    scoringFetches,
    entries: repo.countEntries(),
  };
}

function enabledTfs(): TF[] {
  return [...new Set(repo.listProfiles().filter(p => p.enabled).map(p => p.params.tf))];
}

/* state for the live scanner: observations with their scoring stage */
export function scannerState() {
  const t = (sym: string) => {
    const x = tickerMap.get(sym);
    return x ? { price: x.price, chg: x.chg, vol: x.vol } : null;
  };
  return {
    running,
    /* patterns awaiting a signal */
    waiting: [...scoringMap.values()].filter(s => !s.hasEntry && !s.isGrid).map(s => ({
      id: s.id, symbol: s.symbol, tf: s.tf, dir: s.dir,
      detectedAt: s.detectedAt, ticker: t(s.symbol),
      A: s.card.A, B: s.card.B, levels: s.card.levels,
      stage: s.st.stage,
    })),
    open: [...open.values()].map(p => {
      const s = p.formationId ? scoringMap.get(p.formationId) : undefined;
      return {
        entryId: p.entryId, symbol: p.symbol, tf: p.tf, dir: p.dir,
        entry: p.entry, enteredAt: p.enteredAt,
        mfePct: p.mfePct, maePct: p.maePct, ticker: t(p.symbol),
        A: p.pattern?.A ?? null, B: p.pattern?.B ?? null, levels: p.pattern?.levels ?? null,
        stage: s?.st.stage ?? null, score: s?.st.score ?? null,
      };
    }),
  };
}

export async function restart(): Promise<void> {
  stop();
  await start();
}

/* ── restoring state from the DB after a restart ─────────────── */
function restoreFromDb(): void {
  open.clear();
  for (const e of repo.openEntries()) {
    open.set(e.id, {
      entryId: e.id, formationId: e.formation_id, symbol: e.symbol, tf: e.tf as TF, dir: e.dir,
      entry: e.entry_price,
      enteredAt: e.entered_at, mfePct: e.mfe_pct ?? 0, maePct: e.mae_pct ?? 0,
      pattern: cardPatternOf(e.formation_id ? repo.getFormation(e.formation_id) : undefined),
    });
  }
}

/* ═══ SCORING ═════════════════════════════════════════════════
   The 30 s tick advances the machine on the current price; the sweep catches up on
   closed bars (high/low: ticks between polls miss the wicks) and the TTL; after downtime
   the sweep catches up on what was missed by itself. When the score becomes final
   (stage final), the observation closes: exited_at = moment of the final score,
   exit_reason = 'scored'. */
function loadScoring(): void {
  scoringMap.clear();
  const withEntries = repo.entryFormationIds();
  const gridSeen = grid.signalIds();
  for (const f of repo.scoringFormations()) {
    const prof = repo.getProfile(baseProfileName(f.id.split('|')[0]))?.params;
    const ttl = f.score_ttl_bars ?? prof?.score_ttl_bars ?? PROFILE_DEFAULTS.score_ttl_bars;
    const tfMs = TF_MS[f.tf as TF];
    scoringMap.set(f.id, {
      id: f.id, symbol: f.symbol, tf: f.tf as TF, dir: f.dir,
      lv: { A: f.price_A, B: f.price_B, ...levelsOf(f) },
      detectedAt: f.detected_at,
      deadline: f.detected_at + ttl * tfMs,
      seenUntil: f.score_seen_until ?? f.detected_at,
      st: {
        stage: (f.score_stage as scoring.ScoreStage) ?? 'watch',
        score: f.score, signalAt: f.score_signal_at, scoredAt: f.scored_at,
      },
      hasEntry: gridSeen.has(f.id) || withEntries.has(f.id),
      isGrid: isCombo(f.id.split('|')[0]),
      card: cardPatternOf(f)!,
    });
  }
}

/* scoring changed the state: first the signal, then persisting and,
   if final, closing the observation */
async function onScoreChanged(s: ScoringItem, refPrice: number | null): Promise<void> {
  if (!s.hasEntry && s.st.signalAt != null) await createSignalEntry(s);
  persistScore(s, refPrice);
}

/* refPrice is "a price near the final score" (bar close or tick) for TTL exits */
function persistScore(s: ScoringItem, refPrice: number | null): void {
  repo.updateFormationScore(s.id, {
    score: s.st.score, score_stage: s.st.stage, score_signal_at: s.st.signalAt,
    scored_at: s.st.scoredAt, score_seen_until: s.seenUntil,
  });
  if (s.st.stage === 'final') {
    if (s.isGrid) {
      /* a grid row gets its score; the grid has no journal and no snapshot */
      if (s.hasEntry) grid.setScore(s.id, s.st.score ?? 0, s.st.scoredAt ?? Date.now());
      else repo.resolveFormation(s.id, 'expired', `no signal, score ${s.st.score ?? 0}`);
    } else if (s.hasEntry) closeByScore(s, refPrice);
    else repo.resolveFormation(s.id, 'expired', `no signal, score ${s.st.score ?? 0}`);
    scoringMap.delete(s.id);
  }
}

/* a final score closes the observation; scoring provides the exit price for the score */
function closeByScore(s: ScoringItem, refPrice: number | null): void {
  const pos = [...open.values()].find(p => p.formationId === s.id);
  if (!pos) return;                                  // no observation (legacy formation)
  const score = s.st.score ?? 0;
  const exitPrice = scoring.exitPrice(score, s.lv, refPrice ?? tickerMap.get(s.symbol)?.price ?? pos.entry);
  const at = s.st.scoredAt ?? Date.now();
  const barsHeld = Math.max(0, Math.floor((at - pos.enteredAt) / TF_MS[pos.tf]));
  repo.closeEntry(pos.entryId, at, exitPrice, 'scored', barsHeld);
  open.delete(pos.entryId);
}

/* open observations whose score is already final (it became final during downtime):
   close them from the pattern data */
function reconcileScored(): void {
  for (const pos of [...open.values()]) {
    const f = pos.formationId ? repo.getFormation(pos.formationId) : undefined;
    if (!f || f.score_stage !== 'final') continue;
    const score = f.score ?? 0;
    const exitPrice = scoring.exitPrice(score, { A: f.price_A, B: f.price_B, ...levelsOf(f) }, pos.entry);
    const at = f.scored_at ?? Date.now();
    const barsHeld = Math.max(0, Math.floor((at - pos.enteredAt) / TF_MS[pos.tf]));
    repo.closeEntry(pos.entryId, at, exitPrice, 'scored', barsHeld);
    open.delete(pos.entryId);
  }
}

/* Grid combinations advance ONLY here, on closed bars: tick advancing doesn't
   touch them. This way every dataset row is computed the same way, per bar, rather
   than "however the poll timing happened to fall": for comparing combinations with each
   other, uniformity matters more than matching the live path, and the bias is the same for all.
   As a side effect, recording the signal is free: the bars are already in memory.
   ponytail: grid formations still live in scanner.db (~200 bytes per row,
   19 MB/day at 75 combinations). loadScoring() at startup will start to suffer first, since it
   reads the whole table; if that becomes noticeable, move grid formations into grid.db.

   sweep: catch-up on closed bars and TTL.
   Bars come from the last scan: with a TTL of 10 bars a formation lives
   inside the same ~400 bars the scan already downloaded, and no network is needed at all.
   The request budget is left only for backlog beyond the scan window (long downtime,
   a symbol outside the universe); the TTL is still finalized for all formations, not
   just the first ten, otherwise the grid would pile up records that never die. */
async function sweepScoring(): Promise<void> {
  const now = Date.now();
  let budget = 10;
  for (const s of [...scoringMap.values()]) {
    const tfMs = TF_MS[s.tf];
    const lastClosed = Math.floor(now / tfMs) * tfMs;        // boundary: bars closing at ≤ lastClosed are closed
    const hasNewBars = s.seenUntil < lastClosed && s.seenUntil < s.deadline;
    if (!hasNewBars) {
      /* everything up to the deadline is processed: the TTL can be finalized honestly */
      if (now > s.deadline && s.seenUntil >= s.deadline && scoring.finalizeTtl(s.st, s.deadline)) {
        await onScoreChanged(s, tickerMap.get(s.symbol)?.price ?? null);
      }
      continue;
    }
    const startTime = Math.floor(Math.max(s.detectedAt, s.seenUntil) / tfMs) * tfMs;
    let kl = scanBars.get(s.tf)?.get(s.symbol);
    const cov = scoring.scanCoverage(kl, startTime, lastClosed, tfMs);
    if (cov === 'lags-one-bar') continue;                    // the scan brings this bar within seconds
    if (cov === 'insufficient') {
      if (budget <= 0) continue;
      budget--; scoringFetches++;
      const limit = Math.min(1000, Math.ceil((Math.min(now, s.deadline) - startTime) / tfMs) + 2);
      try { kl = await adapter.klines(s.symbol, s.tf, limit, startTime); } catch { continue; }
    }
    if (!kl) continue;
    let changed = false;
    let lastPx: number | null = null;
    for (const k of kl) {
      const close = k.t + tfMs;
      if (close > now) break;                    // forming bar
      if (close <= s.seenUntil) continue;        // already processed
      if (k.t >= s.deadline) break;              // bar entirely after the deadline
      lastPx = k.c;
      if (close > s.detectedAt) changed = scoring.advance(s.st, s.dir, s.lv, k.l, k.h, close) || changed;
      s.seenUntil = close;
      changed = true;
      if (s.st.stage === 'final') break;
    }
    if (s.st.stage !== 'final' && now > s.deadline && s.seenUntil >= s.deadline) {
      changed = scoring.finalizeTtl(s.st, s.deadline) || changed;
    }
    if (changed) await onScoreChanged(s, lastPx);
  }
}

/* ═══ MFE/MAE CATCH-UP AT START ═══════════════════════════════
   While the app was off, the price kept moving. Extend MFE/MAE of open
   observations with the high/low of the missed bars; closing is done by the scoring
   sweep: it catches up on missed bars itself and dates the final score honestly. */
async function catchUpExcursions(): Promise<void> {
  const now = Date.now();
  let updated = 0;
  for (const pos of [...open.values()]) {
    const tfMs = TF_MS[pos.tf];
    const need = Math.min(1000, Math.ceil((now - pos.enteredAt) / tfMs) + 2);
    if (need < 2) continue;
    let kl: Kline[];
    try { kl = await adapter.klines(pos.symbol, pos.tf, need); } catch { continue; }
    const before = pos.mfePct + '/' + pos.maePct;
    for (const k of kl) {
      if (k.t + tfMs > now) break;                    // the forming bar is not counted
      if (k.t + tfMs <= pos.enteredAt) continue;      // bar entirely before the signal
      trackExcursions(pos, k.l, k.h);
    }
    if (pos.mfePct + '/' + pos.maePct !== before) updated++;
  }
  lastReplay = { at: now, updatedPositions: updated };
}

/* ═══ LOOP 3: UNIVERSE ═══════════════════════════════════════ */
async function refreshUniverse(): Promise<void> {
  const tks = await adapter.tickers();
  tickerMap.clear();
  for (const t of tks) if (instruments.has(t.symbol)) tickerMap.set(t.symbol, t);
  for (const p of repo.listProfiles()) {
    if (!p.enabled) { universes.delete(p.name); continue; }
    let list = [...tickerMap.values()].sort((a, b) => b.vol - a.vol);
    if (p.params.min_vol24 > 0) list = list.filter(t => t.vol >= p.params.min_vol24);
    if (p.params.top_n > 0) list = list.slice(0, p.params.top_n);
    universes.set(p.name, list.map(t => t.symbol));
  }
}

/* ═══ LOOP 1: PATTERN SCAN (at the TF bar close) ═════════════ */
function scheduleScan(tf: TF): void {
  const it = repo.getIntensity();
  const period = TF_MS[tf];
  const wait = period - (Date.now() % period) + Math.max(0, it.scan_delay_sec) * 1000;
  const t = setTimeout(() => {
    scanTimers.delete(tf);
    if (!running) return;
    runScans(tf).catch(e => { lastError = String(e); }).finally(() => scheduleScan(tf));
  }, wait);
  scanTimers.set(tf, t);
}

/* TF scan: first one parallel bar download for all profiles and combinations of
   this TF, then a pure detector run over the shared array.
   Previously bars were downloaded in a loop over symbols inside each profile: 150 symbols
   × 0.3 s ≈ 45 s of a five-minute bar, and every profile downloaded them again. */
async function runScans(tf: TF): Promise<void> {
  if (scanning.has(tf)) return;
  scanning.add(tf);
  try {
    /* each enabled profile of this TF expands into combinations (without a grid, into itself) */
    const byProfile: Array<{ base: string; combos: Combo[] }> = [];
    const need = new Set<string>();
    let maxRange = 0;
    for (const p of repo.listProfiles()) {
      if (!p.enabled || p.params.tf !== tf) continue;
      let combos: Combo[];
      try { combos = expandGrid(p.name, p.params); }
      catch (e) { lastError = String(e); continue; }        // a broken grid doesn't take down the other profiles
      byProfile.push({ base: p.name, combos });
      for (const c of combos) maxRange = Math.max(maxRange, c.params.search_range);
      for (const s of universes.get(p.name) ?? []) need.add(s);
    }
    if (!need.size) return;

    /* the union of symbols is downloaded once, at the deepest depth:
       the detector takes the last search_range bars, so a long array
       serves any smaller window. Concurrency is held by the queue (cap 16). */
    const limit = Math.min(1000, maxRange + 2);
    const bars = new Map<string, Kline[]>();
    await Promise.all([...need].map(async sym => {
      try {
        const kl = await adapter.klines(sym, tf, limit);
        if (kl.length >= 3) bars.set(sym, kl);
      } catch { /* a single failure doesn't take down the scan */ }
    }));
    if (!running) return;

    /* the same bars serve scoring. The last one is dropped: at download time
       it was still forming, so its high/low are not final yet. */
    scanBars.set(tf, new Map([...bars].map(([sym, kl]) => [sym, kl.slice(0, -1)])));

    /* all inserts of the pass in one transaction: one by one, hundreds of commits
       stall the loop. scoringMap is filled only after a successful commit:
       a rolled-back transaction must not leave formations in memory that aren't in the DB. */
    const at = Date.now();
    const fresh: ScoringItem[] = [];
    repo.tx(() => {
      for (const { base, combos } of byProfile) {
        const uni = universes.get(base) ?? [];
        for (const c of combos) scanCombo(c.name, c.params, uni, bars, at, fresh);
        lastScanAt.set(base, at);
      }
    });
    for (const s of fresh) scoringMap.set(s.id, s);
    /* tracking runs once per symbol: it doesn't depend on the number of combinations */
    trackClosedBar(tf, bars);
  } finally { scanning.delete(tf); }
}

/* run one combination over the already downloaded bars: pure computation plus a write */
function scanCombo(name: string, prof: ProfileParams, uni: string[], bars: Map<string, Kline[]>, at: number, out: ScoringItem[]): void {
  for (const sym of uni) {
    const kl = bars.get(sym);
    if (!kl) continue;

    /* new pattern: goes to scoring; a record appears once scoring fires a signal */
    const pat = detectPattern(kl, prof.search_range, prof);
    if (!pat) continue;

    const fid = `${name}|${adapter.exchange}|${adapter.market}|${sym}|${prof.tf}|${pat.A.t}|${pat.dir}`;
    /* INSERT OR IGNORE drops a duplicate by itself: no separate existence check needed */
    const fresh = repo.insertFormation({
      id: fid, exchange: adapter.exchange, market: adapter.market, symbol: sym, tf: prof.tf, dir: pat.dir,
      ts_A: pat.A.t, price_A: pat.A.p, ts_B: pat.B.t, price_B: pat.B.p, ts_C: pat.C.t, price_C: pat.C.p,
      k1: prof.k1, k2: prof.k2, k3: prof.k3, search_range: prof.search_range,
      status: 'armed', detected_at: at, score_ttl_bars: prof.score_ttl_bars,
    });
    if (!fresh) continue;

    out.push({
      id: fid, symbol: sym, tf: prof.tf, dir: pat.dir,
      lv: { A: pat.A.p, B: pat.B.p, ...pat.levels },
      detectedAt: at,
      deadline: at + prof.score_ttl_bars * TF_MS[prof.tf],
      seenUntil: at,
      st: scoring.freshScore(),
      hasEntry: false,
      isGrid: isCombo(name),
      card: { A: pat.A, B: pat.B, levels: pat.levels },
    });
  }
}

/* MFE/MAE of open observations on the second-to-last (last closed) scan bar */
function trackClosedBar(tf: TF, bars: Map<string, Kline[]>): void {
  for (const pos of [...open.values()]) {
    if (pos.tf !== tf) continue;                            // bars of another TF don't fit this observation
    const kl = bars.get(pos.symbol);
    if (!kl) continue;
    const prev = kl[kl.length - 2];
    if (prev.t + TF_MS[tf] <= pos.enteredAt) continue;      // bar entirely before the signal
    trackExcursions(pos, prev.l, prev.h);
  }
}

/* ═══ LOOP 2: TRACKING (tickers every track_sec) ═════════════ */
async function trackTick(): Promise<void> {
  if (!running || tracking) return;
  tracking = true;
  try {
    const tks = await adapter.tickers();
    for (const t of tks) if (instruments.has(t.symbol)) tickerMap.set(t.symbol, t);

    /* open observations: excursions on the price */
    for (const pos of [...open.values()]) {
      const price = tickerMap.get(pos.symbol)?.price;
      if (price) trackExcursions(pos, price, price);
    }

    /* scoring: first the closed-bar sweep, then ticks, and only for formations
       whose bar backlog is caught up (otherwise a tick "runs ahead" of history
       and scores on the current price, skipping the path to it) */
    await sweepScoring();
    const now = Date.now();
    for (const s of [...scoringMap.values()]) {
      if (s.isGrid) continue;                          // see the comment above sweepScoring: the grid lives on closed bars only
      if (now > s.deadline) continue;                  // finalized by the bar sweep (honest date)
      const lastClosed = Math.floor(now / TF_MS[s.tf]) * TF_MS[s.tf];
      if (lastClosed > s.seenUntil) continue;          // there are unprocessed closed bars
      const price = tickerMap.get(s.symbol)?.price;
      if (!price) continue;
      if (scoring.advance(s.st, s.dir, s.lv, price, price, now)) await onScoreChanged(s, price);
    }

    await sweepAfter();
    await sweepScoredSnapshots();
  } finally { tracking = false; }
}

/* ── klines_after add-on: pattern-TF bars from the signal bar
   to the bar where the score became final (no tail), written once that bar has closed ── */
async function sweepAfter(): Promise<void> {
  const now = Date.now();
  for (const e of repo.listEntriesNeedingAfter(10)) {           // up to 10 per tick: no request bursts
    const tf = e.tf as TF;
    const tfMs = TF_MS[tf];
    if (Math.floor((e.exited_at - 1) / tfMs) * tfMs + tfMs > now) continue;   // the final-score bar is still forming
    const startTime = Math.floor(e.entered_at / tfMs) * tfMs;
    const limit = Math.min(1000, Math.ceil((e.exited_at - startTime) / tfMs) + 2);
    let kl: Kline[];
    try { kl = await adapter.klines(e.symbol, tf, limit, startTime); } catch { continue; }
    const slice = kl.filter(k => k.t + tfMs > e.entered_at && k.t < e.exited_at);
    if (!slice.length) continue;                                 // rare data glitch: retry on the next tick
    const body: AfterBody = { schema_version: 1, written_at: now, tf, klines: slice };
    repo.saveBodyAfter(e.id, encodeGzJson(body));
  }
}

/* ── snapshot at the final score: the container is built by the sweeper after the
   observation closes (usually within one tracking tick; on failure, retried on the next) ── */
async function sweepScoredSnapshots(): Promise<void> {
  for (const e of repo.listEntriesNeedingScoredSnapshot(3)) {   // the container is heavy: up to 3 per tick
    if (!e.formation_id) continue;
    const f = repo.getFormation(e.formation_id);
    const entry = repo.getEntry(e.id);
    if (!f || !entry || f.score_stage !== 'final') continue;
    const { name: profileName, params: prof } = profileOfFormation(f);
    const inst = instruments.get(e.symbol) ?? { symbol: e.symbol, tickSize: null, base: '', quote: 'USDT' };
    try {
      const snap = await buildSnapshot({
        adapter, instrument: inst, ticker: tickerMap.get(e.symbol) ?? null,
        profileName, profile: prof,
        pattern: fullPatternOf(f),
        entry: { price: entry.entry_price, ts: entry.entered_at, side: entry.dir },
        cfg: repo.getSnapshotCfg(),
        kind: 'scored',
        scored: { score: f.score ?? 0, scored_at: f.scored_at ?? 0, signal_at: f.score_signal_at },
      });
      repo.saveBodyScored(e.id, snap.gz);
    } catch { /* retry on the next tick */ }
  }
}

/* ═══ SIGNAL RECORDING ═══════════════════════════════════════
   entered_at = signal moment (a tick, or the bar close during a sweep/catch-up),
   the signal price is set by scoring. The snapshot is built at processing time. */
async function createSignalEntry(s: ScoringItem): Promise<void> {
  if (s.hasEntry || entering.has(s.id)) return;
  if (s.isGrid) { createGridSignal(s); return; }
  entering.add(s.id);
  try {
    const f = repo.getFormation(s.id);
    if (!f) { s.hasEntry = true; return; }             // no pattern: nothing to journal
    const { name: profileName, params: prof } = profileOfFormation(f);
    const inst = instruments.get(s.symbol) ?? { symbol: s.symbol, tickSize: null, base: '', quote: 'USDT' };
    const at = s.st.signalAt ?? Date.now();
    const price = scoring.signalPrice(s.lv);

    /* the snapshot is built BEFORE the observation is written → observation + snapshot go in one transaction */
    const snap = await buildSnapshot({
      adapter, instrument: inst, ticker: tickerMap.get(s.symbol) ?? null,
      profileName, profile: prof,
      pattern: fullPatternOf(f),
      entry: { price, ts: at, side: s.dir },
      cfg: repo.getSnapshotCfg(),
      kind: 'signal',
    });

    const entryId = repo.insertEntryWithSnapshot({
      formation_id: s.id, exchange: adapter.exchange, market: adapter.market,
      symbol: s.symbol, tf: s.tf, dir: s.dir,
      entered_at: at, entry_price: price,
    }, SNAPSHOT_SCHEMA_VERSION, at, snap.gz);

    open.set(entryId, {
      entryId, formationId: s.id, symbol: s.symbol, tf: s.tf, dir: s.dir,
      entry: price,
      enteredAt: at, mfePct: 0, maePct: 0,
      pattern: s.card,
    });
    s.hasEntry = true;
  } catch (e) {
    lastError = 'signal not recorded: ' + String(e);   // hasEntry stays false: retried on the next advance
  } finally {
    entering.delete(s.id);
  }
}

/* ═══ GRID COMBINATION SIGNAL ════════════════════════════════
   No snapshot and no journal entry: a short row goes to data/grid.db,
   the signal and later the score. 125 combinations on one market event would produce
   125 nearly identical containers (4.5 GB a day). Recording the signal costs
   not a single request to the exchange. */
function createGridSignal(s: ScoringItem): void {
  const f = repo.getFormation(s.id);
  if (!f) { s.hasEntry = true; return; }
  const at = s.st.signalAt ?? Date.now();
  try {
    grid.insertSignal({
      formation_id: s.id,
      profile: baseProfileName(f.id.split('|')[0]),
      combo: f.id.split('|')[0],
      k1: f.k1, k2: f.k2, search_range: f.search_range,
      symbol: s.symbol, tf: s.tf, dir: s.dir,
      entered_at: at, entry_price: scoring.signalPrice(s.lv),
    });
    repo.markTriggered(s.id);
    s.hasEntry = true;
  } catch (e) {
    lastError = 'grid signal not recorded: ' + String(e);   // hasEntry stays false: retried on the next advance
  }
}

/* the signal fired but there is no record (downtime or a write failure): record it now */
async function reconcileMissingEntries(): Promise<void> {
  for (const s of [...scoringMap.values()]) {
    if (!s.hasEntry && s.st.signalAt != null) await createSignalEntry(s);
  }
}

function trackExcursions(pos: OpenPos, lo: number, hi: number): void {
  const { mfePct, maePct } = trade.updateExcursions(pos.dir, pos.entry, lo, hi, pos.mfePct, pos.maePct);
  if (mfePct !== pos.mfePct || maePct !== pos.maePct) {
    pos.mfePct = mfePct; pos.maePct = maePct;
    repo.updateEntryExcursions(pos.entryId, mfePct, maePct);
  }
}
