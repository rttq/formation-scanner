/* Движок сканера. Обнаруженный паттерн ставится под скоринг (оценка 0–4).
   Когда скоринг гипотезы фиксирует сигнал, создаётся запись наблюдения со
   снапшотом; паттерны без сигнала в журнал не попадают — только в скоринг.
   Фиксация оценки закрывает запись и получает второй снапшот.
   Контуры:
   1) скан формаций — по закрытию бара рабочего ТФ (+ задержка);
   2) сопровождение — каждые track_sec: один запрос tickers на всё;
   3) вселенная — каждые universe_min минут. */
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

/* открытое наблюдение (от сигнала до оценки) */
interface OpenPos {
  entryId: number;
  formationId: string | null;
  symbol: string; tf: TF; dir: Dir;
  entry: number;
  enteredAt: number;
  mfePct: number; maePct: number;
  /* точки и уровни формации — для отрисовки на карточках живого сканера */
  pattern: CardPattern | null;
}

interface CardPattern {
  A: { p: number; t: number }; B: { p: number; t: number };
  levels: Levels;
}

/* паттерн под скорингом */
interface ScoringItem {
  id: string;
  symbol: string; tf: TF; dir: Dir;
  lv: scoring.ScoreLevels;
  detectedAt: number;
  deadline: number;          // detectedAt + score_ttl_bars × tfMs
  seenUntil: number;         // закрытие последнего обработанного бара
  st: scoring.ScoreState;
  hasEntry: boolean;         // сигнал уже записан
  isGrid: boolean;           // комбинация сетки: строка в grid.db вместо журнала и снапшота
  card: CardPattern;         // точки/уровни для карточек живого сканера
}

const adapter = binanceFut;

let running = false;
let instruments = new Map<string, Instrument>();
const tickerMap = new Map<string, Ticker>();
const universes = new Map<string, string[]>();      // profileName -> symbols
const open = new Map<number, OpenPos>();
const scoringMap = new Map<string, ScoringItem>();
const entering = new Set<string>();                 // защита от двойной записи сигнала
const lastScanAt = new Map<string, number>();       // profileName -> ts

/* бары последнего скана по ТФ, только закрытые — ими двигается скоринг */
const scanBars = new Map<TF, Map<string, Kline[]>>();
/* сколько раз скоринг всё же полез в сеть: при живой сетке должно стоять почти
   на месте — иначе бары скана не покрывают бэклог и экономия запросов не работает */
let scoringFetches = 0;

let universeTimer: NodeJS.Timeout | null = null;
let trackTimer: NodeJS.Timeout | null = null;
const scanTimers = new Map<TF, NodeJS.Timeout>();
let tracking = false;
const scanning = new Set<TF>();
let lastError: string | null = null;
let lastReplay: { at: number; updatedPositions: number } | null = null;

/* цены уровней паттерна из строки БД */
function levelsOf(f: repo.FormationRow): Levels {
  return levelPrices(f.dir, f.price_A, f.price_B, { k1: f.k1, k2: f.k2, k3: f.k3 });
}
function cardPatternOf(f: repo.FormationRow | undefined): CardPattern | null {
  if (!f) return null;
  return { A: { p: f.price_A, t: f.ts_A }, B: { p: f.price_B, t: f.ts_B }, levels: levelsOf(f) };
}
/* параметры профиля для формации. Имя профиля хранится в её id; у комбинации сетки
   (`base#H..Q..R..`) собственного профиля в таблице нет, поэтому база берётся по
   базовому имени, а перебираемые ключи — из самой строки формации. Тот же путь
   покрывает и удалённый профиль: базы нет → остаются дефолты. */
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

/* ═══ СТАРТ / СТОП ═══════════════════════════════════════════ */
export async function start(): Promise<void> {
  if (running) return;
  lastError = null;
  instruments = await adapter.instruments();
  await refreshUniverse();
  restoreFromDb();
  loadScoring();
  reconcileScored();               // наблюдения, чья оценка финализировалась в простое, закрываются сразу
  await reconcileMissingEntries(); // сигналы, случившиеся в простое/при сбое — дозаписываем
  await catchUpExcursions();       // MFE/MAE за время простоя (закрытия сделает свип скоринга)
  running = true;

  const it = repo.getIntensity();
  universeTimer = setInterval(() => { refreshUniverse().catch(e => { lastError = String(e); }); }, Math.max(1, it.universe_min) * 60_000);
  trackTimer = setInterval(() => { trackTick().catch(e => { lastError = String(e); }); }, Math.max(5, it.track_sec) * 1000);
  for (const tf of enabledTfs()) scheduleScan(tf);
  /* первый скан — сразу, не дожидаясь закрытия бара */
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

/* состояние для живого сканера: наблюдения со стадией скоринга */
export function scannerState() {
  const t = (sym: string) => {
    const x = tickerMap.get(sym);
    return x ? { price: x.price, chg: x.chg, vol: x.vol } : null;
  };
  return {
    running,
    /* паттерны в ожидании сигнала */
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

/* ── восстановление состояния из БД после перезапуска ────────── */
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

/* ═══ СКОРИНГ ═════════════════════════════════════════════════
   Тик 30с двигает автомат по текущей цене, свип докручивает закрытые
   бары (high/low — тики между опросами пропускают тени) и TTL; после простоя
   свип сам догоняет пропущенное. Фиксация оценки (стадия final) закрывает
   наблюдение: exited_at = момент фиксации, exit_reason = 'scored'. */
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

/* продвижка скоринга изменила состояние: сначала сигнал, затем сохранение
   и, если финал, закрытие наблюдения */
async function onScoreChanged(s: ScoringItem, refPrice: number | null): Promise<void> {
  if (!s.hasEntry && s.st.signalAt != null) await createSignalEntry(s);
  persistScore(s, refPrice);
}

/* refPrice — «цена рядом с фиксацией» (close бара или тик) для выходов по TTL */
function persistScore(s: ScoringItem, refPrice: number | null): void {
  repo.updateFormationScore(s.id, {
    score: s.st.score, score_stage: s.st.stage, score_signal_at: s.st.signalAt,
    scored_at: s.st.scoredAt, score_seen_until: s.seenUntil,
  });
  if (s.st.stage === 'final') {
    if (s.isGrid) {
      /* строка сетки получает свою оценку; журнала и снапшота у сетки нет */
      if (s.hasEntry) grid.setScore(s.id, s.st.score ?? 0, s.st.scoredAt ?? Date.now());
      else repo.resolveFormation(s.id, 'expired', `без сигнала — оценка ${s.st.score ?? 0}`);
    } else if (s.hasEntry) closeByScore(s, refPrice);
    else repo.resolveFormation(s.id, 'expired', `без сигнала — оценка ${s.st.score ?? 0}`);
    scoringMap.delete(s.id);
  }
}

/* фиксация оценки закрывает наблюдение; цену выхода по оценке даёт скоринг */
function closeByScore(s: ScoringItem, refPrice: number | null): void {
  const pos = [...open.values()].find(p => p.formationId === s.id);
  if (!pos) return;                                  // наблюдения нет (легаси-формация)
  const score = s.st.score ?? 0;
  const exitPrice = scoring.exitPrice(score, s.lv, refPrice ?? tickerMap.get(s.symbol)?.price ?? pos.entry);
  const at = s.st.scoredAt ?? Date.now();
  const barsHeld = Math.max(0, Math.floor((at - pos.enteredAt) / TF_MS[pos.tf]));
  repo.closeEntry(pos.entryId, at, exitPrice, 'scored', barsHeld);
  open.delete(pos.entryId);
}

/* открытые наблюдения с уже финализированной оценкой (финал случился в простое)
   — закрываем по данным паттерна */
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

/* Комбинации сетки двигаются ТОЛЬКО здесь, по закрытым барам — тиковая продвижка
   их не касается. Так каждая строка датасета посчитана одинаково, по бару, а не
   «как повезло с моментом опроса»: для сравнения комбинаций между собой
   единообразие важнее совпадения с живым путём, а смещение у всех одно и то же.
   Побочно это делает запись сигнала бесплатной — бары уже в памяти.
   ponytail: формации сетки по-прежнему лежат в scanner.db (~200 байт на строку,
   19 МБ/сут при 75 комбинациях). Мешать начнёт loadScoring() на старте, он читает
   всю таблицу; если станет заметно — переселить formations сетки в grid.db.

   свип: докрутка закрытых баров и TTL.
   Бары берутся из последнего скана — при TTL в 10 баров формация живёт
   внутри тех же ~400 баров, что скан уже скачал, и сеть не нужна вовсе.
   Бюджет запросов остался только на бэклог за окном скана (долгий простой,
   монета вне вселенной); TTL при этом финализируется у всех формаций, а не
   у первых десяти — иначе сетка копила бы вечно живущие записи. */
async function sweepScoring(): Promise<void> {
  const now = Date.now();
  let budget = 10;
  for (const s of [...scoringMap.values()]) {
    const tfMs = TF_MS[s.tf];
    const lastClosed = Math.floor(now / tfMs) * tfMs;        // граница: бары с закрытием ≤ lastClosed уже закрыты
    const hasNewBars = s.seenUntil < lastClosed && s.seenUntil < s.deadline;
    if (!hasNewBars) {
      /* всё до дедлайна обработано — TTL можно финализировать честно */
      if (now > s.deadline && s.seenUntil >= s.deadline && scoring.finalizeTtl(s.st, s.deadline)) {
        await onScoreChanged(s, tickerMap.get(s.symbol)?.price ?? null);
      }
      continue;
    }
    const startTime = Math.floor(Math.max(s.detectedAt, s.seenUntil) / tfMs) * tfMs;
    let kl = scanBars.get(s.tf)?.get(s.symbol);
    const cov = scoring.scanCoverage(kl, startTime, lastClosed, tfMs);
    if (cov === 'lags-one-bar') continue;                    // скан принесёт этот бар через секунды
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
      if (close > now) break;                    // формирующийся бар
      if (close <= s.seenUntil) continue;        // уже обработан
      if (k.t >= s.deadline) break;              // бар целиком после дедлайна
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

/* ═══ ДОГОН MFE/MAE ПРИ СТАРТЕ ═══════════════════════════════
   Пока приложение было выключено, цена жила своей жизнью. Дополняем MFE/MAE
   открытых наблюдений по high/low пропущенных баров; закрытия делает свип
   скоринга — он сам догоняет пропущенные бары и датирует фиксацию честно. */
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
      if (k.t + tfMs > now) break;                    // формирующийся бар не считаем
      if (k.t + tfMs <= pos.enteredAt) continue;      // бар целиком до сигнала
      trackExcursions(pos, k.l, k.h);
    }
    if (pos.mfePct + '/' + pos.maePct !== before) updated++;
  }
  lastReplay = { at: now, updatedPositions: updated };
}

/* ═══ КОНТУР 3: ВСЕЛЕННАЯ ════════════════════════════════════ */
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

/* ═══ КОНТУР 1: СКАН ФОРМАЦИЙ (по закрытию бара ТФ) ══════════ */
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

/* Скан ТФ: сначала одна параллельная закачка баров на все профили и комбинации
   этого ТФ, затем чистый прогон детектора по общему массиву.
   Раньше бары качались в цикле по символам внутри каждого профиля: 150 символов
   × 0,3 с ≈ 45 с из пятиминутного бара, и каждый профиль качал их заново. */
async function runScans(tf: TF): Promise<void> {
  if (scanning.has(tf)) return;
  scanning.add(tf);
  try {
    /* каждый включённый профиль ТФ разворачивается в комбинации (без сетки — сам в себя) */
    const byProfile: Array<{ base: string; combos: Combo[] }> = [];
    const need = new Set<string>();
    let maxRange = 0;
    for (const p of repo.listProfiles()) {
      if (!p.enabled || p.params.tf !== tf) continue;
      let combos: Combo[];
      try { combos = expandGrid(p.name, p.params); }
      catch (e) { lastError = String(e); continue; }        // битая сетка не валит остальные профили
      byProfile.push({ base: p.name, combos });
      for (const c of combos) maxRange = Math.max(maxRange, c.params.search_range);
      for (const s of universes.get(p.name) ?? []) need.add(s);
    }
    if (!need.size) return;

    /* объединение символов качается один раз и самой глубокой выборкой —
       детектор берёт последние search_range баров, поэтому длинный массив
       обслуживает любое меньшее окно. Параллелизм держит очередь (потолок 16). */
    const limit = Math.min(1000, maxRange + 2);
    const bars = new Map<string, Kline[]>();
    await Promise.all([...need].map(async sym => {
      try {
        const kl = await adapter.klines(sym, tf, limit);
        if (kl.length >= 3) bars.set(sym, kl);
      } catch { /* единичный сбой не валит скан */ }
    }));
    if (!running) return;

    /* те же бары обслуживают скоринг. Последний отбрасывается — на момент
       скачивания он формировался, его high/low ещё не окончательные. */
    scanBars.set(tf, new Map([...bars].map(([sym, kl]) => [sym, kl.slice(0, -1)])));

    /* все вставки прохода одной транзакцией — поодиночке сотни коммитов
       подвешивают цикл. scoringMap пополняется только после успешного коммита:
       откат транзакции не должен оставить в памяти формации, которых нет в БД. */
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
    /* сопровождение — один раз на символ: не зависит от числа комбинаций */
    trackClosedBar(tf, bars);
  } finally { scanning.delete(tf); }
}

/* прогон одной комбинации по уже скачанным барам — чистый расчёт плюс запись */
function scanCombo(name: string, prof: ProfileParams, uni: string[], bars: Map<string, Kline[]>, at: number, out: ScoringItem[]): void {
  for (const sym of uni) {
    const kl = bars.get(sym);
    if (!kl) continue;

    /* новый паттерн: под скоринг; запись появится, когда скоринг зафиксирует сигнал */
    const pat = detectPattern(kl, prof.search_range, prof);
    if (!pat) continue;

    const fid = `${name}|${adapter.exchange}|${adapter.market}|${sym}|${prof.tf}|${pat.A.t}|${pat.dir}`;
    /* INSERT OR IGNORE сам отбрасывает дубль — отдельная проверка существования не нужна */
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

/* MFE/MAE открытых наблюдений по предпоследнему (последнему закрытому) бару скана */
function trackClosedBar(tf: TF, bars: Map<string, Kline[]>): void {
  for (const pos of [...open.values()]) {
    if (pos.tf !== tf) continue;                            // бары чужого ТФ этой позиции не подходят
    const kl = bars.get(pos.symbol);
    if (!kl) continue;
    const prev = kl[kl.length - 2];
    if (prev.t + TF_MS[tf] <= pos.enteredAt) continue;      // бар целиком до сигнала
    trackExcursions(pos, prev.l, prev.h);
  }
}

/* ═══ КОНТУР 2: СОПРОВОЖДЕНИЕ (тикеры каждые track_sec) ══════ */
async function trackTick(): Promise<void> {
  if (!running || tracking) return;
  tracking = true;
  try {
    const tks = await adapter.tickers();
    for (const t of tks) if (instruments.has(t.symbol)) tickerMap.set(t.symbol, t);

    /* открытые наблюдения: экскурсии по цене */
    for (const pos of [...open.values()]) {
      const price = tickerMap.get(pos.symbol)?.price;
      if (price) trackExcursions(pos, price, price);
    }

    /* скоринг: сначала свип закрытых баров, затем тики — и только для формаций,
       у которых бэклог баров догнан (иначе тик «забегает вперёд» истории
       и оценивает по текущей цене, пропустив путь до неё) */
    await sweepScoring();
    const now = Date.now();
    for (const s of [...scoringMap.values()]) {
      if (s.isGrid) continue;                          // см. комментарий у sweepScoring: сетка живёт только по закрытым барам
      if (now > s.deadline) continue;                  // финализирует свип по барам (честная дата)
      const lastClosed = Math.floor(now / TF_MS[s.tf]) * TF_MS[s.tf];
      if (lastClosed > s.seenUntil) continue;          // есть необработанные закрытые бары
      const price = tickerMap.get(s.symbol)?.price;
      if (!price) continue;
      if (scoring.advance(s.st, s.dir, s.lv, price, price, now)) await onScoreChanged(s, price);
    }

    await sweepAfter();
    await sweepScoredSnapshots();
  } finally { tracking = false; }
}

/* ── дозапись klines_after: бары рабочего ТФ от бара сигнала
   до бара фиксации оценки (без хвоста), пишется когда бар фиксации закрылся ── */
async function sweepAfter(): Promise<void> {
  const now = Date.now();
  for (const e of repo.listEntriesNeedingAfter(10)) {           // до 10 за тик — без всплесков запросов
    const tf = e.tf as TF;
    const tfMs = TF_MS[tf];
    if (Math.floor((e.exited_at - 1) / tfMs) * tfMs + tfMs > now) continue;   // бар фиксации ещё формируется
    const startTime = Math.floor(e.entered_at / tfMs) * tfMs;
    const limit = Math.min(1000, Math.ceil((e.exited_at - startTime) / tfMs) + 2);
    let kl: Kline[];
    try { kl = await adapter.klines(e.symbol, tf, limit, startTime); } catch { continue; }
    const slice = kl.filter(k => k.t + tfMs > e.entered_at && k.t < e.exited_at);
    if (!slice.length) continue;                                 // редкий сбой данных — повторим в следующий тик
    const body: AfterBody = { schema_version: 1, written_at: now, tf, klines: slice };
    repo.saveBodyAfter(e.id, encodeGzJson(body));
  }
}

/* ── снапшот на фиксации оценки: контейнер собирается свипером после закрытия
   наблюдения (обычно в течение одного трек-тика; сбой — повтор в следующий) ── */
async function sweepScoredSnapshots(): Promise<void> {
  for (const e of repo.listEntriesNeedingScoredSnapshot(3)) {   // контейнер тяжёлый — до 3 за тик
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
    } catch { /* повторим в следующий тик */ }
  }
}

/* ═══ ЗАПИСЬ СИГНАЛА ══════════════════════════════════════════
   entered_at = момент сигнала (тик или close бара при свипе/догоне),
   цену сигнала задаёт скоринг. Снапшот собирается в момент обработки. */
async function createSignalEntry(s: ScoringItem): Promise<void> {
  if (s.hasEntry || entering.has(s.id)) return;
  if (s.isGrid) { createGridSignal(s); return; }
  entering.add(s.id);
  try {
    const f = repo.getFormation(s.id);
    if (!f) { s.hasEntry = true; return; }             // паттерна нет — журналить нечего
    const { name: profileName, params: prof } = profileOfFormation(f);
    const inst = instruments.get(s.symbol) ?? { symbol: s.symbol, tickSize: null, base: '', quote: 'USDT' };
    const at = s.st.signalAt ?? Date.now();
    const price = scoring.signalPrice(s.lv);

    /* снапшот собирается ДО записи наблюдения → наблюдение+снапшот пишутся одной транзакцией */
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
    lastError = 'сигнал не записан: ' + String(e);     // hasEntry остаётся false — повтор при следующей продвижке
  } finally {
    entering.delete(s.id);
  }
}

/* ═══ СИГНАЛ КОМБИНАЦИИ СЕТКИ ════════════════════════════════
   Ни снапшота, ни записи в журнал: в data/grid.db уходит короткая строка —
   сигнал и позже оценка. 125 комбинаций на одном событии рынка дали бы
   125 почти одинаковых контейнеров (4,5 ГБ в сутки). Запись сигнала не стоит
   ни одного запроса к бирже. */
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
    lastError = 'сигнал сетки не записан: ' + String(e);   // hasEntry остаётся false — повтор при следующей продвижке
  }
}

/* сигнал случился, но записи нет (простой или сбой при записи) — дозаписываем */
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
