/* Настройки: движок, снапшот, API-ключи, интенсивность, обслуживание БД */
"use strict";
const $ = id => document.getElementById(id);
const TFS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];
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
  t.__h = setTimeout(() => { t.style.display = 'none'; }, 2500);
}
const sel = (opts, val, extra) => `<select ${extra || ''}>` + opts.map(o => `<option${o === val ? ' selected' : ''}>${o}</option>`).join('') + '</select>';

/* ── движок ── */
async function engineStatus() {
  try {
    const s = await api.get('/api/engine/status');
    $('engState').innerHTML = s.running ? '<span class="ok">● работает</span>' : '<span class="err">○ остановлен</span>';
  } catch { $('engState').innerHTML = '<span class="err">нет связи</span>'; }
}
async function engineRestart() { await api.post('/api/engine/restart'); engineStatus(); }
$('btnStart').onclick = async () => { await api.post('/api/engine/start'); engineStatus(); toast('движок запущен'); };
$('btnStop').onclick = async () => { await api.post('/api/engine/stop'); engineStatus(); toast('движок остановлен'); };
$('btnRestart').onclick = async () => { await engineRestart(); toast('движок перезапущен'); };
$('autostart').onchange = async () => { await api.put('/api/settings/engine_autostart', $('autostart').checked); toast('автостарт: ' + ($('autostart').checked ? 'вкл' : 'выкл')); };

/* профили переехали на страницу СКАНЕР (scanner.js) */

/* ── снапшот ── */
function snapRow(tf, bars) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = sel(TFS, tf, 'class="sTf"') +
    `<input class="num sBars" type="number" min="10" max="1000" value="${bars}">` +
    '<span class="lbl">баров</span><button class="sDel danger">✕</button>';
  div.querySelector('.sDel').onclick = () => div.remove();
  return div;
}
async function loadSnapshot() {
  const r = await api.get('/api/settings/snapshot_config');
  const cfg = r.value || [];
  $('snapRows').innerHTML = '';
  for (const { tf, bars } of cfg) $('snapRows').appendChild(snapRow(tf, bars));
}
$('btnSnapAdd').onclick = () => $('snapRows').appendChild(snapRow('1H', 480));
$('btnSnapSave').onclick = async () => {
  const rows = [...$('snapRows').querySelectorAll('.row')];
  const seen = new Set(); const cfg = [];
  for (const r of rows) {
    const tf = r.querySelector('.sTf').value;
    if (seen.has(tf)) return toast('таймфрейм ' + tf + ' указан дважды', true);
    seen.add(tf);
    cfg.push({ tf, bars: Math.min(1000, Math.max(10, parseInt(r.querySelector('.sBars').value, 10) || 100)) });
  }
  if (!cfg.length) return toast('нужен хотя бы один таймфрейм', true);
  await api.put('/api/settings/snapshot_config', cfg);
  toast('глубина снапшота сохранена');
};

/* ── интенсивность ── */
async function loadIntensity() {
  const r = await api.get('/api/settings/intensity');
  const v = r.value || {};
  $('itTrack').value = v.track_sec ?? 30;
  $('itUniverse').value = v.universe_min ?? 5;
  $('itDelay').value = v.scan_delay_sec ?? 5;
}
$('btnItSave').onclick = async () => {
  await api.put('/api/settings/intensity', {
    track_sec: Math.max(5, parseInt($('itTrack').value, 10) || 30),
    universe_min: Math.max(1, parseInt($('itUniverse').value, 10) || 5),
    scan_delay_sec: Math.max(0, parseInt($('itDelay').value, 10) || 5),
  });
  await engineRestart();
  toast('интенсивность сохранена, движок перезапущен');
};

/* ── обслуживание БД ── */
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' ГБ' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' МБ' : (b / 1e3).toFixed(0) + ' КБ';
async function loadDbStats() {
  try {
    const s = await api.get('/api/db/stats');
    const f = (label, val) => `<div class="fld"><label>${label}</label><span>${val}</span></div>`;
    $('dbStats').innerHTML =
      f('файл базы', fmtBytes(s.db_bytes)) +
      f('WAL (журнал записи)', fmtBytes(s.wal_bytes)) +
      f('объём снапшотов', fmtBytes(s.snapshot_bytes)) +
      f('формаций', s.formations) +
      f('наблюдений', s.entries) +
      f('снапшотов', s.snapshots) +
      f('старейшее наблюдение', s.oldest_entry_at ? new Date(s.oldest_entry_at).toLocaleDateString('ru-RU') : '—');
  } catch { $('dbStats').innerHTML = '<span class="err">нет связи</span>'; }
}
$('btnDbRefresh').onclick = loadDbStats;
$('btnVacuum').onclick = async () => {
  $('btnVacuum').disabled = true;
  try {
    const r = await api.post('/api/db/vacuum');
    toast(r.ok ? 'VACUUM за ' + r.ms + ' мс, освобождено ' + fmtBytes(Math.max(0, r.freed_bytes)) : (r.error || 'ошибка'), !r.ok);
  } catch { toast('нет связи', true); }
  $('btnVacuum').disabled = false;
  loadDbStats(); engineStatus();
};
$('btnCleanup').onclick = async () => {
  const days = Math.max(1, parseInt($('dbDays').value, 10) || 30);
  $('dbDays').value = days;
  if (!confirm('Удалить закрытые наблюдения со снапшотами и отработавшие формации старше ' + days + ' дн.? Это необратимо.')) return;
  const r = await api.post('/api/db/cleanup', { days });
  if (r.error) return toast(r.error, true);
  toast('удалено: наблюдений ' + r.entries + ', снапшотов ' + r.snapshots + ', формаций ' + r.formations + ' — нажмите VACUUM для сжатия');
  loadDbStats();
};

/* ── приватные API-ключи ── */
async function loadKeys() {
  const keys = await api.get('/api/keys');
  const tb = $('keysTable').querySelector('tbody');
  if (!keys.length) {
    tb.innerHTML = '<tr><td colspan="6" style="color:var(--dim)">ключей нет — приложение работает по публичным эндпоинтам</td></tr>';
    return;
  }
  tb.innerHTML = keys.map(k => `<tr data-ex="${k.exchange}">
    <td style="color:#fff">${k.exchange}</td>
    <td>${k.masked}</td>
    <td class="hint">${new Date(k.saved_at).toLocaleString('ru-RU')}</td>
    <td class="kResult hint">—</td>
    <td><button class="kVerify">ПРОВЕРИТЬ</button></td>
    <td><button class="kDel danger">✕</button></td>
  </tr>`).join('');
  tb.querySelectorAll('tr').forEach(tr => {
    const ex = tr.dataset.ex;
    const out = tr.querySelector('.kResult');
    tr.querySelector('.kVerify').onclick = async () => {
      out.textContent = 'проверка…'; out.className = 'kResult hint';
      const r = await api.post('/api/keys/' + ex + '/verify');
      if (r.ok) {
        const perms = [];
        perms.push(r.enableReading ? 'чтение ✓' : '<span class="err">чтения нет!</span>');
        perms.push('IP: ' + (r.ipRestrict ? 'ограничен' : 'без ограничений'));
        if (r.enableSpotTrading) perms.push('<span class="err">торговля спот включена</span>');
        if (r.enableFutures) perms.push('<span class="err">торговля фьючерсы включена</span>');
        if (r.enableWithdrawals) perms.push('<span class="err">ВЫВОД СРЕДСТВ ВКЛЮЧЁН — отключите!</span>');
        if (!r.enableSpotTrading && !r.enableFutures && !r.enableWithdrawals) perms.push('read-only ✓');
        out.innerHTML = `<span class="ok">✓ ключ действителен</span> · ` + perms.join(' · ');
      } else {
        out.innerHTML = `<span class="err">✗ ${r.error}</span>`;
      }
    };
    tr.querySelector('.kDel').onclick = async () => {
      if (!confirm('Удалить ключ ' + ex + '?')) return;
      await api.del('/api/keys/' + ex);
      loadKeys();
      toast('ключ удалён');
    };
  });
}
$('btnKeySave').onclick = async () => {
  const key = $('keyApi').value.trim(), secret = $('keySecret').value.trim();
  if (key.length < 10 || secret.length < 10) return toast('введите API Key и API Secret', true);
  const r = await api.put('/api/keys/' + $('keyExchange').value, { key, secret });
  if (r.error) return toast(r.error, true);
  $('keyApi').value = ''; $('keySecret').value = '';
  loadKeys();
  toast('ключ сохранён (зашифрован) — нажмите «ПРОВЕРИТЬ»');
};

/* ── старт ── */
(async () => {
  const auto = await api.get('/api/settings/engine_autostart');
  $('autostart').checked = auto.value !== false;
  await loadSnapshot();
  await loadIntensity();
  await loadKeys();
  loadDbStats();
  engineStatus();
  setInterval(engineStatus, 10000);
})();
