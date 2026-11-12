/* Settings: engine, snapshot, API keys, update intervals, DB maintenance */
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

/* ── engine ── */
async function engineStatus() {
  try {
    const s = await api.get('/api/engine/status');
    $('engState').innerHTML = s.running ? '<span class="ok">● running</span>' : '<span class="err">○ stopped</span>';
  } catch { $('engState').innerHTML = '<span class="err">no connection</span>'; }
}
async function engineRestart() { await api.post('/api/engine/restart'); engineStatus(); }
$('btnStart').onclick = async () => { await api.post('/api/engine/start'); engineStatus(); toast('engine started'); };
$('btnStop').onclick = async () => { await api.post('/api/engine/stop'); engineStatus(); toast('engine stopped'); };
$('btnRestart').onclick = async () => { await engineRestart(); toast('engine restarted'); };
$('autostart').onchange = async () => { await api.put('/api/settings/engine_autostart', $('autostart').checked); toast('autostart: ' + ($('autostart').checked ? 'on' : 'off')); };

/* scan profiles moved to the LIVE page (cards.js) */

/* ── snapshot ── */
function snapRow(tf, bars) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = sel(TFS, tf, 'class="sTf"') +
    `<input class="num sBars" type="number" min="10" max="1000" value="${bars}">` +
    '<span class="lbl">bars</span><button class="sDel danger">✕</button>';
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
    if (seen.has(tf)) return toast('timeframe ' + tf + ' is listed twice', true);
    seen.add(tf);
    cfg.push({ tf, bars: Math.min(1000, Math.max(10, parseInt(r.querySelector('.sBars').value, 10) || 100)) });
  }
  if (!cfg.length) return toast('at least one timeframe is needed', true);
  await api.put('/api/settings/snapshot_config', cfg);
  toast('snapshot depth saved');
};

/* ── update intervals ── */
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
  toast('update intervals saved, engine restarted');
};

/* ── DB maintenance ── */
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB';
async function loadDbStats() {
  try {
    const s = await api.get('/api/db/stats');
    const f = (label, val) => `<div class="fld"><label>${label}</label><span>${val}</span></div>`;
    $('dbStats').innerHTML =
      f('database file', fmtBytes(s.db_bytes)) +
      f('WAL (write-ahead log)', fmtBytes(s.wal_bytes)) +
      f('snapshot size', fmtBytes(s.snapshot_bytes)) +
      f('patterns', s.formations) +
      f('observations', s.entries) +
      f('snapshots', s.snapshots) +
      f('oldest observation', s.oldest_entry_at ? new Date(s.oldest_entry_at).toLocaleDateString() : '—');
  } catch { $('dbStats').innerHTML = '<span class="err">no connection</span>'; }
}
$('btnDbRefresh').onclick = loadDbStats;
$('btnVacuum').onclick = async () => {
  $('btnVacuum').disabled = true;
  try {
    const r = await api.post('/api/db/vacuum');
    toast(r.ok ? 'VACUUM took ' + r.ms + ' ms, freed ' + fmtBytes(Math.max(0, r.freed_bytes)) : (r.error || 'error'), !r.ok);
  } catch { toast('no connection', true); }
  $('btnVacuum').disabled = false;
  loadDbStats(); engineStatus();
};
$('btnCleanup').onclick = async () => {
  const days = Math.max(1, parseInt($('dbDays').value, 10) || 30);
  $('dbDays').value = days;
  if (!confirm('Delete closed observations with their snapshots and resolved patterns older than ' + days + ' days? This cannot be undone.')) return;
  const r = await api.post('/api/db/cleanup', { days });
  if (r.error) return toast(r.error, true);
  toast('deleted: observations ' + r.entries + ', snapshots ' + r.snapshots + ', patterns ' + r.formations + '. Press VACUUM to compact');
  loadDbStats();
};

/* ── private API keys ── */
async function loadKeys() {
  const keys = await api.get('/api/keys');
  const tb = $('keysTable').querySelector('tbody');
  if (!keys.length) {
    tb.innerHTML = '<tr><td colspan="6" style="color:var(--dim)">no keys: the app works with public endpoints</td></tr>';
    return;
  }
  tb.innerHTML = keys.map(k => `<tr data-ex="${k.exchange}">
    <td style="color:#fff">${k.exchange}</td>
    <td>${k.masked}</td>
    <td class="hint">${new Date(k.saved_at).toLocaleString()}</td>
    <td class="kResult hint">—</td>
    <td><button class="kVerify">VERIFY</button></td>
    <td><button class="kDel danger">✕</button></td>
  </tr>`).join('');
  tb.querySelectorAll('tr').forEach(tr => {
    const ex = tr.dataset.ex;
    const out = tr.querySelector('.kResult');
    tr.querySelector('.kVerify').onclick = async () => {
      out.textContent = 'checking…'; out.className = 'kResult hint';
      const r = await api.post('/api/keys/' + ex + '/verify');
      if (r.ok) {
        const perms = [];
        perms.push(r.enableReading ? 'read ✓' : '<span class="err">no read permission!</span>');
        perms.push('IP: ' + (r.ipRestrict ? 'restricted' : 'unrestricted'));
        if (r.enableSpotTrading) perms.push('<span class="err">spot trading enabled</span>');
        if (r.enableFutures) perms.push('<span class="err">futures trading enabled</span>');
        if (r.enableWithdrawals) perms.push('<span class="err">WITHDRAWALS ENABLED: turn them off!</span>');
        if (!r.enableSpotTrading && !r.enableFutures && !r.enableWithdrawals) perms.push('read-only ✓');
        out.innerHTML = `<span class="ok">✓ key is valid</span> · ` + perms.join(' · ');
      } else {
        out.innerHTML = `<span class="err">✗ ${r.error}</span>`;
      }
    };
    tr.querySelector('.kDel').onclick = async () => {
      if (!confirm('Delete the ' + ex + ' key?')) return;
      await api.del('/api/keys/' + ex);
      loadKeys();
      toast('key deleted');
    };
  });
}
$('btnKeySave').onclick = async () => {
  const key = $('keyApi').value.trim(), secret = $('keySecret').value.trim();
  if (key.length < 10 || secret.length < 10) return toast('enter the API Key and API Secret', true);
  const r = await api.put('/api/keys/' + $('keyExchange').value, { key, secret });
  if (r.error) return toast(r.error, true);
  $('keyApi').value = ''; $('keySecret').value = '';
  loadKeys();
  toast('key saved (encrypted): press VERIFY');
};

/* ── start ── */
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
