/* Журнал сигналов + просмотрщик снапшотов: оценка скоринга 0–4 в таблице,
   снапшоты «на сигнале» и «на оценке» */
"use strict";
const $ = id => document.getElementById(id);
const TF_ORDER = { '1m': 1, '5m': 2, '15m': 3, '30m': 4, '1H': 5, '4H': 6, '1D': 7 };

let entries = [];
let sortKey = 'entered_at', sortAsc = false;
const viewer = {
  open: false, ids: [], idx: -1, entry: null,
  snap: null, snapScored: null, which: 'signal',   // какой контейнер показан
  tf: null, after: null, showAfter: true,
};

/* ── формат ── */
const fmtDT = t => t == null ? '—' : new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function fmtPrice(p, tick) {
  if (p == null || !isFinite(p)) return '—';
  let d;
  if (tick && tick > 0) d = Math.max(0, Math.round(-Math.log10(tick)));
  else d = p >= 1000 ? 2 : p >= 1 ? 4 : 8;
  return p.toLocaleString('ru-RU', { minimumFractionDigits: Math.min(d, 10), maximumFractionDigits: Math.min(d, 10) });
}
const fmtPct = x => x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(2) + '%';
const fmtVol = v => !isFinite(v) ? '—' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v);

/* оценка скоринга: звёзды или текущая стадия (промежуточные стадии задаёт гипотеза) */
const STAGE_RU = { watch: 'ожидание', final: 'финал' };
const stageName = st => STAGE_RU[st] ?? st;
const starsOf = n => '<span class="star">' + '★'.repeat(n) + '</span><span class="dimstar">' + '☆'.repeat(4 - n) + '</span>';
function starsHtml(e) {
  if (e.score_stage == null) return '<span class="muted">—</span>';
  if (e.score_stage !== 'final') {
    return (e.score != null ? starsOf(e.score) + ' ' : '') + '<span class="muted">в процессе</span>';
  }
  return starsOf(e.score ?? 0);
}

/* ── статус движка (мини) ── */
async function engineStatus() {
  try {
    const s = await (await fetch('/api/engine/status')).json();
    $('engDot').className = 'dot ' + (s.running ? 'ok' : 'err');
    $('engTxt').textContent = s.running ? 'движок работает' : 'движок остановлен';
    $('stScoring').textContent = s.scoringCount;
    $('stOpen').textContent = s.entries.open;
    $('stTotal').textContent = s.entries.total;
  } catch { $('engDot').className = 'dot err'; $('engTxt').textContent = 'нет связи'; }
}

/* ── журнал ── */
const COLS = [
  ['id', '#'], ['entered_at', 'ВРЕМЯ СИГНАЛА'], ['symbol', 'ТИКЕР'], ['tf', 'ТФ'], ['dir', 'НАПР'],
  ['entry_price', 'ЦЕНА СИГНАЛА'], ['score', 'ОЦЕНКА'],
  ['status', 'СТАТУС'], ['scored_at', 'ФИКСАЦИЯ'],
  ['mfe_pct', 'MFE %'], ['mae_pct', 'MAE %'], ['bars_held', 'БАРОВ'],
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
    $('tbody').innerHTML = '<tr><td class="empty" colspan="12">сигналов нет — движок копит статистику</td></tr>';
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
  let html = `<span class="s">выборка<b>${entries.length}</b></span>` +
    `<span class="s">наблюдается<b>${openN}</b></span>` +
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
    html += `<span class="s">средн. MFE/MAE<b><span class="up">${avgMfe.toFixed(2)}%</span> / <span class="down">${avgMae.toFixed(2)}%</span></b></span>`;
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

/* ── просмотрщик ── */
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
  if (snap.error) { $('vSide').innerHTML = '<span class="down">снапшот не найден</span>'; return; }
  viewer.entry = entry; viewer.snap = snap;
  viewer.snapScored = scoredRes.ok ? await scoredRes.json() : null;
  viewer.which = 'signal';
  viewer.after = afterRes.ok ? await afterRes.json() : null;
  viewer.showAfter = true;

  $('vSym').textContent = '#' + entry.id + ' ' + entry.symbol;
  $('vDir').innerHTML = `<span class="${entry.dir === 'long' ? 'up' : 'down'}">${entry.dir.toUpperCase()}</span>`;
  $('vPnl').innerHTML = entry.score_stage === 'final'
    ? `<span>${starsHtml(entry)}</span><span class="muted"> · MFE ${(entry.mfe_pct ?? 0).toFixed(2)}% / MAE ${(entry.mae_pct ?? 0).toFixed(2)}%</span>`
    : `<span class="muted">${entry.score_stage ? stageName(entry.score_stage) : 'наблюдение идёт'}</span>`;

  /* переключатель контейнеров показываем, когда есть снапшот на оценке */
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

/* склейка баров снапшота сигнала с дозаписью развития (от сигнала до фиксации) */
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

  /* «РАЗВИТИЕ» — только на контейнере сигнала и рабочем ТФ (у контейнера оценки бары уже финальные) */
  const canAfter = viewer.which === 'signal' && !!(viewer.after && viewer.tf === viewer.after.tf);
  $('vAfter').style.display = canAfter ? '' : 'none';
  $('vAfter').classList.toggle('on', canAfter && viewer.showAfter);

  const { bars, merged } = viewerBars();
  const overlays = {
    levels: [
      /* точки паттерна: отрезки от своего бара; на чужих ТФ — те же цены от ts */
      { price: pat.A.price, fromTs: pat.A.ts, color: '#6b6d75', label: 'A' },
      { price: pat.B.price, fromTs: pat.B.ts, color: '#6b6d75', label: 'B' },
      { price: pat.levels.k1, fromTs: pat.A.ts, color: '#BA270D', label: 'k1' },
      { price: pat.levels.k2, fromTs: pat.A.ts, color: '#DD3742', label: 'k2' },
      { price: pat.levels.k3, fromTs: pat.A.ts, color: '#DD8836', label: 'k3', labelBelow: true },
      { price: snap.entry.price, fromTs: snap.entry.ts, color: '#56b6c2', dash: false, label: 'СИГНАЛ' },
    ],
    marks: [{ ts: snap.entry.ts }],   // белая стрелка над баром сигнала
  };
  /* линия цены фиксации оценки: на развитии и на контейнере оценки */
  if ((merged || viewer.which === 'scored') && entry.status === 'closed' && entry.exit_price != null) {
    overlays.levels.push({ price: entry.exit_price, fromTs: snap.entry.ts, color: '#c9a23a', label: 'ФИКСАЦИЯ', labelBelow: true });
  }
  /* стартовое окно: на ТФ паттерна — диапазон поиска + бары развития + запас; на прочих — 200 баров */
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
    '<h3>СИГНАЛ</h3>' + kv({
      'оценка': starsHtml(e),
      'время': fmtDT(e.entered_at),
      'направление': `<span class="${e.dir === 'long' ? 'up' : 'down'}">${e.dir}</span>`,
      /* коэффициенты из настроек профиля, а не цены уровней: цена — число одной монеты,
         коэффициенты говорят, каким набором настроек порождена запись */
      'k1 / k2 / k3': [s.pattern.k1, s.pattern.k2, s.pattern.k3].join(' / '),
    }) +
    '<h3>КОНТЕКСТ · ' + (viewer.which === 'scored' ? 'НА ОЦЕНКЕ' : 'НА СИГНАЛЕ') + '</h3>' + kv({
      'профиль': s.scan_profile.name + ' (' + s.scan_profile.params.tf + ', ТОП ' + s.scan_profile.params.top_n + ')',
      'цена 24ч': s.ticker24h ? P(s.ticker24h.price) : '—',
      'изм. 24ч': s.ticker24h ? `<span class="${s.ticker24h.chg_pct >= 0 ? 'up' : 'down'}">${fmtPct(s.ticker24h.chg_pct)}</span>` : '—',
      'объём 24ч': s.ticker24h ? fmtVol(s.ticker24h.vol_usdt) + ' USDT' : '—',
      'тик': tick ?? '—',
      'снапшот': Object.entries(s.klines).map(([tf, k]) => tf + '×' + k.length).join(' · '),
    });
}

window.addEventListener('resize', () => { if (viewer.open) Chart.render($('vCanvas')); });

/* ── старт ── */
loadEntries();
engineStatus();
setInterval(engineStatus, 10000);
setInterval(() => { if (!viewer.open) loadEntries(); }, 30000);
