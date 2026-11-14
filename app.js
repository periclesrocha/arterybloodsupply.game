/* Arterial tree game. Plain JS, no dependencies. */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Tree data
  // ------------------------------------------------------------------
  const nodes = [];
  function build(src, parent, depth) {
    const n = {
      id: 'n' + nodes.length,
      label: src.label,
      supplies: src.supplies || '',
      note: src.note || '',
      parent, depth,
      children: []
    };
    nodes.push(n);
    if (parent) parent.children.push(n);
    (src.children || []).forEach(c => build(c, n, depth + 1));
    return n;
  }
  const root = build(window.ARTERY_TREE, null, 0);
  nodes.forEach(n => { n.isLeaf = n.children.length === 0; });
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const TOTAL = nodes.length;
  const MAX_DEPTH = Math.max(...nodes.map(n => n.depth));
  const bfs = [];
  for (const q = [root]; q.length;) { const n = q.shift(); bfs.push(n); q.push(...n.children); }

  // ------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const el = {
    viewport: $('viewport'), sizer: $('sizer'), stage: $('stage'), svg: $('vessels'),
    cards: $('cards'), bank: $('bank'), bankCount: $('bankCount'), bankEmpty: $('bankEmpty'),
    filter: $('filter'), toast: $('toast'), popover: $('popover'),
    modeLine: $('modeLine'), time: $('statTime'), score: $('statScore'),
    mistakes: $('statMistakes'), hints: $('statHints'), progress: $('progressFill'),
    btnHint: $('btnHint'), btnCheck: $('btnCheck'), btnReveal: $('btnReveal'), btnNew: $('btnNew'),
    btnBoard: $('btnBoard'), nickInput: $('nickInput'), nickHint: $('nickHint'),
    boardDialog: $('boardDialog'), boardBody: $('boardBody'), boardNote: $('boardNote'), boardClose: $('boardClose'),
    btnSound: $('btnSound'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'),
    zoomLevel: $('zoomLevel'),
    intro: $('introDialog'), introForm: $('introForm'), strictInput: $('strictInput'),
    result: $('resultDialog'), resultTitle: $('resultTitle'), resultText: $('resultText'),
    resultStats: $('resultStats'), resultBest: $('resultBest'), resultActions: $('resultActions'),
    confirm: $('confirmDialog'), confirmTitle: $('confirmTitle'), confirmText: $('confirmText'),
    confirmYes: $('confirmYes'), confirmNo: $('confirmNo')
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ------------------------------------------------------------------
  // Storage (best effort)
  // ------------------------------------------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('arteries.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('arteries.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  // ------------------------------------------------------------------
  // Scoring and nicknames
  // ------------------------------------------------------------------
  // Keep these in step with the score_ms formula in supabase/leaderboard.sql
  const MISTAKE_PENALTY_MS = 10000;
  const HINT_PENALTY_MS = 20000;
  const MIN_TIME_MS = 30000; // the database rejects anything faster
  const scoreOf = (timeMs, mistakes, hints) => timeMs + mistakes * MISTAKE_PENALTY_MS + hints * HINT_PENALTY_MS;
  const cleanNick = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const nickKey = v => cleanNick(v).toLowerCase();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const boardLabel = (mode, slide) => (mode === 'test' ? 'Test' : 'Practice') + (slide ? ' (slide order)' : '');

  // ------------------------------------------------------------------
  // Global leaderboard (Supabase REST). Off until config.js has both values.
  // ------------------------------------------------------------------
  const LBCFG = window.LEADERBOARD || {};
  const lb = {
    on: !!(LBCFG.supabaseUrl && LBCFG.supabaseKey),
    url(path) { return String(LBCFG.supabaseUrl).replace(/\/+$/, '') + '/rest/v1/' + path; },
    headers(extra) {
      const h = Object.assign({ apikey: LBCFG.supabaseKey }, extra || {});
      // Legacy anon keys are JWTs and also go in Authorization; publishable keys must not
      if (/^eyJ/.test(LBCFG.supabaseKey)) h.Authorization = 'Bearer ' + LBCFG.supabaseKey;
      return h;
    },
    async req(path, opts = {}) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await fetch(this.url(path), Object.assign({}, opts, { headers: this.headers(opts.headers), signal: ctl.signal }));
        const text = await r.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!r.ok) {
          const err = new Error((body && (body.message || body.msg)) || ('HTTP ' + r.status));
          err.status = r.status; err.code = body && body.code;
          throw err;
        }
        return body;
      } finally { clearTimeout(timer); }
    },
    submit(run) {
      return this.req('scores', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(run) });
    },
    board(mode, slide) {
      return this.req(`leaderboard?select=nickname,nickname_key,score_ms,time_ms,mistakes,hints,runs,created_at&mode=eq.${mode}&slide_order=eq.${slide ? 'true' : 'false'}&order=score_ms.asc,created_at.asc&limit=500`);
    },
    runs(key) {
      const quoted = '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      return this.req(`scores?select=nickname,mode,slide_order,score_ms,time_ms,mistakes,hints,created_at&nickname_key=eq.${encodeURIComponent(quoted)}&order=created_at.desc&limit=200`);
    }
  };
  // Network trouble, server errors and the 15 s cooldown are worth retrying later
  const retryable = e => !e.status || e.status >= 500 || e.code === '42501';

  function queueRun(run) {
    const list = store.get('pending', []);
    list.push(run);
    store.set('pending', list.slice(-50));
  }
  async function flushPending() {
    if (!lb.on) return;
    const list = store.get('pending', []);
    if (!list.length) return;
    const keep = [], seen = new Set();
    for (const run of list) {
      const k = nickKey(run.nickname);
      if (seen.has(k)) { keep.push(run); continue; } // one per nickname per visit (cooldown)
      seen.add(k);
      try { await lb.submit(run); } catch (e) { if (retryable(e)) keep.push(run); }
    }
    store.set('pending', keep);
  }

  // ------------------------------------------------------------------
  // Sound: a soft heartbeat for a correct branch, a dull buzz for a miss
  // ------------------------------------------------------------------
  const sound = {
    ctx: null,
    on: store.get('sound', true),
    ensure() {
      if (!this.on) return null;
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          this.ctx = new AC();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { return null; }
      return this.ctx;
    },
    tone(t, { type = 'sine', f0, f1, dur, vol, lp }) {
      const c = this.ctx;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      let node = o;
      if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
      node.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    beat(at = 0, vol = 0.5) {
      const c = this.ensure(); if (!c) return;
      const t = c.currentTime + at;
      // "lub" then "dub": a low body plus a triangle overtone so laptop speakers carry it
      this.tone(t, { f0: 140, f1: 55, dur: 0.17, vol });
      this.tone(t, { type: 'triangle', f0: 280, f1: 120, dur: 0.09, vol: vol * 0.35 });
      this.tone(t + 0.19, { f0: 120, f1: 50, dur: 0.15, vol: vol * 0.7 });
      this.tone(t + 0.19, { type: 'triangle', f0: 240, f1: 110, dur: 0.08, vol: vol * 0.25 });
    },
    correct() { this.beat(0, 0.42); },
    wrong() {
      const c = this.ensure(); if (!c) return;
      this.tone(c.currentTime, { type: 'square', f0: 120, f1: 85, dur: 0.16, vol: 0.06, lp: 700 });
    },
    finish() {
      const c = this.ensure(); if (!c) return;
      this.beat(0, 0.5); this.beat(0.85, 0.5);
      const t = c.currentTime + 1.7;
      [523.25, 659.25, 783.99].forEach((f, i) => this.tone(t + i * 0.09, { type: 'triangle', f0: f, dur: 1.1, vol: 0.06 }));
    }
  };

  // ------------------------------------------------------------------
  // Layout: one column per depth, leaves stacked, parents centered on children
  // ------------------------------------------------------------------
  const L = { left: 40, top: 36, right: 26, bottom: 72, colGap: 42, leafGap: 6, groupGap: 12, hTall: 44, hShort: 28, tallDepth: 2, tallMax: [128, 158, 158] };
  let stageW = 0, stageH = 0;

  function layout() {
    const probe = document.createElement('div');
    probe.className = 'slot probe';
    const span = document.createElement('span');
    span.className = 'slot-label';
    probe.appendChild(span);
    document.body.appendChild(probe);
    const natural = new Map();
    nodes.forEach(n => { span.textContent = n.label; natural.set(n, probe.offsetWidth + 8); });
    probe.remove();

    const colW = [], colX = [];
    for (let d = 0; d <= MAX_DEPTH; d++) {
      let w = Math.max(...nodes.filter(n => n.depth === d).map(n => natural.get(n)));
      if (d <= L.tallDepth) w = Math.min(w, L.tallMax[d]);
      colW[d] = Math.max(112, Math.ceil(w));
    }
    let x = L.left;
    for (let d = 0; d <= MAX_DEPTH; d++) { colX[d] = x; x += colW[d] + L.colGap; }
    stageW = x - L.colGap + L.right;

    let y = L.top, prevParent;
    (function place(n) {
      n.w = colW[n.depth];
      n.h = n.depth <= L.tallDepth ? L.hTall : L.hShort;
      n.x = colX[n.depth];
      if (n.isLeaf) {
        if (prevParent !== undefined && prevParent !== n.parent) y += L.groupGap;
        n.y = y; y += n.h + L.leafGap; prevParent = n.parent;
      } else {
        n.children.forEach(place);
        const a = n.children[0], b = n.children[n.children.length - 1];
        n.y = Math.round(((a.y + a.h / 2) + (b.y + b.h / 2)) / 2 - n.h / 2);
      }
      n.cy = n.y + n.h / 2;
    })(root);
    stageH = y - L.leafGap + L.bottom;
  }

  // ------------------------------------------------------------------
  // Build the tree DOM: vessels (SVG) + slots
  // ------------------------------------------------------------------
  const VESSEL_W = [11, 9, 7.2, 5.6, 4.4, 3.4, 2.6];
  let stubPath = null;

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildTree() {
    el.svg.innerHTML = '';
    el.svg.setAttribute('width', stageW);
    el.svg.setAttribute('height', stageH);
    el.svg.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
    el.stage.style.width = stageW + 'px';
    el.stage.style.height = stageH + 'px';

    const gWall = svgEl('g', {}, el.svg);
    const gLumen = svgEl('g', {}, el.svg);
    const gBWall = svgEl('g', {}, el.svg);
    const gBLumen = svgEl('g', {}, el.svg);
    const gPulse = svgEl('g', {}, el.svg);

    // The trunk coming in from the heart, always full
    const sd = `M 8 ${root.cy} H ${root.x}`;
    svgEl('path', { d: sd, class: 'heart-stub-wall', 'stroke-width': VESSEL_W[0] + 2 }, gBWall);
    svgEl('path', { d: sd, class: 'heart-stub', 'stroke-width': VESSEL_W[0] }, gBLumen);
    stubPath = svgEl('path', { d: sd, class: 'pulse', 'stroke-width': VESSEL_W[0] * 0.55 }, gPulse);
    stubPath.len = root.x - 8;

    nodes.forEach(n => {
      if (!n.parent) return;
      const p = n.parent;
      const x1 = p.x + p.w - 2, y1 = p.cy, x2 = n.x + 2, y2 = n.cy;
      const k = (x2 - x1) * 0.55;
      const d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
      const w = VESSEL_W[Math.min(n.depth, VESSEL_W.length - 1)];
      svgEl('path', { d, class: 'v-wall', 'stroke-width': w + 2, 'data-depth': n.depth }, gWall);
      svgEl('path', { d, class: 'v-lumen', 'stroke-width': w, 'data-depth': n.depth }, gLumen);
      const bw = svgEl('path', { d, class: 'b-wall', 'stroke-width': w + 2 }, gBWall);
      const bl = svgEl('path', { d, class: 'b-lumen', 'stroke-width': w }, gBLumen);
      const pu = svgEl('path', { d, class: 'pulse', 'stroke-width': Math.max(1.4, w * 0.55) }, gPulse);
      const len = bl.getTotalLength();
      n.vessel = { wall: bw, lumen: bl, pulse: pu, len };
      [bw, bl].forEach(pe => { pe.style.strokeDasharray = `${len} ${len}`; pe.style.strokeDashoffset = len; });
      pu.style.strokeDasharray = `0 ${len + 100}`;
    });

    el.stage.querySelectorAll('.slot').forEach(s => s.remove());
    nodes.forEach(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.dataset.id = n.id;
      b.style.left = n.x + 'px';
      b.style.top = n.y + 'px';
      b.style.width = n.w + 'px';
      b.style.height = n.h + 'px';
      const s = document.createElement('span');
      s.className = 'slot-label';
      b.appendChild(s);
      n.el = b; n.labelEl = s;
      el.stage.appendChild(b);
    });
  }

  // One orchestrated moment on load: the empty vessels draw outward from the heart
  function drawIn() {
    if (reduceMotion.matches) return;
    const paths = el.svg.querySelectorAll('.v-wall, .v-lumen');
    paths.forEach(p => {
      const len = p.getTotalLength();
      const delay = (+p.dataset.depth || 0) * 140;
      p.animate([{ strokeDasharray: `0 ${len}` }, { strokeDasharray: `${len} 0` }],
        { duration: 520, delay, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'backwards' });
    });
    nodes.forEach(n => {
      n.el.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 360, delay: 120 + n.depth * 140, easing: 'ease-out', fill: 'backwards' });
    });
  }

  // ------------------------------------------------------------------
  // Zoom & pan
  // ------------------------------------------------------------------
  let scale = 1;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function pads(s) {
    const vp = el.viewport;
    return { x: Math.max(0, (vp.clientWidth - stageW * s) / 2), y: Math.max(0, (vp.clientHeight - stageH * s) / 2) };
  }

  function setScale(s, fx, fy) {
    s = clamp(s, 0.3, 1.8);
    const vp = el.viewport;
    const r = vp.getBoundingClientRect();
    if (fx == null) { fx = r.left + vp.clientWidth / 2; fy = r.top + vp.clientHeight / 2; }
    const p0 = pads(scale);
    const cx = (vp.scrollLeft + fx - r.left - p0.x) / scale;
    const cy = (vp.scrollTop + fy - r.top - p0.y) / scale;
    scale = s;
    const p1 = pads(s);
    el.sizer.style.width = stageW * s + 'px';
    el.sizer.style.height = stageH * s + 'px';
    el.sizer.style.marginLeft = p1.x + 'px';
    el.sizer.style.marginTop = p1.y + 'px';
    el.stage.style.transform = `scale(${s})`;
    vp.scrollLeft = cx * s + p1.x - (fx - r.left);
    vp.scrollTop = cy * s + p1.y - (fy - r.top);
    el.zoomLevel.textContent = Math.round(s * 100) + '%';
    hidePopover();
  }

  function fitWidth() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const s = clamp((el.viewport.clientWidth - 8) / stageW, coarse ? 0.8 : 0.66, 1.15);
    setScale(s);
    el.viewport.scrollLeft = 0;
    // Start with the root and its first branches in view
    el.viewport.scrollTop = Math.max(0, (root.cy * s) - el.viewport.clientHeight * 0.42);
  }
  function fitAll() {
    const vp = el.viewport;
    setScale(Math.min((vp.clientWidth - 12) / stageW, (vp.clientHeight - 12) / stageH));
  }

  function scrollNodeIntoView(n, smooth = true) {
    const vp = el.viewport;
    const p = pads(scale);
    const left = n.x * scale + p.x, top = n.y * scale + p.y;
    const w = n.w * scale, h = n.h * scale;
    const margin = 60;
    let sl = vp.scrollLeft, st = vp.scrollTop;
    if (left < sl + margin) sl = left - margin;
    else if (left + w > sl + vp.clientWidth - margin) sl = left + w - vp.clientWidth + margin;
    if (top < st + margin) st = top - vp.clientHeight / 3;
    else if (top + h > st + vp.clientHeight - margin) st = top + h - vp.clientHeight * 0.66;
    vp.scrollTo({ left: sl, top: st, behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
  }

  el.zoomIn.addEventListener('click', () => setScale(scale * 1.2));
  el.zoomOut.addEventListener('click', () => setScale(scale / 1.2));
  el.zoomFit.addEventListener('click', fitAll);

  el.viewport.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setScale(scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
  }, { passive: false });

  // Safari trackpad pinch
  let gestureStart = 1;
  el.viewport.addEventListener('gesturestart', e => { e.preventDefault(); gestureStart = scale; });
  el.viewport.addEventListener('gesturechange', e => { e.preventDefault(); setScale(gestureStart * e.scale, e.clientX, e.clientY); });

  // Mouse drag on empty canvas pans the tree
  let pan = null;
  el.viewport.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('.slot')) return;
    pan = { x: e.clientX, y: e.clientY, sl: el.viewport.scrollLeft, st: el.viewport.scrollTop, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) > 3) { pan.moved = true; el.viewport.classList.add('panning'); hidePopover(); }
    if (pan.moved) { el.viewport.scrollLeft = pan.sl - dx; el.viewport.scrollTop = pan.st - dy; }
  });
  window.addEventListener('pointerup', () => { if (pan) { el.viewport.classList.remove('panning'); pan = null; } });

  el.viewport.addEventListener('scroll', () => { if (!drag) hidePopover(); }, { passive: true });
  window.addEventListener('resize', () => setScale(scale));

  // ------------------------------------------------------------------
  // Game state
  // ------------------------------------------------------------------
  let S = null;            // current game
  const cardEls = new Map();

  function newState(mode, strict) {
    const cards = nodes.map((n, i) => ({ id: 'c' + i, label: n.label, slot: null, rand: Math.random() }));
    return {
      mode, strict,
      nick: cleanNick(store.get('nickname', '')),
      cards, cardById: new Map(cards.map(c => [c.id, c])),
      slotCard: new Map(),   // slotId -> cardId
      locked: new Set(),     // slots confirmed correct
      wrong: new Set(),      // slots flagged wrong after a check (test mode)
      revealed: new Map(),   // slotId -> label shown by "Show answers"
      mistakes: 0, hints: 0, streak: 0, bestStreak: 0,
      startedAt: 0, elapsed: 0, running: false, finished: false,
      checks: 0, firstScore: null,
      selected: null,
      sort: store.get('sort', 'shuffle'),
      filter: ''
    };
  }

  const labelAt = slotId => { const c = S.slotCard.get(slotId); return c ? S.cardById.get(c).label : null; };
  const leafSiblings = n => n.parent ? n.parent.children.filter(s => s.isLeaf) : [n];
  function countMap(arr) { const m = new Map(); arr.forEach(v => m.set(v, (m.get(v) || 0) + 1)); return m; }

  // Practice mode: is `label` an acceptable answer for slot `n` right now?
  // Leaves under the same parent are interchangeable unless "same order as the slides" is on.
  function acceptable(label, n) {
    if (n.label === label) return true;
    if (S.strict || !n.isLeaf || !n.parent) return false;
    const sibs = leafSiblings(n);
    const remaining = countMap(sibs.map(s => s.label));
    sibs.forEach(s => {
      if (s !== n && S.locked.has(s.id)) {
        const l = labelAt(s.id);
        remaining.set(l, (remaining.get(l) || 0) - 1);
      }
    });
    return (remaining.get(label) || 0) > 0;
  }

  // Test mode: grade every filled slot at once
  function grade() {
    const result = new Map();
    nodes.forEach(n => {
      if (!S.slotCard.has(n.id)) return;
      if (S.strict || !n.isLeaf || !n.parent) result.set(n.id, labelAt(n.id) === n.label);
    });
    if (!S.strict) {
      nodes.filter(p => !p.isLeaf).forEach(p => {
        const leaves = p.children.filter(c => c.isLeaf);
        if (!leaves.length) return;
        const remaining = countMap(leaves.map(l => l.label));
        const take = l => remaining.set(l, remaining.get(l) - 1);
        leaves.forEach(l => { const v = labelAt(l.id); if (v != null && v === l.label) { result.set(l.id, true); take(v); } });
        const rest = leaves.filter(l => !result.has(l.id) && S.slotCard.has(l.id));
        rest.sort((a, b) => (S.locked.has(b.id) ? 1 : 0) - (S.locked.has(a.id) ? 1 : 0));
        rest.forEach(l => {
          const v = labelAt(l.id);
          if ((remaining.get(v) || 0) > 0) { result.set(l.id, true); take(v); } else result.set(l.id, false);
        });
      });
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  }
  const elapsed = () => S.running ? Date.now() - S.startedAt : S.elapsed;

  function setVessel(n, mode) { // mode: 'empty' | 'full' | 'revealed'
    if (!n.vessel) return;
    const { wall, lumen, len } = n.vessel;
    const full = mode !== 'empty';
    [wall, lumen].forEach(p => {
      p.style.strokeDashoffset = full ? 0 : len;
      p.classList.toggle('is-revealed', mode === 'revealed');
    });
  }

  function renderSlots() {
    const placing = !!S.selected;
    nodes.forEach(n => {
      const b = n.el;
      const label = labelAt(n.id);
      const rev = S.revealed.get(n.id);
      const locked = S.locked.has(n.id);
      const wrong = S.wrong.has(n.id);
      const shown = label != null ? label : (rev || '');
      if (n.labelEl.textContent !== shown) n.labelEl.textContent = shown;
      b.classList.toggle('filled', label != null && !locked && !wrong);
      b.classList.toggle('correct', locked);
      b.classList.toggle('wrong', wrong);
      b.classList.toggle('revealed', !!rev && label == null);
      b.classList.toggle('movable', S.mode === 'test' && label != null && !locked && S.running);
      b.classList.toggle('open', placing && !locked && !S.finished && (S.mode === 'test' || label == null));
      setVessel(n, locked ? 'full' : rev ? 'revealed' : 'empty');
      let aria;
      if (locked) aria = `${label}, correct. Press for details.`;
      else if (wrong) aria = `${label}, wrong place.`;
      else if (label) aria = `${label}, placed.`;
      else if (rev) aria = `${rev}, answer shown.`;
      else aria = `Empty box, level ${n.depth + 1}${n.parent && S.locked.has(n.parent.id) ? ', branch of ' + labelAt(n.parent.id) : ''}.`;
      b.setAttribute('aria-label', aria);
    });
  }

  function sortedCards() {
    const list = S.cards.slice();
    if (S.sort === 'az') list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    else list.sort((a, b) => a.rand - b.rand);
    return list;
  }

  function buildCards() {
    el.cards.innerHTML = '';
    cardEls.clear();
    S.cards.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card';
      b.dataset.card = c.id;
      b.textContent = c.label;
      cardEls.set(c.id, b);
    });
    bankOrderKey = '';
  }

  let bankOrderKey = '';
  function renderBank() {
    const q = S.filter.trim().toLowerCase();
    let left = 0, visible = 0;
    const order = sortedCards();
    const key = order.map(c => c.id).join(',');
    if (key !== bankOrderKey) { order.forEach(c => el.cards.appendChild(cardEls.get(c.id))); bankOrderKey = key; }
    order.forEach(c => {
      const b = cardEls.get(c.id);
      const inBank = c.slot == null && !S.finished;
      if (inBank) left++;
      const show = inBank && (!q || c.label.toLowerCase().includes(q));
      if (show) visible++;
      b.hidden = !show;
      b.classList.toggle('selected', S.selected === c.id);
      b.setAttribute('aria-pressed', S.selected === c.id ? 'true' : 'false');
    });
    el.bankCount.textContent = left === 1 ? '1 term left' : `${left} terms left`;
    let msg = '';
    if (S.finished && S.revealed.size) msg = 'Answers are shown in the tree. Start a new game to try again.';
    else if (S.finished) msg = 'Every term is in place. Select any box in the tree to see what it supplies.';
    else if (left === 0 && S.mode === 'test') msg = 'Every term is placed. Check your answers when you are ready.';
    else if (left > 0 && visible === 0) msg = `No terms match “${S.filter.trim()}”.`;
    el.bankEmpty.textContent = msg;
    el.bankEmpty.hidden = !msg;
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.sort === S.sort ? 'true' : 'false'));
  }

  function renderStats() {
    el.time.textContent = fmtTime(elapsed());
    el.score.textContent = fmtTime(scoreOf(elapsed(), S.mistakes, S.hints));
    el.mistakes.textContent = S.mode === 'test' && S.checks === 0 ? '–' : S.mistakes;
    el.hints.textContent = S.hints;
    el.progress.style.width = (S.locked.size / TOTAL * 100) + '%';
    el.modeLine.textContent = (S.nick ? S.nick + ' playing ' : '') + (S.mode === 'practice' ? 'Practice' : 'Test') + (S.strict ? ', branches in slide order' : ', any order within a branch');
    el.btnCheck.hidden = S.mode !== 'test';
    el.btnCheck.disabled = !S.running || S.slotCard.size === S.locked.size;
    el.btnHint.disabled = !S.running;
    el.btnReveal.disabled = !S.running;
    document.body.classList.toggle('placing', !!S.selected);
  }

  function render() { renderSlots(); renderBank(); renderStats(); }

  setInterval(() => {
    if (!S || !S.running) return;
    el.time.textContent = fmtTime(elapsed());
    el.score.textContent = fmtTime(scoreOf(elapsed(), S.mistakes, S.hints));
  }, 250);

  // ------------------------------------------------------------------
  // Feedback helpers
  // ------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }
  function flash(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // restart the animation
    node.classList.add(cls);
    node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
  }

  // ------------------------------------------------------------------
  // Placing terms
  // ------------------------------------------------------------------
  // Returns 'correct' | 'wrong' | 'placed' | 'ignored'
  function place(cardId, slotId, fromSlotId) {
    if (!S.running) return 'ignored';
    const n = nodeById.get(slotId);
    const card = S.cardById.get(cardId);
    if (S.locked.has(slotId) || fromSlotId === slotId) return 'ignored';

    if (S.mode === 'practice') {
      if (S.slotCard.has(slotId)) return 'ignored';
      if (acceptable(card.label, n)) {
        S.slotCard.set(slotId, cardId);
        card.slot = slotId;
        S.locked.add(slotId);
        S.streak++; S.bestStreak = Math.max(S.bestStreak, S.streak);
        if (S.selected === cardId) S.selected = null;
        sound.correct();
        render();
        flash(n.el, 'pop');
        if (S.locked.size === TOTAL) finish();
        return 'correct';
      }
      S.mistakes++; S.streak = 0;
      sound.wrong();
      flash(n.el, 'shake');
      const cb = cardEls.get(cardId);
      if (cb) flash(cb, 'shake');
      toast(`${card.label} doesn’t go there.`);
      renderStats();
      return 'wrong';
    }

    // Test mode: anything goes until you check
    const existing = S.slotCard.get(slotId);
    if (fromSlotId) S.slotCard.delete(fromSlotId);
    if (existing && existing !== cardId) {
      const ex = S.cardById.get(existing);
      if (fromSlotId) { S.slotCard.set(fromSlotId, existing); ex.slot = fromSlotId; }
      else ex.slot = null;
    }
    S.slotCard.set(slotId, cardId);
    card.slot = slotId;
    S.wrong.delete(slotId);
    if (fromSlotId) S.wrong.delete(fromSlotId);
    if (S.selected === cardId) S.selected = null;
    render();
    flash(n.el, 'pop');
    return 'placed';
  }

  function returnToBank(slotId) {
    const cid = S.slotCard.get(slotId);
    if (!cid || S.locked.has(slotId)) return;
    S.slotCard.delete(slotId);
    S.cardById.get(cid).slot = null;
    S.wrong.delete(slotId);
    render();
  }

  // ------------------------------------------------------------------
  // Drag with pointer events (mouse, touch and pen) + tap-to-place
  // ------------------------------------------------------------------
  let drag = null;
  let suppressClickUntil = 0;

  function beginPress(e, cardId, sourceEl, fromSlotId) {
    if (!S || !S.running) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { cardId, sourceEl, fromSlotId, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, over: null, overBank: false, raf: 0 };
  }

  el.cards.addEventListener('pointerdown', e => {
    const b = e.target.closest('.card');
    if (b) beginPress(e, b.dataset.card, b, null);
  });
  el.stage.addEventListener('pointerdown', e => {
    const b = e.target.closest('.slot');
    if (!b || !S || S.mode !== 'test') return;
    const id = b.dataset.id;
    if (!S.slotCard.has(id) || S.locked.has(id)) return;
    beginPress(e, S.slotCard.get(id), b, id);
  });

  function startDrag() {
    drag.active = true;
    hidePopover();
    const src = drag.sourceEl;
    const r = src.getBoundingClientRect();
    const g = document.createElement('div');
    g.className = 'card ghost';
    g.textContent = S.cardById.get(drag.cardId).label;
    document.body.appendChild(g);
    drag.ghost = g;
    // Keep the grab point under the finger, but never wider than the ghost itself
    const gw = g.offsetWidth, gh = g.offsetHeight;
    drag.offX = drag.fromSlotId ? gw / 2 : clamp(drag.x0 - r.left, 8, gw - 8);
    drag.offY = drag.fromSlotId ? gh / 2 : clamp(drag.y0 - r.top, 6, gh - 6);
    src.classList.add('origin');
    document.body.classList.add('dragging');
    S.selected = null;
    renderSlots(); renderStats();
    try { src.setPointerCapture(drag.pointerId); } catch (e) { /* not supported */ }
    autoScrollLoop();
  }

  function moveGhost() {
    drag.ghost.style.transform = `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) rotate(-1.5deg)`;
  }

  function slotUnder(x, y) {
    let best = null, bestD = 16;
    const vr = el.viewport.getBoundingClientRect();
    if (x < vr.left || x > vr.right || y < vr.top || y > vr.bottom) return null;
    for (const n of nodes) {
      if (S.locked.has(n.id)) continue;
      if (S.mode === 'practice' && S.slotCard.has(n.id)) continue;
      if (n.id === drag.fromSlotId) continue;
      const r = n.el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = n; if (d === 0) break; }
    }
    return best;
  }

  function updateHover() {
    const n = slotUnder(drag.x, drag.y);
    if (drag.over !== n) {
      if (drag.over) drag.over.el.classList.remove('over');
      drag.over = n;
      if (n) n.el.classList.add('over');
    }
    const br = el.bank.getBoundingClientRect();
    const overBank = !!drag.fromSlotId && drag.x >= br.left && drag.x <= br.right && drag.y >= br.top && drag.y <= br.bottom;
    if (overBank !== drag.overBank) { drag.overBank = overBank; el.bank.classList.toggle('drop-target', overBank); }
  }

  function autoScrollLoop() {
    if (!drag || !drag.active) return;
    const vp = el.viewport;
    const r = vp.getBoundingClientRect();
    const edge = 56, max = 18;
    let vx = 0, vy = 0;
    if (drag.x >= r.left && drag.x <= r.right && drag.y >= r.top - 30 && drag.y <= r.bottom + 30) {
      if (drag.y < r.top + edge) vy = -max * (1 - Math.max(0, drag.y - r.top) / edge);
      else if (drag.y > r.bottom - edge) vy = max * (1 - Math.max(0, r.bottom - drag.y) / edge);
      if (drag.x < r.left + edge) vx = -max * (1 - (drag.x - r.left) / edge);
      else if (drag.x > r.right - edge) vx = max * (1 - (r.right - drag.x) / edge);
    }
    if (vx || vy) { vp.scrollLeft += vx; vp.scrollTop += vy; updateHover(); }
    drag.raf = requestAnimationFrame(autoScrollLoop);
  }

  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 6) return;
      startDrag();
    }
    e.preventDefault();
    moveGhost();
    updateHover();
  }, { passive: false });

  function endDrag(cancelled) {
    const d = drag;
    drag = null;
    if (!d || !d.active) return;
    cancelAnimationFrame(d.raf);
    suppressClickUntil = Date.now() + 350;
    document.body.classList.remove('dragging');
    el.bank.classList.remove('drop-target');
    if (d.over) d.over.el.classList.remove('over');
    d.sourceEl.classList.remove('origin');

    let outcome = 'none';
    if (!cancelled && d.over) outcome = place(d.cardId, d.over.id, d.fromSlotId);
    else if (!cancelled && d.overBank && d.fromSlotId) { returnToBank(d.fromSlotId); outcome = 'returned'; }

    const g = d.ghost;
    if (outcome === 'correct' || outcome === 'placed' || outcome === 'returned') { g.remove(); return; }
    // Fly the ghost back to where it came from
    const target = (d.fromSlotId ? nodeById.get(d.fromSlotId).el : cardEls.get(d.cardId));
    const tr = target && !target.hidden ? target.getBoundingClientRect() : null;
    if (!tr || reduceMotion.matches) { g.remove(); return; }
    const from = g.style.transform;
    const anim = g.animate([{ transform: from, opacity: 1 }, { transform: `translate(${tr.left}px, ${tr.top}px)`, opacity: .4 }],
      { duration: 260, easing: 'cubic-bezier(.4,.1,.3,1)' });
    anim.onfinish = () => g.remove();
  }

  window.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
  window.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });

  // Tap a term, then tap a box
  el.cards.addEventListener('click', e => {
    const b = e.target.closest('.card');
    if (!b || Date.now() < suppressClickUntil || !S.running) return;
    S.selected = S.selected === b.dataset.card ? null : b.dataset.card;
    hidePopover();
    render();
    if (S.selected && window.matchMedia('(pointer: coarse)').matches) toast('Now tap the box where it goes.', 1800);
  });

  el.stage.addEventListener('click', e => {
    const b = e.target.closest('.slot');
    if (!b || Date.now() < suppressClickUntil) return;
    const id = b.dataset.id;
    const n = nodeById.get(id);
    if (S.selected && S.running && !S.locked.has(id)) {
      const r = place(S.selected, id, null);
      if (r === 'ignored' && S.mode === 'practice') toast('That box is already filled.');
      return;
    }
    if (S.locked.has(id) || S.revealed.has(id) || S.finished) { showPopover(n); return; }
    if (S.mode === 'test' && S.slotCard.has(id) && S.running) { returnToBank(id); return; }
    if (S.running && !S.slotCard.has(id)) toast('Pick a term from the word bank first, or drag one here.');
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!el.popover.hidden) { hidePopover(); return; }
    if (drag && drag.active) { endDrag(true); return; }
    if (S && S.selected) { S.selected = null; render(); }
  });

  // ------------------------------------------------------------------
  // Popover: what a branch supplies
  // ------------------------------------------------------------------
  let popFor = null;
  function showPopover(n) {
    if (popFor === n && !el.popover.hidden) { hidePopover(); return; }
    popFor = n;
    const title = labelAt(n.id) || S.revealed.get(n.id) || n.label;
    const known = x => S.finished || S.locked.has(x.id) || S.revealed.has(x.id);
    const chain = [];
    let ancestorsKnown = true;
    for (let p = n.parent; p; p = p.parent) { if (!known(p)) ancestorsKnown = false; chain.unshift(p.label); }
    const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    let html = '<button class="popover-close" type="button" aria-label="Close">×</button>';
    html += `<h3>${esc(title)}</h3>`;
    if (chain.length && ancestorsKnown) html += `<p class="path">${chain.map(esc).join(' › ')}</p>`;
    else if (chain.length) html += '<p class="path">Place the boxes above it to see its full path.</p>';
    // With "any order" on, a leaf box can hold a sibling's term: describe the term shown
    const info = title === n.label ? n : (nodes.find(x => x.label === title && x.parent === n.parent) || n);
    if (info.supplies) html += `<p><span class="label">Supplies</span>${esc(info.supplies)}</p>`;
    if (info.note) html += `<p class="note">${esc(info.note)}</p>`;
    if (!n.isLeaf) html += `<p class="path">${n.children.length === 1 ? '1 branch' : n.children.length + ' branches'} on the tree.</p>`;
    el.popover.innerHTML = html;
    el.popover.hidden = false;
    el.popover.setAttribute('aria-label', title);
    el.popover.querySelector('.popover-close').addEventListener('click', hidePopover);
    const r = n.el.getBoundingClientRect();
    const pw = el.popover.offsetWidth, ph = el.popover.offsetHeight;
    let left = r.right + 12, top = r.top + r.height / 2 - 28;
    if (left + pw > window.innerWidth - 12) left = r.left - pw - 12;
    if (left < 12) { left = clamp(r.left, 12, window.innerWidth - pw - 12); top = r.bottom + 10; }
    top = clamp(top, 12, window.innerHeight - ph - 12);
    el.popover.style.left = left + 'px';
    el.popover.style.top = top + 'px';
  }
  function hidePopover() { el.popover.hidden = true; popFor = null; }
  document.addEventListener('pointerdown', e => {
    if (!el.popover.hidden && !e.target.closest('.popover') && !e.target.closest('.slot')) hidePopover();
  });

  // ------------------------------------------------------------------
  // Hints
  // ------------------------------------------------------------------
  el.btnHint.addEventListener('click', () => {
    if (!S.running) return;
    const bankCards = S.cards.filter(c => c.slot == null);
    if (!bankCards.length) { toast(S.mode === 'test' ? 'Every term is placed. Check your answers.' : 'Nothing left to place.'); return; }
    const empties = bfs.filter(n => !S.slotCard.has(n.id));
    const ready = empties.filter(n => !n.parent || S.slotCard.has(n.parent.id));
    let pick = null;
    for (const n of ready.concat(empties)) {
      const card = bankCards.find(c => c.label === n.label) || (S.mode === 'practice' ? bankCards.find(c => acceptable(c.label, n)) : null);
      if (card) { pick = { n, card }; break; }
    }
    if (!pick) { toast('Some terms are in the wrong boxes. Check your answers to find them.'); return; }
    S.hints++;
    S.selected = pick.card.id;
    if (S.filter && !pick.card.label.toLowerCase().includes(S.filter.trim().toLowerCase())) { S.filter = ''; el.filter.value = ''; }
    render();
    scrollNodeIntoView(pick.n);
    flash(pick.n.el, 'hinted');
    const cb = cardEls.get(pick.card.id);
    cb.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    flash(cb, 'hinted');
    toast(`“${pick.card.label}” goes in the pulsing box. It’s selected, so just tap the box.`, 3200);
  });

  // ------------------------------------------------------------------
  // Check answers (test mode)
  // ------------------------------------------------------------------
  el.btnCheck.addEventListener('click', () => {
    if (!S.running) return;
    const res = grade();
    let correct = 0, wrongNow = 0;
    res.forEach((ok, id) => {
      if (ok) { S.locked.add(id); S.wrong.delete(id); correct++; }
      else { S.wrong.add(id); wrongNow++; }
    });
    S.checks++;
    S.mistakes += wrongNow;
    const unplaced = TOTAL - S.slotCard.size;
    if (S.firstScore == null) S.firstScore = correct;
    render();
    if (S.locked.size === TOTAL) { finish(); return; }
    if (correct) sound.correct(); else sound.wrong();

    const pct = Math.round(S.locked.size / TOTAL * 100);
    const parts = [];
    if (wrongNow) parts.push(`${wrongNow} ${wrongNow === 1 ? 'term is' : 'terms are'} in the wrong place (marked in amber).`);
    if (unplaced) parts.push(`${unplaced} ${unplaced === 1 ? 'term is' : 'terms are'} still in the word bank.`);
    showResult({
      title: `${S.locked.size} of ${TOTAL} correct`,
      text: `That’s ${pct}%. Correct branches now fill with blood. ${parts.join(' ')}`,
      stats: [['Correct', S.locked.size], ['Wrong', wrongNow], ['Not placed', unplaced], ['Time', fmtTime(elapsed())]],
      best: '',
      actions: [
        { label: 'Show answers', cls: 'btn', fn: () => askReveal() },
        { label: wrongNow ? 'Try the wrong ones again' : 'Keep going', cls: 'btn btn-primary', fn: () => {
          S.wrong.forEach(id => { const cid = S.slotCard.get(id); S.slotCard.delete(id); if (cid) S.cardById.get(cid).slot = null; });
          S.wrong.clear();
          render();
        } }
      ]
    });
  });

  // ------------------------------------------------------------------
  // Reveal, finish, results
  // ------------------------------------------------------------------
  function askReveal() {
    confirmBox({
      title: 'Show the answers?',
      text: 'This ends the round without a score. Every box you haven’t got right yet will be filled in for you.',
      yes: 'Show answers', no: 'Keep playing',
      onYes: reveal
    });
  }
  el.btnReveal.addEventListener('click', () => { if (S.running) askReveal(); });

  function reveal() {
    // Return anything unconfirmed to the bank, then fill the gaps with the right labels
    S.slotCard.forEach((cid, id) => { if (!S.locked.has(id)) { S.slotCard.delete(id); S.cardById.get(cid).slot = null; } });
    S.wrong.clear();
    const groups = new Map();
    nodes.forEach(n => {
      if (S.locked.has(n.id)) return;
      if (n.isLeaf && n.parent && !S.strict) {
        if (!groups.has(n.parent)) groups.set(n.parent, []);
        groups.get(n.parent).push(n);
      } else S.revealed.set(n.id, n.label);
    });
    groups.forEach((empties, p) => {
      const leaves = p.children.filter(c => c.isLeaf);
      const remaining = countMap(leaves.map(l => l.label));
      leaves.forEach(l => { if (S.locked.has(l.id)) { const v = labelAt(l.id); remaining.set(v, remaining.get(v) - 1); } });
      const later = [];
      empties.forEach(n => { if (remaining.get(n.label) > 0) { S.revealed.set(n.id, n.label); remaining.set(n.label, remaining.get(n.label) - 1); } else later.push(n); });
      later.forEach(n => {
        const lbl = [...remaining.keys()].find(k => remaining.get(k) > 0) || n.label;
        S.revealed.set(n.id, lbl);
        remaining.set(lbl, (remaining.get(lbl) || 1) - 1);
      });
    });
    stopClock();
    S.finished = true;
    S.selected = null;
    render();
    toast('Answers shown. Select any box to see what it supplies.', 3200);
  }

  function stopClock() {
    if (S.running) { S.elapsed = Date.now() - S.startedAt; S.running = false; }
  }

  function finish() {
    stopClock();
    S.finished = true;
    S.selected = null;
    render();
    const time = Math.round(S.elapsed);
    const score = scoreOf(time, S.mistakes, S.hints);
    const run = { nickname: S.nick, mode: S.mode, slide_order: S.strict, time_ms: time, mistakes: S.mistakes, hints: S.hints };

    // Every finished run is kept on this device too (and powers the offline leaderboard)
    const key = nickKey(S.nick);
    const local = store.get('runs', []);
    const prevBest = local
      .filter(r => nickKey(r.nickname) === key && r.mode === run.mode && !!r.slide_order === run.slide_order)
      .reduce((m, r) => Math.min(m, r.score_ms), Infinity);
    local.push(Object.assign({}, run, { score_ms: score, at: new Date().toISOString() }));
    store.set('runs', local.slice(-300));

    const extras = [];
    if (S.mistakes) extras.push(`${S.mistakes * MISTAKE_PENALTY_MS / 1000} seconds for ${plural(S.mistakes, 'mistake')}`);
    if (S.hints) extras.push(`${S.hints * HINT_PENALTY_MS / 1000} seconds for ${plural(S.hints, 'hint')}`);
    const breakdown = extras.length
      ? `Your score is ${fmtTime(score)}: ${fmtTime(time)} on the clock, plus ${extras.join(' and ')}.`
      : `Your score is ${fmtTime(score)}, with no mistakes and no hints.`;
    const lead = S.mode === 'practice'
      ? `All ${TOTAL} branches are in place.`
      : (S.firstScore === TOTAL ? `Every branch was right on the first check.` : `All ${TOTAL} branches are right; ${S.firstScore} were right on the first check.`);

    const show = () => {
      showResult({
        title: 'The whole tree is perfused.',
        text: `${lead} ${breakdown}`,
        stats: [['Score', fmtTime(score)], ['Time', fmtTime(time)], ['Mistakes', S.mistakes], ['Hints', S.hints]],
        best: lb.on ? 'Saving your score to the leaderboard…' : localBestLine(prevBest, score),
        actions: [
          { label: 'Explore the tree', cls: 'btn', fn: () => toast('Select any box to see what it supplies.', 3000) },
          { label: 'Leaderboard', cls: 'btn', fn: () => openBoard(run.mode, run.slide_order) },
          { label: 'Play again', cls: 'btn btn-primary', fn: () => openIntro() }
        ]
      });
      if (lb.on) submitRun(run, score, prevBest);
    };
    if (reduceMotion.matches) { sound.finish(); show(); return; }
    heartbeat(show);
  }

  function localBestLine(prevBest, score) {
    if (!isFinite(prevBest)) return 'Your first finished tree on this board. That’s the score to beat.';
    if (score < prevBest) return `Your best score yet on this board. Previous best: ${fmtTime(prevBest)}.`;
    return `Your best on this board is ${fmtTime(prevBest)}.`;
  }

  async function submitRun(run, score, prevLocalBest) {
    const line = el.resultBest;
    if (run.time_ms < MIN_TIME_MS) { line.textContent = localBestLine(prevLocalBest, score); return; }
    try {
      const board = await lb.board(run.mode, run.slide_order) || [];
      await lb.submit(run);
      const key = nickKey(run.nickname);
      const mine = board.find(r => r.nickname_key === key);
      const others = board.filter(r => r.nickname_key !== key);
      const best = mine ? Math.min(mine.score_ms, score) : score;
      const rank = 1 + others.filter(r => r.score_ms < best).length;
      const where = `#${rank} of ${others.length + 1} on the ${boardLabel(run.mode, run.slide_order)} leaderboard`;
      if (!mine) line.textContent = `Saved. You’re on the board at ${where}.`;
      else if (score < mine.score_ms) line.textContent = `New personal best. You’re ${where}.`;
      else line.textContent = `Saved. Your best is still ${fmtTime(mine.score_ms)}, ${where}.`;
    } catch (e) {
      if (retryable(e)) {
        queueRun(run);
        line.textContent = 'Couldn’t reach the leaderboard. Your score is saved on this device and will be sent the next time you open the game.';
      } else {
        line.textContent = `The leaderboard didn’t accept this score (${e.message}).`;
      }
    }
  }

  // The pulse wave runs from the heart out to every branch, twice (lub-dub)
  function heartbeat(done) {
    sound.finish();
    const v = 1.6; // px per ms
    const seg = 46;
    const startOf = new Map();
    const stubLen = stubPath.len;
    (function walk(n, t) {
      startOf.set(n, t); // time the wave reaches the node's left edge
      n.children.forEach(c => walk(c, t + n.w + c.vessel.len));
    })(root, stubLen);
    const beats = [0, 850];
    beats.forEach(b0 => {
      stubPath.style.strokeDasharray = `${seg} ${stubLen + seg + 400}`;
      stubPath.animate([{ strokeDashoffset: seg }, { strokeDashoffset: -stubLen }], { duration: (stubLen + seg) / v, delay: b0, easing: 'linear' });
      nodes.forEach(n => {
        if (n.vessel) {
          const { pulse, len } = n.vessel;
          pulse.style.strokeDasharray = `${seg} ${len + seg + 400}`;
          const t0 = startOf.get(n) - len;
          pulse.animate([{ strokeDashoffset: seg }, { strokeDashoffset: -len }], { duration: (len + seg) / v, delay: b0 + t0 / v, easing: 'linear', fill: 'none' });
        }
        setTimeout(() => flash(n.el, 'beat'), b0 + startOf.get(n) / v);
      });
    });
    const maxT = Math.max(...[...startOf.values()]) / v;
    setTimeout(() => {
      // Hide the pulse strokes again
      nodes.forEach(n => { if (n.vessel) n.vessel.pulse.style.strokeDasharray = `0 ${n.vessel.len + 100}`; });
      stubPath.style.strokeDasharray = `0 ${stubLen + 100}`;
      done();
    }, 850 + maxT + 450);
  }

  function showResult({ title, text, stats, best, actions }) {
    el.resultTitle.textContent = title;
    el.resultText.textContent = text;
    el.resultStats.innerHTML = '';
    stats.forEach(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      d.append(dt, dd);
      el.resultStats.appendChild(d);
    });
    el.resultBest.textContent = best || '';
    el.resultActions.innerHTML = '';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = a.cls; b.textContent = a.label;
      b.addEventListener('click', () => { el.result.close(); a.fn(); });
      el.resultActions.appendChild(b);
    });
    el.result.showModal();
    const primary = el.resultActions.querySelector('.btn-primary');
    if (primary) primary.focus();
  }

  let confirmHandler = null;
  function confirmBox({ title, text, yes, no, onYes }) {
    el.confirmTitle.textContent = title;
    el.confirmText.textContent = text;
    el.confirmYes.textContent = yes;
    el.confirmNo.textContent = no;
    confirmHandler = onYes;
    el.confirm.showModal();
    el.confirmNo.focus();
  }
  el.confirmYes.addEventListener('click', () => { el.confirm.close(); const f = confirmHandler; confirmHandler = null; if (f) f(); });
  el.confirmNo.addEventListener('click', () => { el.confirm.close(); confirmHandler = null; });

  // ------------------------------------------------------------------
  // New game / intro
  // ------------------------------------------------------------------
  const NICK_HINT = 'Use the same nickname every time to keep all your scores together.';
  function openIntro() {
    const prefs = store.get('prefs', { mode: 'practice', strict: false });
    el.introForm.elements.mode.value = prefs.mode;
    el.strictInput.checked = !!prefs.strict;
    el.nickInput.value = cleanNick(store.get('nickname', ''));
    el.nickHint.textContent = NICK_HINT;
    el.nickHint.classList.remove('error');
    el.intro.showModal();
    (el.nickInput.value ? document.getElementById('btnStart') : el.nickInput).focus();
  }
  el.nickInput.addEventListener('input', () => { el.nickHint.textContent = NICK_HINT; el.nickHint.classList.remove('error'); });
  el.intro.addEventListener('cancel', e => { if (!S || !S.running) e.preventDefault(); });
  el.introForm.addEventListener('submit', e => {
    e.preventDefault();
    const nick = cleanNick(el.nickInput.value);
    if (!nick) {
      el.nickHint.textContent = 'Enter a nickname to start. It’s how your scores show up on the leaderboard.';
      el.nickHint.classList.add('error');
      el.nickInput.focus();
      return;
    }
    const mode = el.introForm.elements.mode.value === 'test' ? 'test' : 'practice';
    const strict = el.strictInput.checked;
    store.set('prefs', { mode, strict });
    store.set('nickname', nick);
    el.intro.close();
    startGame(mode, strict);
  });

  el.btnNew.addEventListener('click', () => {
    const inProgress = S && S.running && (S.slotCard.size > 0 || elapsed() > 15000);
    if (inProgress) confirmBox({ title: 'Start a new game?', text: 'You’ll lose your progress on this tree.', yes: 'New game', no: 'Keep playing', onYes: openIntro });
    else openIntro();
  });

  function startGame(mode, strict) {
    const sortPref = S ? S.sort : store.get('sort', 'shuffle');
    S = newState(mode, strict);
    S.sort = sortPref;
    el.filter.value = '';
    hidePopover();
    buildCards();
    S.running = true;
    S.startedAt = Date.now();
    render();
    sound.ensure(); // unlock audio on this user gesture
  }

  // Bank tools
  el.filter.addEventListener('input', () => { S.filter = el.filter.value; renderBank(); });
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    S.sort = b.dataset.sort; store.set('sort', S.sort);
    if (S.sort === 'shuffle') S.cards.forEach(c => { c.rand = Math.random(); });
    renderBank();
  }));

  // Sound toggle
  function renderSound() {
    el.btnSound.setAttribute('aria-pressed', sound.on ? 'true' : 'false');
    el.btnSound.setAttribute('aria-label', sound.on ? 'Sound on' : 'Sound off');
    el.btnSound.title = sound.on ? 'Sound on' : 'Sound off';
  }
  el.btnSound.addEventListener('click', () => { sound.on = !sound.on; store.set('sound', sound.on); renderSound(); if (sound.on) sound.correct(); });

  // ------------------------------------------------------------------
  // Leaderboard dialog
  // ------------------------------------------------------------------
  const boardView = { mode: 'practice', slide: false, token: 0 };

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }) +
      ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function localBoard(mode, slide) {
    const best = new Map();
    store.get('runs', []).filter(r => r.mode === mode && !!r.slide_order === slide).forEach(r => {
      const k = nickKey(r.nickname);
      const cur = best.get(k);
      if (!cur) best.set(k, Object.assign({}, r, { nickname_key: k, runs: 1, created_at: r.at }));
      else {
        cur.runs++;
        if (r.score_ms < cur.score_ms) Object.assign(cur, r, { nickname_key: k, runs: cur.runs, created_at: r.at });
      }
    });
    return [...best.values()].sort((a, b) => a.score_ms - b.score_ms || String(a.created_at).localeCompare(String(b.created_at)));
  }

  function openBoard(mode, slide) {
    boardView.mode = mode || (S ? S.mode : 'practice');
    boardView.slide = slide != null ? !!slide : !!(S && S.strict);
    if (!el.boardDialog.open) el.boardDialog.showModal();
    loadBoard();
  }

  async function loadBoard() {
    const token = ++boardView.token;
    el.boardDialog.querySelectorAll('[data-bmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bmode === boardView.mode)));
    el.boardDialog.querySelectorAll('[data-bslide]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.bslide === '1') === boardView.slide)));
    el.boardBody.innerHTML = '<p class="board-msg">Loading scores…</p>';
    let rows = null, note = '';
    if (lb.on) {
      try { rows = await lb.board(boardView.mode, boardView.slide) || []; }
      catch (e) { note = 'Couldn’t reach the leaderboard right now, so this shows scores from this device only.'; }
    } else {
      note = 'The global leaderboard isn’t connected yet, so this shows scores from this device only.';
    }
    if (token !== boardView.token) return; // a newer tab was chosen meanwhile
    const global = !!rows;
    if (!rows) rows = localBoard(boardView.mode, boardView.slide);
    el.boardNote.textContent = note;
    el.boardNote.hidden = !note;
    renderBoard(rows, global);
  }

  function cell(tag, text, cls) {
    const c = document.createElement(tag);
    if (text != null) c.textContent = text;
    if (cls) c.className = cls;
    return c;
  }

  function renderBoard(rows, global) {
    el.boardBody.innerHTML = '';
    if (!rows.length) {
      el.boardBody.appendChild(cell('p', `No scores on the ${boardLabel(boardView.mode, boardView.slide)} board yet. Finish a game to be the first.`, 'board-msg'));
      return;
    }
    const me = nickKey(store.get('nickname', ''));
    const table = cell('table', null, 'lb');
    const head = table.createTHead().insertRow();
    [['#', 'num'], ['Player', ''], ['Score', 'num'], ['Time', 'num opt'], ['Mistakes', 'num opt'], ['Hints', 'num opt'], ['Runs', 'num']]
      .forEach(([t, c]) => head.appendChild(cell('th', t, c)));
    const tbody = table.createTBody();
    let rank = 0, prev = null;
    rows.forEach((r, i) => {
      if (r.score_ms !== prev) { rank = i + 1; prev = r.score_ms; }
      const tr = tbody.insertRow();
      if (r.nickname_key === me) tr.className = 'me';
      tr.appendChild(cell('td', rank, 'num rank'));
      const who = cell('td', null, 'who');
      const btn = cell('button', r.nickname, 'player');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => togglePlayer(tr, r, global, btn));
      who.appendChild(btn);
      tr.appendChild(who);
      tr.appendChild(cell('td', fmtTime(r.score_ms), 'num score'));
      tr.appendChild(cell('td', fmtTime(r.time_ms), 'num opt'));
      tr.appendChild(cell('td', r.mistakes, 'num opt'));
      tr.appendChild(cell('td', r.hints, 'num opt'));
      tr.appendChild(cell('td', r.runs, 'num'));
    });
    el.boardBody.appendChild(table);
    const mine = el.boardBody.querySelector('tr.me');
    if (mine) mine.scrollIntoView({ block: 'nearest' });
  }

  async function togglePlayer(tr, r, global, btn) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('runs-row')) {
      next.remove();
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    const row = document.createElement('tr');
    row.className = 'runs-row';
    const td = cell('td', 'Loading runs…');
    td.colSpan = 7;
    row.appendChild(td);
    tr.after(row);
    let runs;
    try {
      runs = global ? (await lb.runs(r.nickname_key) || [])
        : store.get('runs', []).filter(x => nickKey(x.nickname) === r.nickname_key).map(x => Object.assign({}, x, { created_at: x.at })).reverse();
    } catch (e) {
      td.textContent = 'Couldn’t load this player’s runs. Try again in a moment.';
      return;
    }
    td.textContent = '';
    td.appendChild(cell('p', `${plural(runs.length, 'run')} by ${r.nickname}${global ? '' : ' on this device'}`, 'runs-title'));
    const t = cell('table', null, 'runs');
    const h = t.createTHead().insertRow();
    [['When', ''], ['Board', ''], ['Score', 'num'], ['Time', 'num'], ['Mistakes', 'num opt'], ['Hints', 'num opt']].forEach(([x, c]) => h.appendChild(cell('th', x, c)));
    const b = t.createTBody();
    runs.forEach(x => {
      const rr = b.insertRow();
      rr.appendChild(cell('td', fmtWhen(x.created_at)));
      rr.appendChild(cell('td', boardLabel(x.mode, x.slide_order)));
      rr.appendChild(cell('td', fmtTime(x.score_ms), 'num score'));
      rr.appendChild(cell('td', fmtTime(x.time_ms), 'num'));
      rr.appendChild(cell('td', x.mistakes, 'num opt'));
      rr.appendChild(cell('td', x.hints, 'num opt'));
    });
    td.appendChild(t);
  }

  el.btnBoard.addEventListener('click', () => openBoard());
  el.boardClose.addEventListener('click', () => el.boardDialog.close());
  el.boardDialog.addEventListener('click', e => { if (e.target === el.boardDialog) el.boardDialog.close(); });
  el.boardDialog.querySelectorAll('[data-bmode]').forEach(b => b.addEventListener('click', () => { boardView.mode = b.dataset.bmode; loadBoard(); }));
  el.boardDialog.querySelectorAll('[data-bslide]').forEach(b => b.addEventListener('click', () => { boardView.slide = b.dataset.bslide === '1'; loadBoard(); }));

  // ------------------------------------------------------------------
  // About
  // ------------------------------------------------------------------
  const aboutDialog = document.getElementById('aboutDialog');
  document.getElementById('btnAbout').addEventListener('click', () => { if (!aboutDialog.open) aboutDialog.showModal(); });
  ['aboutClose', 'aboutDone'].forEach(id => document.getElementById(id).addEventListener('click', () => aboutDialog.close()));
  aboutDialog.addEventListener('click', e => { if (e.target === aboutDialog) aboutDialog.close(); });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    layout();
    buildTree();
    S = newState('practice', false);
    S.running = false;
    buildCards();
    render();
    renderSound();
    fitWidth();
    drawIn();
    openIntro();
    flushPending();
  }

  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.race([fontsReady, new Promise(r => setTimeout(r, 1500))]).then(boot);
})();
