/* Parameter grid: configurator with a cost estimate, k1 × k2 heat map,
   top combinations and copying the selected one into the main profile. */
"use strict";
const $ = id => document.getElementById(id);
const TFS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];
const TF_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440 };

const api = {
  get: async u => (await fetch(u)).json(),
  put: async (u, b) => (await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(),
  post: async (u, b) => (await fetch(u, b === undefined ? { method: 'POST' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(),
  del: async u => (await fetch(u, { method: 'DELETE' })).json(),
};

function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = err ? 'var(--down)' : 'var(--accent)';
  t.style.display = 'block';
  clearTimeout(t.__h);
  t.__h = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const bytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB'
  : b >= 1e3 ? (b / 1e3).toFixed(1) + ' KB' : b + ' B';
const r3 = x => Math.round(x * 1000) / 1000;

/* ── range expansion: the same arithmetic as in config.ts ── */
function values(from, to, step, round) {
  if (![from, to, step].every(Number.isFinite) || !(step > 0) || to < from) return [round ? Math.round(from) : r3(from)];
  const out = [];
  for (let v = from; v <= to + step * 1e-6; v += step) out.push(round ? Math.round(v) : r3(v));
  return out;
}
const num = id => parseFloat($(id).value);
function ranges() {
  return {
    k1: values(num('k1From'), num('k1To'), num('k1Step')),
    k2: values(num('k2From'), num('k2To'), num('k2Step')),
    R: values(num('rFrom'), num('rTo'), num('rStep'), true).map(v => Math.max(3, v)),
  };
}
function combos() {
  const { k1, k2, R } = ranges();
  /* the same check as validCoefs in src/core/detector.ts */
  const k3 = num('expK3');
  let n = 0;
  for (const a of k1) for (const b of k2) for (const r of R) if (a > 0 && b > 0 && k3 > 0) n++;
  return { n, k1, k2, R };
}

/* ── cost estimate before launch ──
   The multipliers are demo values; replace them with measurements of your own hypothesis:
   patterns per hour on 150 coins at 5m, share that reach a signal, yield of an average
   combination relative to the base one. A grid row with indexes is ~200 bytes. */
const PER_HOUR_150 = 20, TO_SIGNAL = 0.5, COMBO_YIELD = 0.5, ROW_BYTES = 200;

function estimate() {
  const c = combos();
  const top = Math.max(1, parseInt($('expTop').value, 10) || 150);
  const tfMin = TF_MIN[$('expTf').value] || 5;
  /* pattern frequency is proportional to the number of coins and inversely to the bar length */
  const scale = (top / 150) * (5 / tfMin);
  const perComboDay = PER_HOUR_150 * 24 * TO_SIGNAL * COMBO_YIELD * scale;
  const sigDay = perComboDay * c.n;
  const reqMin = top / tfMin + 2;                        // a scan once per bar + tickers twice a minute

  $('k1N').textContent = c.k1.length + ' values';
  $('k2N').textContent = c.k2.length + ' values';
  $('rN').textContent = c.R.length + ' values';

  const dropped = c.k1.length * c.k2.length * c.R.length - c.n;
  const over = c.n > 500;

  $('est').innerHTML = [
    ['COMBINATIONS', c.n + (dropped ? ` <span class="lbl">(−${dropped} invalid)</span>` : ''), over],
    ['SIGNALS PER DAY', fmt(sigDay), false],
    ['PER COMBINATION PER DAY', fmt(perComboDay), false],
    ['DB GROWTH PER DAY', bytes(sigDay * ROW_BYTES), false],
    ['REQUESTS PER MINUTE', Math.round(reqMin) + ' / 2400', reqMin > 1200],
  ].map(([k, v, warn]) => `<div class="tile"><div class="k">${k}</div><div class="v${warn ? ' warn' : ''}">${v}</div></div>`).join('');

  $('btnLaunch').disabled = over || c.n === 0;
  $('expState').innerHTML = over ? '<span class="err">cap of 500 combinations</span>'
    : c.n === 0 ? '<span class="err">no valid combinations: coefficients must be greater than zero</span>' : '';
}

/* ── starting / stopping an experiment ── */
async function launch() {
  const name = $('expName').value.trim();
  if (!name || name.includes('#') || name.includes('|')) return toast('the name must not contain # or |', true);
  const r = await api.put('/api/profiles/' + encodeURIComponent(name), {
    tf: $('expTf').value,
    top_n: parseInt($('expTop').value, 10),
    k3: num('expK3'),
    score_ttl_bars: parseInt($('expTtl').value, 10),
    k1: num('k1From'), k2: num('k2From'), search_range: parseInt($('rFrom').value, 10),
    grid: {
      k1: [num('k1From'), num('k1To'), num('k1Step')],
      k2: [num('k2From'), num('k2To'), num('k2Step')],
      search_range: [parseInt($('rFrom').value, 10), parseInt($('rTo').value, 10), parseInt($('rStep').value, 10)],
    },
    enabled: true,
  });
  if (r.error) return toast(r.error, true);
  await api.post('/api/engine/restart');
  toast(`experiment "${name}" started: ${combos().n} combinations`);
  loadProfiles(); engineStatus();
}

$('btnLaunch').onclick = launch;
$('btnStopExp').onclick = async () => {
  const name = $('expName').value.trim();
  const p = (await api.get('/api/profiles')).find(x => x.name === name);
  if (!p) return toast('profile not found', true);
  await api.put('/api/profiles/' + encodeURIComponent(name), { enabled: false });
  await api.post('/api/engine/restart');
  toast('collection stopped, data kept');
  loadProfiles(); engineStatus();
};
$('btnDrop').onclick = async () => {
  const name = $('expName').value.trim();
  if (!confirm(`Delete ALL collected signals of experiment "${name}"?\nThe main journal is not affected.`)) return;
  const r = await api.del('/api/grid/' + encodeURIComponent(name));
  toast(`rows deleted: ${r.deleted}`);
  loadMap();
};

/* ══ HEAT MAP ═════════════════════════════════════════════════
   The value is encoded by one hue through saturation (zero is the panel background)
   rather than by a rainbow: a sequential scale must show its order by itself.
   Each cell also prints the value, so the map doesn't rely on color
   as the only carrier of information. */
/* the saturation cap is chosen for contrast: above 0.45 the "n" label in --muted
   stops being readable on a filled cell, and the signal count needs to stay visible */
const RAMP_MAX = 0.45;
const shade = t => `rgba(86,182,194,${(0.05 + RAMP_MAX * Math.max(0, Math.min(1, t))).toFixed(3)})`;

const METRICS = {
  p4: { label: '% score 4', calc: c => scored(c) ? c.s4 / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  p34: { label: '% score 3–4', calc: c => scored(c) ? (c.s3 + c.s4) / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  avg: { label: 'average score', calc: c => c.avg_score, fmt: v => v.toFixed(2) },
  p0: { label: '% score 0', calc: c => scored(c) ? c.s0 / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  n: { label: 'N signals', calc: c => c.n, fmt: v => String(v) },
};
const scored = c => c.s0 + c.s1 + c.s2 + c.s3 + c.s4;

let COMBOS = [], curR = null, selected = null;

async function loadMap() {
  const name = $('expName').value.trim();
  COMBOS = await api.get('/api/grid/combos?profile=' + encodeURIComponent(name));
  const rs = [...new Set(COMBOS.map(c => c.search_range))].sort((a, b) => a - b);
  if (!rs.includes(curR)) curR = rs[0] ?? null;
  $('rTabs').innerHTML = rs.map(r => `<button data-r="${r}"${r === curR ? ' class="on"' : ''}>${r}</button>`).join('');
  for (const b of $('rTabs').querySelectorAll('button')) {
    b.onclick = () => { curR = +b.dataset.r; drawMap(); };
  }
  drawMap();
}

function drawMap() {
  const m = METRICS[$('metric').value];
  const minN = parseInt($('minN').value, 10) || 0;
  const cells = COMBOS.filter(c => c.search_range === curR);

  if (!cells.length) {
    $('heat').innerHTML = '<div class="hint">No data yet. Start collecting and come back: the first signals appear within a bar.</div>';
    $('legend').innerHTML = ''; $('top').querySelector('tbody').innerHTML = ''; $('mapHint').textContent = '';
    return;
  }

  const hs = [...new Set(cells.map(c => c.k1))].sort((a, b) => b - a);
  const qs = [...new Set(cells.map(c => c.k2))].sort((a, b) => a - b);
  const at = (h, q) => cells.find(c => c.k1 === h && c.k2 === q);

  /* The threshold is compared with the number of SCORED signals, not all of them: the metric
     is computed over the same ones. Otherwise, early in collection, a cell with 40 signals of
     which three are scored passes the threshold and lights up brightly: exactly the
     "win on three signals" the threshold is meant to guard against.
     The scale is built only from cells that pass the threshold: otherwise one lucky
     combination would set the maximum for the whole map. */
  const vals = cells.filter(c => scored(c) >= minN).map(c => m.calc(c)).filter(v => v != null);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const norm = v => hi === lo ? 0.5 : (v - lo) / (hi - lo);

  let html = '<table class="heat"><tr><th></th>' + qs.map(q => `<th>k2 ${q}</th>`).join('') + '</tr>';
  for (const h of hs) {
    html += `<tr><th class="rh">k1 ${h}</th>`;
    for (const q of qs) {
      const c = at(h, q);
      if (!c) { html += '<td class="cell"><div class="c empty"><div class="m">—</div></div></td>'; continue; }
      const v = m.calc(c);
      const thin = scored(c) < minN;
      const bg = (v == null || thin) ? '' : `background:${shade(norm(v))}`;
      html += `<td class="cell"><div class="c${thin ? ' thin' : ''}${selected === c.combo ? ' sel' : ''}"`
        + ` style="${bg}" data-combo="${c.combo}">`
        + `<div class="m">${v == null ? '—' : m.fmt(v)}</div><div class="n">${scored(c)} / ${c.n}</div></div></td>`;
    }
    html += '</tr>';
  }
  $('heat').innerHTML = html + '</table>';

  for (const el of $('heat').querySelectorAll('.c[data-combo]')) {
    el.onclick = () => { selected = el.dataset.combo; drawMap(); };
    el.onmousemove = e => showTip(e, COMBOS.find(c => c.combo === el.dataset.combo));
    el.onmouseleave = () => { $('tip').style.display = 'none'; };
  }

  $('legend').innerHTML = vals.length
    ? `<span>${m.label}</span><span>${m.fmt(lo)}</span><span class="sw">`
      + [0, .25, .5, .75, 1].map(t => `<i style="background:${shade(t)}"></i>`).join('')
      + `</span><span>${m.fmt(hi)}</span>`
      + `<span style="margin-left:12px"><i style="background:var(--line2);width:22px;height:11px;display:inline-block;border-radius:2px;vertical-align:-1px"></i> fewer than ${minN} scored</span>`
    : `<span>no combination has ${minN} scored signals yet: you can lower the threshold for now</span>`;

  const pending = cells.reduce((s, c) => s + c.pending, 0);
  const done = cells.reduce((s, c) => s + scored(c), 0);
  $('mapHint').textContent = `Window ${curR}: ${cells.length} combinations, ${done} scored signals, ${pending} still being observed.`
    + ' A score becomes final within the scoring TTL, so fresh signals are always pending.';

  drawTop(m, minN);
}

function showTip(e, c) {
  if (!c) return;
  const t = $('tip'), tot = scored(c);
  const pct = k => tot ? (c[k] / tot * 100).toFixed(0) + '%' : '—';
  t.innerHTML = `<b>k1 ${c.k1} · k2 ${c.k2} · window ${c.search_range}</b><br>`
    + `<span class="g">signals</span> ${c.n} · <span class="g">scored</span> ${tot} · <span class="g">pending</span> ${c.pending}<br>`
    + `<span class="g">0</span> ${c.s0} (${pct('s0')}) · <span class="g">★</span> ${c.s1} · <span class="g">★★</span> ${c.s2} (${pct('s2')})<br>`
    + `<span class="g">★★★</span> ${c.s3} (${pct('s3')}) · <span class="g">★★★★</span> ${c.s4} (${pct('s4')})<br>`
    + `<span class="g">average</span> ${c.avg_score == null ? '—' : c.avg_score.toFixed(2)}`;
  t.style.display = 'block';
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
  t.style.top = (e.clientY - h - 12 < 4 ? e.clientY + 16 : e.clientY - h - 12) + 'px';
}

/* the table repeats the map in numbers: the map is not the only way to read the result */
function drawTop(m, minN) {
  const rows = COMBOS.filter(c => scored(c) >= minN && m.calc(c) != null)
    /* "% score 0" sorts ascending, the other metrics descending */
    .sort((a, b) => ($('metric').value === 'p0' ? -1 : 1) * (m.calc(b) - m.calc(a)))
    .slice(0, 10);
  const tb = $('top').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = `<tr><td class="hint">No combination has ${minN} scored signals. A score becomes final within the scoring TTL: wait or lower the threshold.</td></tr>`;
    return;
  }
  tb.innerHTML = '<tr><th>k1</th><th>k2</th><th>WINDOW</th><th>' + m.label.toUpperCase()
    + '</th><th>N</th><th>PENDING</th><th>0</th><th>★</th><th>★★</th><th>★★★</th><th>★★★★</th><th>AVG</th></tr>'
    + rows.map(c => `<tr data-combo="${c.combo}" style="cursor:pointer${selected === c.combo ? ';background:var(--accent-bg)' : ''}">`
      + `<td>${c.k1}</td><td>${c.k2}</td><td>${c.search_range}</td>`
      + `<td style="color:var(--accent)">${m.fmt(m.calc(c))}</td>`
      + `<td>${c.n}</td><td>${c.pending}</td><td>${c.s0}</td><td>${c.s1}</td><td>${c.s2}</td><td>${c.s3}</td><td>${c.s4}</td>`
      + `<td>${c.avg_score == null ? '—' : c.avg_score.toFixed(2)}</td></tr>`).join('');
  for (const tr of tb.querySelectorAll('tr[data-combo]')) {
    tr.onclick = () => { selected = tr.dataset.combo; drawMap(); };
  }
  updateSel();
}

function updateSel() {
  const c = COMBOS.find(x => x.combo === selected);
  $('selInfo').textContent = c ? `selected: k1 ${c.k1} · k2 ${c.k2} · window ${c.search_range} (n ${c.n})` : 'no cell selected';
}

/* ── copying into the main profile ── */
$('btnApply').onclick = async () => {
  const c = COMBOS.find(x => x.combo === selected);
  if (!c) return toast('select a cell on the map first', true);
  const target = $('targetProfile').value;
  if (!target) return toast('no main profile', true);
  if (!confirm(`Write k1 ${c.k1}, k2 ${c.k2}, window ${c.search_range} into profile "${target}" and restart the engine?`)) return;
  const r = await api.put('/api/profiles/' + encodeURIComponent(target), { k1: c.k1, k2: c.k2, search_range: c.search_range });
  if (r.error) return toast(r.error, true);
  await api.post('/api/engine/restart');
  toast(`profile "${target}" updated`);
};

/* ── shared ── */
async function loadProfiles() {
  const ps = await api.get('/api/profiles');
  const work = ps.filter(p => !p.params.grid);
  $('targetProfile').innerHTML = work.map(p => `<option${p.enabled ? ' selected' : ''}>${p.name}</option>`).join('')
    || '<option value="">—</option>';
  const exp = ps.find(p => p.name === $('expName').value.trim());
  if (exp) {
    $('expState').innerHTML = exp.enabled
      ? '<span class="ok">● collecting</span>' : '<span class="lbl">○ stopped</span>';
  }
}

async function engineStatus() {
  try {
    const s = await api.get('/api/engine/status');
    const g = await api.get('/api/grid/stats');
    $('engState').innerHTML = (s.running ? '<span class="ok">● engine running</span>' : '<span class="err">○ engine stopped</span>')
      + ` <span class="lbl">· grid signals ${g.signals}, scored ${g.scored}, DB ${bytes(g.bytes)}</span>`;
  } catch { $('engState').innerHTML = '<span class="err">no connection</span>'; }
}

for (const id of ['k1From', 'k1To', 'k1Step', 'k2From', 'k2To', 'k2Step', 'rFrom', 'rTo', 'rStep', 'expK3', 'expTop', 'expTf']) {
  $(id).addEventListener('input', estimate);
}
$('metric').onchange = drawMap;
$('minN').addEventListener('input', drawMap);
$('btnReload').onclick = () => { loadMap(); engineStatus(); };
$('expName').addEventListener('change', () => { loadProfiles(); loadMap(); });

(async () => {
  $('expTf').innerHTML = TFS.map(t => `<option${t === '15m' ? ' selected' : ''}>${t}</option>`).join('');
  /* if an experiment already exists, fill in its ranges so they don't have to be typed again */
  const ps = await api.get('/api/profiles');
  const exp = ps.find(p => p.params.grid);
  if (exp) {
    $('expName').value = exp.name;
    $('expTf').value = exp.params.tf;
    $('expTop').value = exp.params.top_n;
    $('expK3').value = exp.params.k3;
    $('expTtl').value = exp.params.score_ttl_bars;
    const g = exp.params.grid;
    if (g.k1) [$('k1From').value, $('k1To').value, $('k1Step').value] = g.k1;
    if (g.k2) [$('k2From').value, $('k2To').value, $('k2Step').value] = g.k2;
    if (g.search_range) [$('rFrom').value, $('rTo').value, $('rStep').value] = g.search_range;
  }
  estimate();
  await loadProfiles();
  await loadMap();
  engineStatus();
  setInterval(engineStatus, 10000);
})();
