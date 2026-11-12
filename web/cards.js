/* Live scanner: cards for patterns awaiting a signal and for observations with their scoring stage */
"use strict";
const $ = id => document.getElementById(id);
const cards = new Map();      // key -> {el, canvas, item}
let refreshing = false;

const fmtPct = x => x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(2) + '%';
const fmtVol = v => !isFinite(v) ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v);
const fmtTime = () => new Date().toLocaleTimeString();

/* price move from the signal in the trade direction, % (not P&L, just an observation) */
function moveFromEntry(item) {
  if (!item.ticker || item.entry == null) return null;
  const p = item.ticker.price;
  return (item.dir === 'long' ? (p - item.entry) / item.entry : (item.entry - p) / item.entry) * 100;
}

/* badge: awaiting a signal, or the scoring stage + the move from the signal.
   Intermediate stages are set by the hypothesis, so the stage name itself is printed */
const midStage = st => st && st !== 'watch' && st !== 'final';
function badgeText(item) {
  if (item.kind === 'wait') return 'AWAITING SIGNAL';
  const mv = moveFromEntry(item);
  const st = midStage(item.stage) ? item.stage.toUpperCase() : 'SIGNAL';
  return st + (mv == null ? '' : ' ' + fmtPct(mv));
}
function badgeClass(item) {
  if (item.kind === 'wait') return 'badge wait';
  return 'badge ' + (midStage(item.stage) ? 'hot' : 'open');
}

function buildCard(key, item) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML =
    `<div class="chart">` +
    `<div class="${badgeClass(item)}">${badgeText(item)}</div>` +
    `<div class="dirb ${item.dir === 'long' ? 'up' : 'down'}">${item.dir.toUpperCase()}</div>` +
    `<canvas></canvas></div>` +
    `<div class="meta">` +
    `<div class="r1"><span class="sym">${item.symbol} · ${item.tf}</span><span class="price">${item.ticker ? item.ticker.price : '—'}</span></div>` +
    `<div class="r2"><span class="muted">${item.kind === 'wait' ? 'no signal yet' : 'signal ' + item.entry}</span>` +
    `<span class="${item.ticker && item.ticker.chg >= 0 ? 'up' : 'down'}">${item.ticker ? fmtPct(item.ticker.chg) : ''}</span>` +
    `<span class="muted">${item.ticker ? fmtVol(item.ticker.vol) : ''}</span></div>` +
    `</div>`;
  el.onclick = () => window.open('https://www.binance.com/en/futures/' + item.symbol, '_blank', 'noopener');
  const ref = { el, canvas: el.querySelector('canvas'), item, loadedKey: null };
  cards.set(key, ref);
  return ref;
}

function overlaysFor(ref) {
  const it = ref.item;
  const levels = [];
  /* pattern points and levels */
  if (it.A && it.B && it.levels) {
    levels.push(
      { price: it.A.p, fromTs: it.A.t, color: '#6b6d75', label: 'A' },
      { price: it.B.p, fromTs: it.B.t, color: '#6b6d75', label: 'B' },
      { price: it.levels.k1, fromTs: it.A.t, color: '#BA270D', label: 'k1' },
      { price: it.levels.k2, fromTs: it.A.t, color: '#DD3742', label: 'k2' },
      { price: it.levels.k3, fromTs: it.A.t, color: '#DD8836', label: 'k3', labelBelow: true },
    );
  }
  if (it.entry != null) levels.push({ price: it.entry, color: '#56b6c2', dash: false, label: 'SIG' });
  /* white arrow above the signal bar */
  const marks = it.kind !== 'wait' && it.enteredAt != null ? [{ ts: it.enteredAt }] : [];
  return { levels, marks };
}

async function loadChart(ref) {
  try {
    const r = await (await fetch(`/api/market/klines?symbol=${ref.item.symbol}&tf=${ref.item.tf}&limit=140`)).json();
    if (!r.klines || !r.klines.length) return;
    const last = r.klines[r.klines.length - 1];
    const key = last.t + '/' + last.c;
    if (ref.loadedKey === key) { Chart.setData(ref.canvas, r.klines, overlaysFor(ref), r.klines.length); return; }
    ref.loadedKey = key;
    Chart.setData(ref.canvas, r.klines, overlaysFor(ref), r.klines.length);
  } catch { /* a single card failing is not critical */ }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await (await fetch('/api/scanner/state')).json();
    $('dot').className = 'dot ' + (s.running ? 'ok' : 'err');
    $('engTxt').textContent = s.running ? 'engine running' : 'engine stopped';
    $('cOpen').textContent = s.open.length;
    $('cWait').textContent = (s.waiting || []).length;
    $('ts').textContent = fmtTime();

    /* signals (newest first), then patterns awaiting a signal */
    const items = s.open.sort((a, b) => b.enteredAt - a.enteredAt)
      .map(x => ({ key: 'o' + x.entryId, item: x }))
      .concat((s.waiting || []).sort((a, b) => b.detectedAt - a.detectedAt)
        .map(x => ({ key: 'w' + x.id, item: { ...x, kind: 'wait' } })));
    const grid = $('grid');
    if (!items.length) {
      grid.innerHTML = '<div class="empty">no patterns yet: the engine is scanning the market</div>';
      cards.clear();
      refreshing = false;
      return;
    }
    const empty = grid.querySelector('.empty'); if (empty) empty.remove();

    const want = new Set(items.map(x => x.key));
    for (const [key, ref] of [...cards]) {
      if (!want.has(key)) { ref.el.remove(); cards.delete(key); }
    }
    for (const { key, item } of items) {
      let ref = cards.get(key);
      if (!ref) ref = buildCard(key, item);
      else {
        ref.item = item;
        const b = ref.el.querySelector('.badge');
        b.className = badgeClass(item);
        b.textContent = badgeText(item);
        if (item.ticker) {
          ref.el.querySelector('.price').textContent = item.ticker.price;
        }
      }
      grid.appendChild(ref.el);
      loadChart(ref);
    }
  } catch { $('dot').className = 'dot err'; $('engTxt').textContent = 'no connection'; }
  refreshing = false;
}

/* ── scan profiles (moved here from Settings) ──────────────────
   the table loads when the panel opens and on explicit actions; the card
   refresh timer doesn't touch it, so typed input isn't wiped */
const TFS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];
const api = {
  get: async u => (await fetch(u)).json(),
  put: async (u, b) => (await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(),
  post: async u => (await fetch(u, { method: 'POST' })).json(),
  del: async u => (await fetch(u, { method: 'DELETE' })).json(),
};
let profiles = [];

function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = err ? 'var(--down)' : 'var(--accent)';
  t.style.display = 'block';
  clearTimeout(t.__h);
  t.__h = setTimeout(() => { t.style.display = 'none'; }, 2500);
}
const sel = (opts, val, extra) => `<select ${extra || ''}>` + opts.map(o => `<option${o === val ? ' selected' : ''}>${o}</option>`).join('') + '</select>';
async function engineRestart() { await api.post('/api/engine/restart'); }

async function loadProfiles() {
  profiles = await api.get('/api/profiles');
  $('profTable').querySelector('tbody').innerHTML = profiles.map((p, i) => `<tr data-i="${i}">
    <td><input type="checkbox" class="pEn" ${p.enabled ? 'checked' : ''}></td>
    <td style="color:#fff">${p.name}</td>
    <td>${sel(TFS, p.params.tf, 'class="pTf"')}</td>
    <td><input class="num pRange" type="number" min="2" value="${p.params.search_range}"></td>
    <td><input class="num pK1" type="number" step="0.01" value="${p.params.k1}"></td>
    <td><input class="num pK2" type="number" step="0.01" value="${p.params.k2}"></td>
    <td><input class="num pK3" type="number" step="0.01" value="${p.params.k3}"></td>
    <td><input class="num pStl" type="number" min="1" value="${p.params.score_ttl_bars}"></td>
    <td><input class="num pTop" type="number" min="0" value="${p.params.top_n}"></td>
    <td><input class="num pVol" type="number" min="0" step="100000" value="${p.params.min_vol24}"></td>
    <td><button class="pSave on">SAVE</button></td>
    <td><button class="pDel danger">✕</button></td>
  </tr>`).join('');
  $('profTable').querySelectorAll('tbody tr').forEach(tr => {
    const name = profiles[+tr.dataset.i].name;
    tr.querySelector('.pSave').onclick = async () => {
      const k = c => parseFloat(tr.querySelector(c).value);
      const k1 = k('.pK1'), k2 = k('.pK2'), k3 = k('.pK3');
      if (![k1, k2, k3].every(x => x > 0)) return toast('coefficients must be greater than zero', true);
      await api.put('/api/profiles/' + encodeURIComponent(name), {
        enabled: tr.querySelector('.pEn').checked,
        tf: tr.querySelector('.pTf').value,
        search_range: Math.max(2, parseInt(tr.querySelector('.pRange').value, 10) || 60),
        k1, k2, k3,
        score_ttl_bars: Math.max(1, parseInt(tr.querySelector('.pStl').value, 10) || 20),
        top_n: Math.max(0, parseInt(tr.querySelector('.pTop').value, 10) || 0),
        min_vol24: Math.max(0, parseFloat(tr.querySelector('.pVol').value) || 0),
      });
      await engineRestart();
      refresh();
      toast('profile "' + name + '" saved, engine restarted');
    };
    tr.querySelector('.pDel').onclick = async () => {
      if (!confirm('Delete profile "' + name + '"?')) return;
      await api.del('/api/profiles/' + encodeURIComponent(name));
      await engineRestart();
      loadProfiles();
      refresh();
      toast('profile deleted');
    };
  });
}
$('btnAddProf').onclick = async () => {
  const name = $('newProfName').value.trim();
  if (!name) return toast('enter a profile name', true);
  if (profiles.some(p => p.name === name)) return toast('this profile already exists', true);
  await api.put('/api/profiles/' + encodeURIComponent(name), { enabled: false });
  $('newProfName').value = '';
  loadProfiles();
  toast('profile created (disabled): configure and enable it');
};
$('profToggle').onclick = () => {
  const p = $('profPanel');
  const show = p.style.display !== 'block';
  p.style.display = show ? 'block' : 'none';
  $('profToggle').classList.toggle('on', show);
  if (show) loadProfiles();
};

$('cols').onchange = () => {
  const c = Math.max(1, Math.min(10, parseInt($('cols').value, 10) || 5));
  $('cols').value = c;
  document.documentElement.style.setProperty('--cols', c);
};
$('refresh').onclick = refresh;

refresh();
setInterval(refresh, 30000);
window.addEventListener('resize', () => { for (const ref of cards.values()) Chart.render(ref.canvas); });
