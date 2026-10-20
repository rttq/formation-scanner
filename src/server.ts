import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dbFile, tableCount } from './db/index.js';
import * as repo from './db/repo.js';
import { queueStats } from './core/queue.js';
import { binanceFut } from './core/exchanges/binance-fut.js';
import { TF_LIST, type TF } from './core/exchanges/types.js';
import { detectPattern, validCoefs } from './core/detector.js';
import { PROFILE_DEFAULTS as D } from './core/config.js';
import { decodeSnapshot, decodeGzJson } from './core/snapshot.js';
import * as engine from './core/engine.js';
import * as grid from './grid/store.js';
import { saveApiKey, listApiKeys, deleteApiKey } from './keys/vault.js';
import { verifyBinanceKey } from './core/exchanges/binance-signed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();

repo.seedDefaults();

const app = Fastify({ logger: false });
app.register(fastifyStatic, { root: path.resolve(__dirname, '../web') });

type Q = Record<string, string | undefined>;

/* ── здоровье ────────────────────────────────────────────────── */
app.get('/api/health', () => ({
  ok: true,
  version: '0.2.0',
  uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  db: { file: dbFile, tables: tableCount() },
  queue: queueStats(),
  engine: engine.status(),
}));

/* ── рыночные данные ─────────────────────────────────────────── */
app.get('/api/market/ping', async () => binanceFut.ping());

app.get('/api/market/klines', async (req, reply) => {
  const q = req.query as Q;
  const symbol = (q.symbol ?? '').toUpperCase();
  const tf = q.tf as TF;
  const limit = Math.min(1000, Math.max(2, parseInt(q.limit ?? '120', 10) || 120));
  const start = q.start ? parseInt(q.start, 10) : undefined;   // бары от момента (для просмотра развития)
  if (!symbol) return reply.code(400).send({ error: 'параметр symbol обязателен' });
  if (!TF_LIST.includes(tf)) return reply.code(400).send({ error: `tf должен быть одним из: ${TF_LIST.join(', ')}` });
  const klines = await binanceFut.klines(symbol, tf, limit, start);
  return { symbol, tf, count: klines.length, klines };
});

/* ── детектор на живых данных: проверка гипотезы на одной монете ── */
app.get('/api/scan/symbol', async (req, reply) => {
  const q = req.query as Q;
  const symbol = (q.symbol ?? '').toUpperCase();
  const tf = (q.tf ?? D.tf) as TF;
  const range = Math.max(2, parseInt(q.range ?? '', 10) || D.search_range);
  const k = {
    k1: q.k1 ? parseFloat(q.k1) : D.k1,
    k2: q.k2 ? parseFloat(q.k2) : D.k2,
    k3: q.k3 ? parseFloat(q.k3) : D.k3,
  };
  if (!symbol) return reply.code(400).send({ error: 'параметр symbol обязателен' });
  if (!TF_LIST.includes(tf)) return reply.code(400).send({ error: `tf должен быть одним из: ${TF_LIST.join(', ')}` });
  if (!validCoefs(k)) return reply.code(400).send({ error: 'коэффициенты не приняты гипотезой' });
  const klines = await binanceFut.klines(symbol, tf, Math.min(1000, range + 2));
  const pattern = detectPattern(klines, range, k);
  return { symbol, tf, range, ...k, bars: klines.length, pattern };
});

/* ── скан-профили ────────────────────────────────────────────── */
app.get('/api/profiles', () => repo.listProfiles());
app.put('/api/profiles/:name', (req) => {
  const name = (req.params as { name: string }).name;
  const body = (req.body ?? {}) as { enabled?: boolean } & Record<string, unknown>;
  const { enabled, ...params } = body;
  const existing = repo.getProfile(name);
  return repo.upsertProfile(name, { ...(existing?.params ?? {}), ...params }, enabled ?? existing?.enabled ?? true);
});
app.delete('/api/profiles/:name', (req, reply) => {
  const ok = repo.deleteProfile((req.params as { name: string }).name);
  return ok ? { ok: true } : reply.code(404).send({ error: 'профиль не найден' });
});

/* ── настройки ───────────────────────────────────────────────── */
app.get('/api/settings/:key', (req) => {
  const key = (req.params as { key: string }).key;
  return { key, value: repo.getSetting<unknown>(key, null) };
});
app.put('/api/settings/:key', (req) => {
  const key = (req.params as { key: string }).key;
  repo.setSetting(key, req.body);
  return { key, value: req.body };
});

/* ── паттерны и наблюдения ───────────────────────────────────── */
app.get('/api/formations', (req) => {
  const q = req.query as Q;
  return repo.listFormations(q.status, Math.min(1000, parseInt(q.limit ?? '100', 10) || 100));
});

/* журнал: наблюдения от сигнала с оценками скоринга */
app.get('/api/entries', (req) => {
  const q = req.query as Q;
  return repo.listEntries({
    status: q.status, symbol: q.symbol, dir: q.dir, score: q.score,
    from: q.from ? parseInt(q.from, 10) : undefined,
    to: q.to ? parseInt(q.to, 10) : undefined,
    limit: parseInt(q.limit ?? '500', 10) || 500,
  });
});
app.get('/api/entries/:id', (req, reply) => {
  const e = repo.getEntry(parseInt((req.params as { id: string }).id, 10));
  return e ?? reply.code(404).send({ error: 'наблюдение не найдено' });
});

/* ── снапшоты наблюдения: на сигнале и на фиксации оценки ────── */
app.get('/api/entries/:id/snapshot', (req, reply) => {
  const id = parseInt((req.params as { id: string }).id, 10);
  const gz = repo.getSnapshotBody(id);
  if (!gz) return reply.code(404).send({ error: 'снапшот не найден' });
  return decodeSnapshot(gz);
});
app.get('/api/entries/:id/snapshot-scored', (req, reply) => {
  const id = parseInt((req.params as { id: string }).id, 10);
  const gz = repo.getScoredBody(id);
  if (!gz) return reply.code(404).send({ error: 'снапшота на оценке нет: оценка не зафиксирована или контейнер ещё собирается' });
  return decodeSnapshot(gz);
});

/* дозапись «после сигнала»: бары от сигнала до фиксации оценки */
app.get('/api/entries/:id/after', (req, reply) => {
  const id = parseInt((req.params as { id: string }).id, 10);
  const gz = repo.getAfterBody(id);
  if (!gz) return reply.code(404).send({ error: 'дозаписи нет: позиция открыта или бар выхода ещё не закрылся' });
  return decodeGzJson(gz);
});

/* ── управление движком ──────────────────────────────────────── */
app.get('/api/engine/status', () => engine.status());
app.post('/api/engine/start', async () => { await engine.start(); return engine.status(); });
app.post('/api/engine/stop', () => { engine.stop(); return engine.status(); });
app.post('/api/engine/restart', async () => { await engine.restart(); return engine.status(); });

/* ── живой сканер ────────────────────────────────────────────── */
app.get('/api/scanner/state', () => engine.scannerState());

/* ── сетка настроек: распределение оценок по комбинациям ──────── */
app.get('/api/grid/combos', (req) => grid.comboStats((req.query as Q).profile || undefined));
app.get('/api/grid/stats', () => ({ ...grid.stats(), file: grid.gridDbFile }));
app.delete('/api/grid/:profile', (req) => ({ deleted: grid.dropProfile((req.params as { profile: string }).profile) }));

/* ── приватные API-ключи ─────────────────────────────────────── */
app.get('/api/keys', () => listApiKeys());
app.put('/api/keys/:exchange', (req, reply) => {
  const exchange = (req.params as { exchange: string }).exchange;
  if (exchange !== 'binance') return reply.code(400).send({ error: 'пока поддерживается только binance' });
  const b = (req.body ?? {}) as { key?: string; secret?: string };
  const key = (b.key ?? '').trim(), secret = (b.secret ?? '').trim();
  if (key.length < 10 || secret.length < 10) return reply.code(400).send({ error: 'введите API Key и API Secret' });
  saveApiKey(exchange, key, secret);
  return listApiKeys().find(k => k.exchange === exchange);
});
app.delete('/api/keys/:exchange', (req, reply) => {
  const ok = deleteApiKey((req.params as { exchange: string }).exchange);
  return ok ? { ok: true } : reply.code(404).send({ error: 'ключ не найден' });
});
app.post('/api/keys/:exchange/verify', async (req, reply) => {
  const exchange = (req.params as { exchange: string }).exchange;
  if (exchange !== 'binance') return reply.code(400).send({ error: 'пока поддерживается только binance' });
  return verifyBinanceKey();
});

/* ── обслуживание БД ─────────────────────────────────────────── */
const fsize = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const dbFileSizes = () => ({ db_bytes: fsize(dbFile), wal_bytes: fsize(dbFile + '-wal') });

app.get('/api/db/stats', () => ({ ...dbFileSizes(), ...repo.maintenanceStats() }));

app.post('/api/db/vacuum', async () => {
  const wasRunning = engine.status().running;
  if (wasRunning) engine.stop();          // VACUUM на паузе движка — без задержек тиков
  const before = dbFileSizes();
  const t0 = Date.now();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  const ms = Date.now() - t0;
  if (wasRunning) await engine.start();
  const after = dbFileSizes();
  return { ok: true, ms, freed_bytes: (before.db_bytes + before.wal_bytes) - (after.db_bytes + after.wal_bytes), ...after };
});

app.post('/api/db/cleanup', (req, reply) => {
  const days = parseInt(String(((req.body ?? {}) as { days?: unknown }).days), 10);
  if (!(days >= 1)) return reply.code(400).send({ error: 'days должен быть ≥ 1' });
  return repo.cleanupOlderThan(days);
});

/* ── старт ───────────────────────────────────────────────────── */
const PORT = parseInt(process.env.PORT ?? '8787', 10);
app.listen({ port: PORT, host: '127.0.0.1' }).then(async () => {
  console.log(`Сканер: http://localhost:${PORT}`);
  console.log(`БД: ${dbFile} (${tableCount()} таблиц)`);
  if (repo.getSetting('engine_autostart', true)) {
    try { await engine.start(); console.log('Движок запущен (автостарт).'); }
    catch (e) { console.error('Автостарт движка не удался:', e); }
  }
}).catch(err => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { engine.stop(); db.close(); process.exit(0); });
}
