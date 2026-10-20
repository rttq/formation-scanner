import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.resolve(__dirname, '../../data');
mkdirSync(dataDir, { recursive: true });

export const dbFile = path.join(dataDir, 'scanner.db');
export const db: Database.Database = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

export function tableCount(): number {
  const row = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get() as { n: number };
  return row.n;
}
