/* Candlestick chart renderer:
   candles + volumes (bottom 1/4), horizontal level segments, vertical markers,
   wheel zoom and drag panning. Draws in physical pixels. */
"use strict";
const Chart = (() => {
  const UP = '#4E966F', DOWN = '#DD3742', BG = '#181818';

  /* state: {bars, view:{start,count}, overlays}, stored on the canvas itself */
  function attach(canvas) {
    const st = { bars: [], overlays: null, view: null, drag: null };
    canvas.__chart = st;

    canvas.addEventListener('wheel', ev => {
      if (!st.bars.length) return;
      ev.preventDefault();
      const v = st.view;
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newCount = Math.max(20, Math.min(st.bars.length, Math.round(v.count * factor)));
      /* anchor the right edge */
      const right = v.start + v.count;
      v.count = newCount;
      v.start = Math.max(0, right - newCount);
      render(canvas);
    }, { passive: false });

    canvas.addEventListener('mousedown', ev => {
      st.drag = { x: ev.clientX, start: st.view ? st.view.start : 0 };
    });
    window.addEventListener('mousemove', ev => {
      if (!st.drag || !st.view) return;
      const dx = ev.clientX - st.drag.x;
      const slotPx = canvas.clientWidth / st.view.count;
      const shift = Math.round(-dx / slotPx);
      st.view.start = Math.max(0, Math.min(st.bars.length - st.view.count, st.drag.start + shift));
      render(canvas);
    });
    window.addEventListener('mouseup', () => { st.drag = null; });
    return st;
  }

  /* set data: bars is an array of {t,o,h,l,c,v,q}, overlays: see render */
  function setData(canvas, bars, overlays, visibleCount) {
    const st = canvas.__chart || attach(canvas);
    st.bars = bars || [];
    st.overlays = overlays || null;
    const count = Math.min(st.bars.length, visibleCount || st.bars.length);
    st.view = { start: Math.max(0, st.bars.length - count), count };
    render(canvas);
  }

  function barIndexByTs(bars, ts) {
    /* the bar containing moment ts (bars in ascending time order) */
    if (!bars.length || ts < bars[0].t) return -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].t <= ts) return i;
    }
    return -1;
  }

  function render(canvas) {
    const st = canvas.__chart;
    if (!st) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    const bars = st.bars, v = st.view;
    if (!bars.length || !v) return;

    const slice = bars.slice(v.start, v.start + v.count);
    const n = slice.length;
    if (!n) return;

    const rightPad = W * 0.08;
    const plotW = W - rightPad;
    const slot = plotW / n;
    const priceH = H * 0.75, volH = H - priceH;

    let lo = Infinity, hi = -Infinity, vmax = 0;
    for (const k of slice) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; if (k.q > vmax) vmax = k.q; }
    /* overlay levels are included in the scale so they don't go off the edge */
    if (st.overlays && st.overlays.levels) {
      for (const L of st.overlays.levels) {
        if (L.price > 0 && L.scale !== false) { if (L.price < lo) lo = L.price; if (L.price > hi) hi = L.price; }
      }
    }
    const pad = (hi - lo) * 0.08 || hi * 0.001 || 1;
    const top = hi + pad, bot = lo - pad, span = (top - bot) || 1;
    const yOf = p => ((top - p) / span) * priceH;
    const xOf = i => (i - v.start) * slot + slot / 2;   // i is the global bar index

    const lineMode = slot < 4 * dpr;
    const bw = Math.max(Math.round(3 * dpr), Math.floor(slot * 0.72));
    const ww = Math.max(1, Math.round(dpr));

    /* candles + volumes */
    for (let j = 0; j < n; j++) {
      const k = slice[j], cxF = j * slot + slot / 2, up = k.c >= k.o;
      ctx.fillStyle = up ? UP : DOWN;
      const yH = Math.round(yOf(k.h)), yL = Math.round(yOf(k.l));
      if (lineMode) {
        const lw = Math.max(1, Math.round(slot * 0.85));
        ctx.fillRect(Math.round(cxF - lw / 2), yH, lw, Math.max(1, yL - yH));
      } else {
        const bx = Math.round(cxF - bw / 2);
        ctx.fillRect(Math.round(bx + bw / 2 - ww / 2), yH, ww, Math.max(1, yL - yH));
        const yO = Math.round(yOf(k.o)), yC = Math.round(yOf(k.c));
        ctx.fillRect(bx, Math.min(yO, yC), bw, Math.max(1, Math.abs(yC - yO)));
      }
      if (vmax > 0) {
        const vh = (k.q / vmax) * volH * 0.95;
        ctx.globalAlpha = .5;
        const vw = lineMode ? Math.max(1, Math.round(slot * 0.85)) : bw;
        ctx.fillRect(Math.round(cxF - vw / 2), Math.round(H - vh), vw, Math.max(1, Math.round(vh)));
        ctx.globalAlpha = 1;
      }
    }

    if (!st.overlays) return;
    const o = st.overlays;
    const lastX = xOf(bars.length - 1);
    const lw = Math.max(1, Math.round(dpr));
    const dash = [Math.max(2, Math.round(2 * dpr)), Math.max(2, Math.round(3 * dpr))];
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace,Consolas,monospace`;

    /* vertical markers (signal etc.): {ts, color, label} */
    for (const m of (o.vlines || [])) {
      const gi = barIndexByTs(bars, m.ts);
      if (gi < 0) continue;
      const x = Math.round(xOf(gi));
      if (x < 0 || x > plotW + rightPad) continue;
      ctx.save();
      ctx.setLineDash(dash); ctx.lineWidth = lw; ctx.strokeStyle = m.color || '#56b6c2';
      ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, priceH); ctx.stroke();
      if (m.label) { ctx.fillStyle = m.color || '#56b6c2'; ctx.fillText(m.label, x + 3 * dpr, 10 * dpr); }
      ctx.restore();
    }

    /* arrows above a bar: {ts, color}, tip above the bar high, pointing down */
    for (const m of (o.marks || [])) {
      const gi = barIndexByTs(bars, m.ts);
      if (gi < v.start || gi >= v.start + n) continue;
      const x = Math.round(xOf(gi));
      const tip = Math.max(Math.round(7 * dpr), Math.round(yOf(bars[gi].h)) - 3 * dpr);
      const half = Math.max(3, Math.round(3.5 * dpr)), ah = Math.round(6 * dpr);
      ctx.fillStyle = m.color || '#fff';
      ctx.beginPath();
      ctx.moveTo(x, tip); ctx.lineTo(x - half, tip - ah); ctx.lineTo(x + half, tip - ah);
      ctx.closePath(); ctx.fill();
    }

    /* horizontal level segments: {price, fromTs, color, dash, label}
       a segment from bar fromTs (or the left edge) to the right edge of the data */
    const labels = [];
    for (const L of (o.levels || [])) {
      if (!(L.price > 0)) continue;
      let x1 = 0;
      if (L.fromTs) {
        const gi = barIndexByTs(bars, L.fromTs);
        if (gi >= 0) x1 = xOf(gi);
      }
      let y = Math.round(yOf(L.price)); if (lw % 2 === 1) y += 0.5;
      if (y < 0 || y > priceH) continue;
      ctx.save();
      if (L.dash !== false) ctx.setLineDash(dash);
      ctx.lineWidth = lw; ctx.strokeStyle = L.color;
      ctx.beginPath(); ctx.moveTo(Math.max(0, x1), y); ctx.lineTo(lastX, y); ctx.stroke();
      ctx.restore();
      if (L.label) labels.push({ name: L.label, price: String(L.price), color: L.color,
        y: L.labelBelow ? y + 10 * dpr : y - 2 * dpr });   // labelBelow: label under the line
    }

    /* level labels without overlaps: coinciding lines merge into one label
       ("k2·SIG"), the rest are pushed apart vertically in a greedy pass */
    if (labels.length) {
      const gap = Math.round(10 * dpr), mergeEps = 6 * dpr;
      const topY = Math.round(9 * dpr), botY = priceH - Math.round(2 * dpr);
      labels.sort((a, b) => a.y - b.y);
      const rows = [];
      for (const l of labels) {
        const last = rows[rows.length - 1];
        if (last && l.y - last.y < mergeEps) last.items.push(l);
        else rows.push({ y: l.y, color: l.color, items: [l] });
      }
      rows[0].y = Math.max(rows[0].y, topY);
      for (let i = 1; i < rows.length; i++) rows[i].y = Math.max(rows[i].y, rows[i - 1].y + gap);
      rows[rows.length - 1].y = Math.min(rows[rows.length - 1].y, botY);
      for (let i = rows.length - 2; i >= 0; i--) rows[i].y = Math.min(rows[i].y, rows[i + 1].y - gap);
      for (const r of rows) {
        /* level names only, no prices: levels with the same price print as "k2·SIG",
           different ones are joined with " · " (price grouping is kept for this merge) */
        const groups = [];
        for (const it of r.items) {
          const g = groups[groups.length - 1];
          if (g && g.price === it.price) g.names.push(it.name);
          else groups.push({ names: [it.name], price: it.price });
        }
        const t = groups.map(g => g.names.join('·')).join(' · ');
        ctx.fillStyle = r.color;
        ctx.fillText(t, Math.min(lastX + 4 * dpr, W - ctx.measureText(t).width - 2 * dpr), r.y);
      }
    }
  }

  return { setData, render, barIndexByTs };
})();
