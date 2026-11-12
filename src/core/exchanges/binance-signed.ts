/* Signed requests to Binance (HMAC-SHA256): private key verification.
   By design the app doesn't trade: only read endpoints are used.
   The check goes through the spot GET /sapi/v1/account/apiRestrictions: it only needs
   the "Enable Reading" permission (no Futures rights required), and the response holds
   the full list of the key's permissions, which is shown to the user. */
import { createHmac } from 'node:crypto';
import { getApiKey } from '../../keys/vault.js';

const SPOT_BASE = 'https://api.binance.com';

export interface KeyCheckResult {
  ok: boolean;
  error?: string;
  ipRestrict?: boolean;
  enableReading?: boolean;
  enableFutures?: boolean;
  enableSpotTrading?: boolean;
  enableWithdrawals?: boolean;
  createdAt?: number;
}

export async function verifyBinanceKey(): Promise<KeyCheckResult> {
  const k = getApiKey('binance');
  if (!k) return { ok: false, error: 'no key saved' };
  try {
    /* server time: protects against local clock drift */
    const tRes = await fetch(SPOT_BASE + '/api/v3/time');
    const { serverTime } = await tRes.json() as { serverTime: number };
    const qs = `timestamp=${serverTime}&recvWindow=10000`;
    const signature = createHmac('sha256', k.apiSecret).update(qs).digest('hex');
    const res = await fetch(`${SPOT_BASE}/sapi/v1/account/apiRestrictions?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': k.apiKey },
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const msg = body && body.msg ? `${body.code}: ${body.msg}` : 'HTTP ' + res.status;
      return { ok: false, error: String(msg) };
    }
    return {
      ok: true,
      ipRestrict: Boolean(body.ipRestrict),
      enableReading: Boolean(body.enableReading),
      enableFutures: Boolean(body.enableFutures),
      enableSpotTrading: Boolean(body.enableSpotAndMarginTrading),
      enableWithdrawals: Boolean(body.enableWithdrawals),
      createdAt: typeof body.createTime === 'number' ? body.createTime : undefined,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
