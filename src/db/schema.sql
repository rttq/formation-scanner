-- Схема БД сканера

-- Паттерны (все обнаруженные; регистрируются как armed, triggered ставится при сигнале)
CREATE TABLE IF NOT EXISTS formations (
  id            TEXT PRIMARY KEY,        -- profile|exchange|market|symbol|tf|tsA|dir
  exchange      TEXT NOT NULL,
  market        TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  tf            TEXT NOT NULL,
  dir           TEXT NOT NULL CHECK(dir IN ('long','short')),
  ts_A          INTEGER NOT NULL,
  price_A       REAL NOT NULL,
  ts_B          INTEGER NOT NULL,
  price_B       REAL NOT NULL,
  ts_C          INTEGER NOT NULL,
  price_C       REAL NOT NULL,
  k1            REAL NOT NULL,           -- коэффициенты уровней профиля
  k2            REAL NOT NULL,
  k3            REAL NOT NULL,
  search_range  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('armed','triggered','cancelled','expired')),
  detected_at   INTEGER NOT NULL,
  resolved_at   INTEGER,
  cancel_reason TEXT,
  -- скоринг
  score            INTEGER,                          -- 0..4
  score_stage      TEXT NOT NULL DEFAULT 'watch',    -- стадии задаёт гипотеза; final — оценка зафиксирована
  score_signal_at  INTEGER,                          -- момент сигнала
  scored_at        INTEGER,                          -- финализация оценки
  score_seen_until INTEGER,                          -- закрытие последнего обработанного бара
  score_ttl_bars   INTEGER                           -- TTL скоринга (копия из профиля на момент обнаружения)
);
CREATE INDEX IF NOT EXISTS idx_formations_status ON formations(status, symbol);

-- Наблюдения: создаются на сигнале, завершаются фиксацией оценки (exit_reason = scored)
CREATE TABLE IF NOT EXISTS entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  formation_id   TEXT REFERENCES formations(id),
  exchange       TEXT NOT NULL,
  market         TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  tf             TEXT NOT NULL,
  dir            TEXT NOT NULL CHECK(dir IN ('long','short')),
  entered_at     INTEGER NOT NULL,
  entry_price    REAL NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('open','closed')),
  exited_at      INTEGER,
  exit_price     REAL,
  exit_reason    TEXT,
  mfe_pct        REAL,
  mae_pct        REAL,
  bars_held      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_main ON entries(symbol, dir, status, entered_at);

-- Снапшоты (1:1 к наблюдениям), тела — gzip(JSON)
CREATE TABLE IF NOT EXISTS snapshots (
  entry_id       INTEGER PRIMARY KEY REFERENCES entries(id),
  schema_version INTEGER NOT NULL,
  captured_at    INTEGER NOT NULL,
  body           BLOB NOT NULL,          -- контейнер на сигнале
  body_after     BLOB,                   -- бары развития: от сигнала до фиксации оценки
  body_scored    BLOB                    -- контейнер на фиксации оценки
);

-- Скан-профили, настройки
CREATE TABLE IF NOT EXISTS scan_profiles (
  name       TEXT PRIMARY KEY,
  params     TEXT NOT NULL,              -- JSON
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
