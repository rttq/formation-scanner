/* Сетка настроек: конфигуратор с оценкой стоимости, тепловая карта k1 × k2,
   топ комбинаций и перенос выбранной в рабочий профиль. */
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
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' млрд' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' млн'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + ' тыс' : String(Math.round(n));
const bytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' ГБ' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' МБ'
  : b >= 1e3 ? (b / 1e3).toFixed(1) + ' КБ' : b + ' Б';
const r3 = x => Math.round(x * 1000) / 1000;

/* ── разворачивание диапазона: та же арифметика, что в config.ts ── */
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
  /* та же проверка, что validCoefs в src/core/detector.ts */
  const k3 = num('expK3');
  let n = 0;
  for (const a of k1) for (const b of k2) for (const r of R) if (a > 0 && b > 0 && k3 > 0) n++;
  return { n, k1, k2, R };
}

/* ── оценка стоимости до запуска ──
   Множители — демо-значения, их стоит заменить замерами своей гипотезы:
   паттернов в час на 150 монетах 5m, доля дошедших до сигнала, выход средней
   комбинации относительно базовой. Строка сетки с индексами — ~200 байт. */
const PER_HOUR_150 = 20, TO_SIGNAL = 0.5, COMBO_YIELD = 0.5, ROW_BYTES = 200;

function estimate() {
  const c = combos();
  const top = Math.max(1, parseInt($('expTop').value, 10) || 150);
  const tfMin = TF_MIN[$('expTf').value] || 5;
  /* частота паттернов пропорциональна числу монет и обратно — длительности бара */
  const scale = (top / 150) * (5 / tfMin);
  const perComboDay = PER_HOUR_150 * 24 * TO_SIGNAL * COMBO_YIELD * scale;
  const sigDay = perComboDay * c.n;
  const reqMin = top / tfMin + 2;                        // скан раз в бар + тикеры дважды в минуту

  $('k1N').textContent = c.k1.length + ' знач.';
  $('k2N').textContent = c.k2.length + ' знач.';
  $('rN').textContent = c.R.length + ' знач.';

  const dropped = c.k1.length * c.k2.length * c.R.length - c.n;
  const over = c.n > 500;

  $('est').innerHTML = [
    ['КОМБИНАЦИЙ', c.n + (dropped ? ` <span class="lbl">(−${dropped} невалидных)</span>` : ''), over],
    ['СИГНАЛОВ В СУТКИ', fmt(sigDay), false],
    ['НА КОМБИНАЦИЮ В СУТКИ', fmt(perComboDay), false],
    ['БАЗА В СУТКИ', bytes(sigDay * ROW_BYTES), false],
    ['ЗАПРОСОВ В МИНУТУ', Math.round(reqMin) + ' / 2400', reqMin > 1200],
  ].map(([k, v, warn]) => `<div class="tile"><div class="k">${k}</div><div class="v${warn ? ' warn' : ''}">${v}</div></div>`).join('');

  $('btnLaunch').disabled = over || c.n === 0;
  $('expState').innerHTML = over ? '<span class="err">потолок 500 комбинаций</span>'
    : c.n === 0 ? '<span class="err">нет валидных комбинаций: коэффициенты должны быть больше нуля</span>' : '';
}

/* ── запуск / остановка эксперимента ── */
async function launch() {
  const name = $('expName').value.trim();
  if (!name || name.includes('#') || name.includes('|')) return toast('имя без символов # и |', true);
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
  toast(`эксперимент «${name}» запущен: ${combos().n} комбинаций`);
  loadProfiles(); engineStatus();
}

$('btnLaunch').onclick = launch;
$('btnStopExp').onclick = async () => {
  const name = $('expName').value.trim();
  const p = (await api.get('/api/profiles')).find(x => x.name === name);
  if (!p) return toast('профиль не найден', true);
  await api.put('/api/profiles/' + encodeURIComponent(name), { enabled: false });
  await api.post('/api/engine/restart');
  toast('сбор остановлен, данные сохранены');
  loadProfiles(); engineStatus();
};
$('btnDrop').onclick = async () => {
  const name = $('expName').value.trim();
  if (!confirm(`Удалить ВСЕ собранные сигналы эксперимента «${name}»?\nРабочий журнал не затрагивается.`)) return;
  const r = await api.del('/api/grid/' + encodeURIComponent(name));
  toast(`удалено строк: ${r.deleted}`);
  loadMap();
};

/* ══ ТЕПЛОВАЯ КАРТА ═══════════════════════════════════════════
   Величина кодируется одним тоном через насыщенность (нулевая — фон панели),
   а не радугой: у последовательной шкалы порядок обязан читаться сам собой.
   В каждой ячейке напечатано и само значение, поэтому карта не полагается
   на цвет как на единственный носитель информации. */
/* потолок насыщенности подобран по контрасту: выше 0,45 подпись «n» цветом
   --muted перестаёт читаться на залитой ячейке, а число сигналов нужно видеть */
const RAMP_MAX = 0.45;
const shade = t => `rgba(86,182,194,${(0.05 + RAMP_MAX * Math.max(0, Math.min(1, t))).toFixed(3)})`;

const METRICS = {
  p4: { label: '% оценки 4', calc: c => scored(c) ? c.s4 / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  p34: { label: '% оценок 3–4', calc: c => scored(c) ? (c.s3 + c.s4) / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  avg: { label: 'средняя оценка', calc: c => c.avg_score, fmt: v => v.toFixed(2) },
  p0: { label: '% оценки 0', calc: c => scored(c) ? c.s0 / scored(c) * 100 : null, fmt: v => v.toFixed(1) + '%' },
  n: { label: 'N сигналов', calc: c => c.n, fmt: v => String(v) },
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
    $('heat').innerHTML = '<div class="hint">Данных ещё нет. Запустите сбор и вернитесь — первые сигналы появляются в течение бара.</div>';
    $('legend').innerHTML = ''; $('top').querySelector('tbody').innerHTML = ''; $('mapHint').textContent = '';
    return;
  }

  const hs = [...new Set(cells.map(c => c.k1))].sort((a, b) => b - a);
  const qs = [...new Set(cells.map(c => c.k2))].sort((a, b) => a - b);
  const at = (h, q) => cells.find(c => c.k1 === h && c.k2 === q);

  /* Порог сравнивается с числом ОЦЕНЁННЫХ сигналов, а не всех: метрика считается
     по ним же. Иначе в начале накопления ячейка с 40 сигналами, из которых оценены
     три, порог проходит и красится ярко — ровно та «победа на трёх сигналах»,
     от которой порог и должен защищать.
     Шкала строится только по прошедшим порог: одна случайная комбинация иначе
     задала бы максимум для всей карты. */
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
      + `<span style="margin-left:12px"><i style="background:var(--line2);width:22px;height:11px;display:inline-block;border-radius:2px;vertical-align:-1px"></i> оценено меньше ${minN}</span>`
    : `<span>ни одна комбинация ещё не набрала ${minN} оценённых сигналов — порог можно временно снизить</span>`;

  const pending = cells.reduce((s, c) => s + c.pending, 0);
  const done = cells.reduce((s, c) => s + scored(c), 0);
  $('mapHint').textContent = `Окно ${curR}: ${cells.length} комбинаций, ${done} сигналов с оценкой, ${pending} ещё под наблюдением.`
    + ' Оценка фиксируется за TTL скоринга, поэтому свежие сигналы всегда «в процессе».';

  drawTop(m, minN);
}

function showTip(e, c) {
  if (!c) return;
  const t = $('tip'), tot = scored(c);
  const pct = k => tot ? (c[k] / tot * 100).toFixed(0) + '%' : '—';
  t.innerHTML = `<b>k1 ${c.k1} · k2 ${c.k2} · окно ${c.search_range}</b><br>`
    + `<span class="g">сигналов</span> ${c.n} · <span class="g">с оценкой</span> ${tot} · <span class="g">ждут</span> ${c.pending}<br>`
    + `<span class="g">0</span> ${c.s0} (${pct('s0')}) · <span class="g">★</span> ${c.s1} · <span class="g">★★</span> ${c.s2} (${pct('s2')})<br>`
    + `<span class="g">★★★</span> ${c.s3} (${pct('s3')}) · <span class="g">★★★★</span> ${c.s4} (${pct('s4')})<br>`
    + `<span class="g">средняя</span> ${c.avg_score == null ? '—' : c.avg_score.toFixed(2)}`;
  t.style.display = 'block';
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
  t.style.top = (e.clientY - h - 12 < 4 ? e.clientY + 16 : e.clientY - h - 12) + 'px';
}

/* таблица дублирует карту числами — карта не единственный способ прочитать результат */
function drawTop(m, minN) {
  const rows = COMBOS.filter(c => scored(c) >= minN && m.calc(c) != null)
    /* «% оценки 0» сортируется по возрастанию, остальные метрики — по убыванию */
    .sort((a, b) => ($('metric').value === 'p0' ? -1 : 1) * (m.calc(b) - m.calc(a)))
    .slice(0, 10);
  const tb = $('top').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = `<tr><td class="hint">Ни одна комбинация не набрала ${minN} оценённых сигналов. Оценка фиксируется за TTL скоринга — подождите или снизьте порог.</td></tr>`;
    return;
  }
  tb.innerHTML = '<tr><th>k1</th><th>k2</th><th>ОКНО</th><th>' + m.label.toUpperCase()
    + '</th><th>N</th><th>ЖДУТ</th><th>0</th><th>★</th><th>★★</th><th>★★★</th><th>★★★★</th><th>СРЕДН.</th></tr>'
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
  $('selInfo').textContent = c ? `выбрано: k1 ${c.k1} · k2 ${c.k2} · окно ${c.search_range} (n ${c.n})` : 'ячейка не выбрана';
}

/* ── перенос в рабочий профиль ── */
$('btnApply').onclick = async () => {
  const c = COMBOS.find(x => x.combo === selected);
  if (!c) return toast('сначала выберите ячейку на карте', true);
  const target = $('targetProfile').value;
  if (!target) return toast('нет рабочего профиля', true);
  if (!confirm(`Записать k1 ${c.k1}, k2 ${c.k2}, окно ${c.search_range} в профиль «${target}» и перезапустить движок?`)) return;
  const r = await api.put('/api/profiles/' + encodeURIComponent(target), { k1: c.k1, k2: c.k2, search_range: c.search_range });
  if (r.error) return toast(r.error, true);
  await api.post('/api/engine/restart');
  toast(`профиль «${target}» обновлён`);
};

/* ── общее ── */
async function loadProfiles() {
  const ps = await api.get('/api/profiles');
  const work = ps.filter(p => !p.params.grid);
  $('targetProfile').innerHTML = work.map(p => `<option${p.enabled ? ' selected' : ''}>${p.name}</option>`).join('')
    || '<option value="">—</option>';
  const exp = ps.find(p => p.name === $('expName').value.trim());
  if (exp) {
    $('expState').innerHTML = exp.enabled
      ? '<span class="ok">● собирает</span>' : '<span class="lbl">○ выключен</span>';
  }
}

async function engineStatus() {
  try {
    const s = await api.get('/api/engine/status');
    const g = await api.get('/api/grid/stats');
    $('engState').innerHTML = (s.running ? '<span class="ok">● движок работает</span>' : '<span class="err">○ движок остановлен</span>')
      + ` <span class="lbl">· сигналов сетки ${g.signals}, с оценкой ${g.scored}, база ${bytes(g.bytes)}</span>`;
  } catch { $('engState').innerHTML = '<span class="err">нет связи</span>'; }
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
  /* если эксперимент уже заведён — подставляем его диапазоны, чтобы не вводить заново */
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
