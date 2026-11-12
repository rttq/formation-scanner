/* Local storage for private API keys.
   AES-256-GCM encryption; the master key is 32 random bytes in data/config/master.key.
   Secrets never leave the machine and are never sent to the frontend (only a mask). */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db/index.js';

const cfgDir = path.join(dataDir, 'config');
const keyFile = path.join(cfgDir, 'master.key');
const storeFile = path.join(cfgDir, 'keys.json');

function masterKey(): Buffer {
  mkdirSync(cfgDir, { recursive: true });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32));
  return readFileSync(keyFile).subarray(0, 32);
}

interface StoredKey {
  iv: string;      // base64
  tag: string;     // base64, GCM auth tag
  data: string;    // base64, ciphertext of JSON {apiKey, apiSecret}
  masked: string;  // for display
  saved_at: number;
}
type Store = Record<string, StoredKey>;

function load(): Store {
  try { return JSON.parse(readFileSync(storeFile, 'utf8')) as Store; } catch { return {}; }
}
function persist(s: Store): void {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(storeFile, JSON.stringify(s, null, 2));
}

export function saveApiKey(exchange: string, apiKey: string, apiSecret: string): void {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify({ apiKey, apiSecret }), 'utf8'), c.final()]);
  const s = load();
  s[exchange] = {
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    masked: apiKey.length > 8 ? apiKey.slice(0, 4) + '…' + apiKey.slice(-4) : '••••',
    saved_at: Date.now(),
  };
  persist(s);
}

export function getApiKey(exchange: string): { apiKey: string; apiSecret: string } | null {
  const e = load()[exchange];
  if (!e) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    const buf = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]);
    return JSON.parse(buf.toString('utf8')) as { apiKey: string; apiSecret: string };
  } catch { return null; }   // master key changed / file corrupted
}

export function listApiKeys(): Array<{ exchange: string; masked: string; saved_at: number }> {
  return Object.entries(load()).map(([exchange, e]) => ({ exchange, masked: e.masked, saved_at: e.saved_at }));
}

export function deleteApiKey(exchange: string): boolean {
  const s = load();
  if (!s[exchange]) return false;
  delete s[exchange];
  if (Object.keys(s).length === 0 && existsSync(storeFile)) unlinkSync(storeFile);
  else persist(s);
  return true;
}
