/* Signal journal + snapshot viewer: the 0–4 scoring score in the table,
   snapshots "at the signal" and "at the final score" */
"use strict";
const $ = id => document.getElementById(id);
const TF_ORDER = { '1m': 1, '5m': 2, '15m': 3, '30m': 4, '1H': 5, '4H': 6, '1D': 7 };

let entries = [];
let sortKey = 'entered_at', sortAsc = false;
const viewer = {
  open: false, ids: [], idx: -1, entry: null,
  snap: null, snapScored: null, which: 'signal',   // which container is shown
  tf: null, after: null, showAfter: true,
};

/* ── formatting (browser locale) ── */
const fmtDT = t => t == null ? '—' : new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function fmtPrice(p, tick) {
  if (p == null || !isFinite(p)) return '—';
  let d;
  if (tick && tick > 0) d = Math.max(0, Math.round(-Math.log10(tick)));
  else d = p >= 1000 ? 2 : p >= 1 ? 4 : 8;
  return p.toLocaleString(undefined, { minimumFractionDigits: Math.min(d, 10), maximumFractionDigits: Math.min(d, 10) });
}
const fmtPct = x => x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(2) + '%';
const fmtVol = v => !isFinite(v) ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v);

/* scoring score: stars, or "pending" while the score isn't final
   (stage names come from the hypothesis and are shown as is) */
const starsOf = n => '<span class="star">' + '★'.repeat(n) + '</span><span class="dimstar">' + '☆'.repeat(4 - n) + '</span>';
function starsHtml(e) {
  if (e.score_stage == null) return '<span class="muted">—</span>';
  if (e.score_stage !== 'final') {
    return (e.score != null ? starsOf(e.score) + ' ' : '') + '<span class="muted">pending</span>';
  }
  return starsOf(e.score ?? 0);
}

/* ── engine status (mini) ── */
async function engineStatus() {
  try {
    const s = await (await fetch('/api/engine/status')).json();
    $('engDot').className = 'dot ' + (s.running ? 'ok' : 'err');
    $('engTxt').textContent = s.running ? 'engine running' : 'engine stopped';
    $('stScoring').textContent = s.scoringCount;
    $('stOpen').textContent = s.entries.open;
    $('stTotal').textContent = s.entries.total;
  } catch { $('engDot').className = 'dot err'; $('engTxt').textContent = 'no connection'; }
}

/* ── journal ── */
const COLS = [
  ['id', '#'], ['entered_at', 'SIGNAL TIME'], ['symbol', 'SYMBOL'], ['tf', 'TF'], ['dir', 'DIR'],
  ['entry_price', 'SIGNAL PRICE'], ['score', 'SCORE'],
  ['status', 'STATUS'], ['scored_at', 'SCORED AT'],
  ['mfe_pct', 'MFE %'], ['mae_pct', 'MAE %'], ['bars_held', 'BARS'],
];

function renderHead() {
  $('thead').innerHTML = '<tr>' + COLS.map(([k, t]) =>
    `<th data-k="${k}" class="${k === sortKey ? 'sorted' : ''}">${t}${k === sortKey ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>`
  ).join('') + '</tr>';
  $('thead').querySelectorAll('th').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
    renderTable();
  });
}

function renderTable() {
  renderHead();
  const list = entries.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1; if (y == null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return sortAsc ? c : -c;
  });
  if (!list.length) {
    $('tbody').innerHTML = '<tr><td class="empty" colspan="12">no signals yet: the engine is collecting statistics</td></tr>';
    return;
  }
  $('tbody').innerHTML = list.map(e => `<tr data-id="${e.id}">
    <td class="muted">#${e.id}</td><td>${fmtDT(e.entered_at)}</td><td style="color:#fff">${e.symbol}</td>
    <td class="muted">${e.tf}</td><td class="${e.dir === 'long' ? 'up' : 'down'}">${e.dir.toUpperCase()}</td>
    <td>${fmtPrice(e.entry_price)}</td>
    <td>${starsHtml(e)}</td>
    <td>${e.status}</td><td class="muted">${e.score_stage === 'final' ? fmtDT(e.scored_at) : ''}</td>
    <td class="up">${e.mfe_pct == null ? '—' : e.mfe_pct.toFixed(2)}</td>
    <td class="down">${e.mae_pct == null ? '—' : e.mae_pct.toFixed(2)}</td>
    <td class="muted">${e.bars_held ?? '—'}</td>
  </tr>`).join('');
  $('tbody').querySelectorAll('tr').forEach(tr => tr.onclick = () => openViewer(+tr.dataset.id));
}

function renderStats() {
  const fin = entries.filter(e => e.score_stage === 'final');
  const n = k => fin.filter(e => e.score === k).length;
  const openN = entries.filter(e => e.status === 'open').length;
  const longN = entries.filter(e => e.dir === 'long').length;
  let html = `<span class="s">shown<b>${entries.length}</b></span>` +
    `<span class="s">open<b>${openN}</b></span>` +
    `<span class="s">long / short<b><span class="up">${longN}</span> / <span class="down">${entries.length - longN}</span></b></span>` +
    `<span class="s"><span class="star">★★★★</span><b>${n(4)}</b></span>` +
    `<span class="s"><span class="star">★★★</span><b>${n(3)}</b></span>` +
    `<span class="s"><span class="star">★★</span><b>${n(2)}</b></span>` +
    `<span class="s"><span class="star">★</span><b>${n(1)}</b></span>` +
    `<span class="s">${starsOf(0)}<b>${n(0)}</b></span>`;
  if (fin.length) {
    const sum = a => a.reduce((s, x) => s + x, 0);
    const avgMfe = sum(fin.map(e => e.mfe_pct ?? 0)) / fin.length;
    const avgMae = sum(fin.map(e => e.mae_pct ?? 0)) / fin.length;
    html += `<span class="s">avg MFE/MAE<b><span class="up">${avgMfe.toFixed(2)}%</span> / <span class="down">${avgMae.toFixed(2)}%</span></b></span>`;
  }
  $('stats').innerHTML = html;
}

async function loadEntries() {
  const q = new URLSearchParams();
  if ($('fStatus').value) q.set('status', $('fStatus').value);
  if ($('fDir').value) q.set('dir', $('fDir').value);
  if ($('fScore').value) q.set('score', $('fScore').value);
  if ($('fSymbol').value.trim()) q.set('symbol', $('fSymbol').value.trim());
  q.set('limit', $('fLimit').value);
  entries = await (await fetch('/api/entries?' + q)).json();
  renderStats(); renderTable();
}

$('fApply').onclick = loadEntries;
$('fSymbol').onkeydown = e => { if (e.key === 'Enter') loadEntries(); };

/* ── viewer ── */
function openViewer(id) {
  viewer.ids = entries.map(e => e.id);
  viewer.idx = viewer.ids.indexOf(id);
  viewer.open = true;
  $('viewer').classList.add('show');
  loadViewer(id);
}
function closeViewer() { viewer.open = false; $('viewer').classList.remove('show'); }
function nav(d) {
  if (!viewer.open) return;
  const i = viewer.idx + d;
  if (i < 0 || i >= viewer.ids.length) return;
  viewer.idx = i;
  loadViewer(viewer.ids[i]);
}
$('vClose').onclick = closeViewer;
$('vPrev').onclick = () => nav(-1);
$('vNext').onclick = () => nav(1);
window.addEventListener('keydown', e => {
  if (!viewer.open) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') nav(-1);
  if (e.key === 'ArrowRight') nav(1);
});

async function loadViewer(id) {
  const [entry, snap, scoredRes, afterRes] = await Promise.all([
    (await fetch('/api/entries/' + id)).json(),
    (await fetch('/api/entries/' + id + '/snapshot')).json(),
    fetch('/api/entries/' + id + '/snapshot-scored'),
    fetch('/api/entries/' + id + '/after'),
  ]);
  if (snap.error) { $('vSide').innerHTML = '<span class="down">snapshot not found</span>'; return; }
  viewer.entry = entry; viewer.snap = snap;
  viewer.snapScored = scoredRes.ok ? await scoredRes.json() : null;
  viewer.which = 'signal';
  viewer.after = afterRes.ok ? await afterRes.json() : null;
  viewer.showAfter = true;

  $('vSym').textContent = '#' + entry.id + ' ' + entry.symbol;
  $('vDir').innerHTML = `<span class="${entry.dir === 'long' ? 'up' : 'down'}">${entry.dir.toUpperCase()}</span>`;
  $('vPnl').innerHTML = entry.score_stage === 'final'
    ? `<span>${starsHtml(entry)}</span><span class="muted"> · MFE ${(entry.mfe_pct ?? 0).toFixed(2)}% / MAE ${(entry.mae_pct ?? 0).toFixed(2)}%</span>`
    : `<span class="muted">${entry.score_stage ?? 'observing'}</span>`;

  /* the container switcher is shown once there is a scored snapshot */
  $('vSnaps').style.display = viewer.snapScored ? '' : 'none';
  setSnapButtons();

  const tfs = Object.keys(snap.klines).sort((a, b) => (TF_ORDER[a] || 9) - (TF_ORDER[b] || 9));
  viewer.tf = tfs.includes(snap.pattern.tf) ? snap.pattern.tf : tfs[0];
  $('vTfs').innerHTML = tfs.map(tf => `<button data-tf="${tf}" class="${tf === viewer.tf ? 'on' : ''}">${tf}</button>`).join('');
  $('vTfs').querySelectorAll('button').forEach(b => b.onclick = () => {
    viewer.tf = b.dataset.tf;
    $('vTfs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    drawViewer();
  });

  renderSide();
  drawViewer();
}

function setSnapButtons() {
  $('vSnapSignal').classList.toggle('on', viewer.which === 'signal');
  $('vSnapScored').classList.toggle('on', viewer.which === 'scored');
}
$('vSnapSignal').onclick = () => { viewer.which = 'signal'; setSnapButtons(); renderSide(); drawViewer(); };
$('vSnapScored').onclick = () => { if (viewer.snapScored) { viewer.which = 'scored'; setSnapButtons(); renderSide(); drawViewer(); } };

function activeSnap() { return viewer.which === 'scored' && viewer.snapScored ? viewer.snapScored : viewer.snap; }

/* merge the signal snapshot's bars with the after-signal bars (from the signal to the final score) */
function viewerBars() {
  const snapBars = activeSnap().klines[viewer.tf] || [];
  const a = viewer.after;
  if (viewer.which === 'scored' || !a || !viewer.showAfter || viewer.tf !== a.tf) return { bars: snapBars, merged: false };
  const m = new Map();
  for (const k of snapBars) m.set(k.t, k);
  for (const k of a.klines) m.set(k.t, k);
  return { bars: [...m.values()].sort((x, y) => x.t - y.t), merged: true };
}

function drawViewer() {
  const snap = activeSnap(), entry = viewer.entry;
  if (!snap) return;
  const pat = snap.pattern, isPatTf = viewer.tf === pat.tf;

  /* "AFTER SIGNAL" only on the signal container and the pattern TF (the scored container's bars are already final) */
  const canAfter = viewer.which === 'signal' && !!(viewer.after && viewer.tf === viewer.after.tf);
  $('vAfter').style.display = canAfter ? '' : 'none';
  $('vAfter').classList.toggle('on', canAfter && viewer.showAfter);

  const { bars, merged } = viewerBars();
  const overlays = {
    levels: [
      /* pattern points: segments from their own bar; on other TFs, the same prices from ts */
      { price: pat.A.price, fromTs: pat.A.ts, color: '#6b6d75', label: 'A' },
      { price: pat.B.price, fromTs: pat.B.ts, color: '#6b6d75', label: 'B' },
      { price: pat.levels.k1, fromTs: pat.A.ts, color: '#BA270D', label: 'k1' },
      { price: pat.levels.k2, fromTs: pat.A.ts, color: '#DD3742', label: 'k2' },
      { price: pat.levels.k3, fromTs: pat.A.ts, color: '#DD8836', label: 'k3', labelBelow: true },
      { price: snap.entry.price, fromTs: snap.entry.ts, color: '#56b6c2', dash: false, label: 'SIGNAL' },
    ],
    marks: [{ ts: snap.entry.ts }],   // white arrow above the signal bar
  };
  /* price line at the final score: on the after-signal view and on the scored container */
  if ((merged || viewer.which === 'scored') && entry.status === 'closed' && entry.exit_price != null) {
    overlays.levels.push({ price: entry.exit_price, fromTs: snap.entry.ts, color: '#c9a23a', label: 'SCORED', labelBelow: true });
  }
  /* initial window: on the pattern TF, the search window + after-signal bars + margin; on other TFs, 200 bars */
  const afterN = merged ? bars.length - (snap.klines[viewer.tf] || []).length : 0;
  const visible = isPatTf
    ? Math.min(bars.length, Math.max(120, (pat.search_range || 60) + 40 + Math.max(0, afterN)))
    : Math.min(bars.length, 200);
  Chart.setData($('vCanvas'), bars, overlays, visible);
}
$('vAfter').onclick = () => { viewer.showAfter = !viewer.showAfter; drawViewer(); };

function renderSide() {
  const s = activeSnap(), e = viewer.entry, tick = s.instrument.tick_size;
  const P = p => fmtPrice(p, tick);
  const kv = obj => '<div class="kv">' + Object.entries(obj).map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('') + '</div>';
  $('vSide').innerHTML =
    '<h3>SIGNAL</h3>' + kv({
      'score': starsHtml(e),
      'time': fmtDT(e.entered_at),
      'direction': `<span class="${e.dir === 'long' ? 'up' : 'down'}">${e.dir}</span>`,
      /* coefficients from the profile settings rather than level prices: a price is a number
         for one coin, while the coefficients tell which settings produced the record */
      'k1 / k2 / k3': [s.pattern.k1, s.pattern.k2, s.pattern.k3].join(' / '),
    }) +
    '<h3>CONTEXT · ' + (viewer.which === 'scored' ? 'SCORED' : 'AT SIGNAL') + '</h3>' + kv({
      'profile': s.scan_profile.name + ' (' + s.scan_profile.params.tf + ', TOP ' + s.scan_profile.params.top_n + ')',
      '24h price': s.ticker24h ? P(s.ticker24h.price) : '—',
      '24h change': s.ticker24h ? `<span class="${s.ticker24h.chg_pct >= 0 ? 'up' : 'down'}">${fmtPct(s.ticker24h.chg_pct)}</span>` : '—',
      '24h volume': s.ticker24h ? fmtVol(s.ticker24h.vol_usdt) + ' USDT' : '—',
      'tick': tick ?? '—',
      'snapshot': Object.entries(s.klines).map(([tf, k]) => tf + '×' + k.length).join(' · '),
    });
}

window.addEventListener('resize', () => { if (viewer.open) Chart.render($('vCanvas')); });

/* ── start ── */
loadEntries();
engineStatus();
setInterval(engineStatus, 10000);
setInterval(() => { if (!viewer.open) loadEntries(); }, 30000);
