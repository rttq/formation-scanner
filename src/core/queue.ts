/* HTTP request queue with adaptive concurrency.
   On 429/418 the concurrency cap is halved and a cooldown starts;
   after a streak of successful responses the cap slowly grows back. */

export interface QueueStats {
  total: number;        // total requests since start
  active: number;       // running now
  pending: number;      // waiting in the queue
  maxConcurrency: number;
  cooldownUntil: number; // unix ms; 0 = no cooldown
}

const MAXC_FLOOR = 4;
const MAXC_CEIL = 32;
const COOLDOWN_MS = 2500;

let total = 0;
let active = 0;
let maxc = 16;
let okStreak = 0;
let cooldownUntil = 0;

interface Job {
  url: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}
const pending: Job[] = [];

export function qFetch<T = unknown>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push({ url, resolve: resolve as (d: unknown) => void, reject });
    pump();
  });
}

function pump(): void {
  if (Date.now() < cooldownUntil) { setTimeout(pump, 100); return; }
  while (active < maxc && pending.length) {
    const job = pending.shift()!;
    active++; total++;
    fetch(job.url)
      .then(res => {
        if (res.status === 429 || res.status === 418) {   // the exchange asks to slow down
          maxc = Math.max(MAXC_FLOOR, (maxc / 2) | 0);
          okStreak = 0;
          cooldownUntil = Date.now() + COOLDOWN_MS;
          throw new Error(`HTTP ${res.status} (exchange ${res.status === 429 ? 'rate limit' : 'ban'})`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (++okStreak >= 40 && maxc < MAXC_CEIL) { maxc++; okStreak = 0; }  // gradual recovery
        return res.json();
      })
      .then(
        d => job.resolve(d),
        e => job.reject(e instanceof Error ? e : new Error(String(e)))
      )
      .finally(() => { active--; pump(); });
  }
}

export function queueStats(): QueueStats {
  return { total, active, pending: pending.length, maxConcurrency: maxc, cooldownUntil: Date.now() < cooldownUntil ? cooldownUntil : 0 };
}
