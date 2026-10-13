'use strict';

/* ==================================================================
   NFA TRAVERSAL ENGINE
   Part 1 — core logic (pure functions, no DOM; also runs in Node)
   Part 2 — user interface
   ================================================================== */

/* ------------------------------------------------------------------
   PART 1 · CORE
   ------------------------------------------------------------------ */

const EPS = 'ε';
const EPS_WORDS = ['eps', 'epsilon', 'ε', 'λ', 'lambda'];

const PRESETS = [
  {
    id: 'ends01',
    name: 'Ends with 01',
    desc: 'Classic guess-and-check: q0 loops, then "guesses" that the last two symbols are 0,1.',
    def: {
      states: 'q0, q1, q2',
      alphabet: '0, 1',
      start: 'q0',
      accept: 'q2',
      transitions: 'q0, 0 -> q0, q1\nq0, 1 -> q0\nq1, 1 -> q2'
    },
    examples: [
      { s: '1101', ok: true }, { s: '01', ok: true }, { s: '0110', ok: false }, { s: '10', ok: false }
    ]
  },
  {
    id: 'contains-aba',
    name: 'Contains "aba"',
    desc: 'Nondeterministically guess where the substring starts; q3 is a trap that accepts everything after.',
    def: {
      states: 'q0, q1, q2, q3',
      alphabet: 'a, b',
      start: 'q0',
      accept: 'q3',
      transitions: 'q0, a -> q0, q1\nq0, b -> q0\nq1, b -> q2\nq2, a -> q3\nq3, a -> q3\nq3, b -> q3'
    },
    examples: [
      { s: 'babab', ok: true }, { s: 'aba', ok: true }, { s: 'abba', ok: false }, { s: 'bbbb', ok: false }
    ]
  },
  {
    id: 'astar-bstar-cstar',
    name: 'a*b*c*  (ε-moves)',
    desc: 'Uses ε-transitions to skip ahead: any run of a\'s, then b\'s, then c\'s (each part may be empty).',
    def: {
      states: 'q0, q1, q2',
      alphabet: 'a, b, c',
      start: 'q0',
      accept: 'q2',
      transitions: 'q0, a -> q0\nq0, eps -> q1\nq1, b -> q1\nq1, eps -> q2\nq2, c -> q2'
    },
    examples: [
      { s: 'aabbcc', ok: true }, { s: 'ac', ok: true }, { s: 'ba', ok: false }, { s: 'abcabc', ok: false }
    ]
  },
  {
    id: 'union',
    name: 'Even #0s  OR  ends in 11  (union)',
    desc: 'An ε-split at the start runs two machines side by side: the thread dies in one but may live in the other.',
    def: {
      states: 's, e0, e1, t0, t1, t2',
      alphabet: '0, 1',
      start: 's',
      accept: 'e0, t2',
      transitions: [
        's, eps -> e0, t0',
        '// machine A: even number of 0s',
        'e0, 0 -> e1', 'e0, 1 -> e0', 'e1, 0 -> e0', 'e1, 1 -> e1',
        '// machine B: ends in 11',
        't0, 0 -> t0', 't0, 1 -> t0, t1', 't1, 1 -> t2'
      ].join('\n')
    },
    examples: [
      { s: '1010', ok: true }, { s: '0111', ok: true }, { s: '01', ok: false }, { s: '0', ok: false }
    ]
  },
  {
    id: 'third-from-end',
    name: 'Third symbol from the end is 1',
    desc: 'Small NFA (4 states) for a language whose smallest DFA needs 8 — and a good stress test for backtracking.',
    def: {
      states: 'q0, q1, q2, q3',
      alphabet: '0, 1',
      start: 'q0',
      accept: 'q3',
      transitions: 'q0, 0 -> q0\nq0, 1 -> q0, q1\nq1, 0 -> q2\nq1, 1 -> q2\nq2, 0 -> q3\nq2, 1 -> q3'
    },
    examples: [
      { s: '100', ok: true }, { s: '0110', ok: true }, { s: '011', ok: false }, { s: '1001', ok: false }
    ]
  }
];

function splitList(s) {
  return String(s || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
}
function dedupe(a) { return Array.from(new Set(a)); }

/**
 * Parse and validate a machine definition.
 * def = { states, alphabet, start, accept, transitions }  (all strings)
 * returns { ok, errors[], nfa }
 */
function parseNFA(def) {
  const errors = [];

  const states = dedupe(splitList(def.states));
  if (!states.length) errors.push('Add at least one state.');

  const alphabet = dedupe(splitList(def.alphabet));
  if (!alphabet.length) errors.push('Add at least one alphabet symbol.');
  alphabet.forEach(a => {
    if (Array.from(a).length !== 1) errors.push(`Alphabet symbol "${a}" must be a single character.`);
    if (EPS_WORDS.includes(a.toLowerCase())) errors.push(`"${a}" is reserved for ε-moves; choose another symbol.`);
  });

  const start = String(def.start || '').trim();
  if (!start) errors.push('Choose a start state.');
  else if (!states.includes(start)) errors.push(`Start state "${start}" is not in the state set.`);

  const accept = dedupe(splitList(def.accept));
  accept.forEach(a => { if (!states.includes(a)) errors.push(`Accepting state "${a}" is not in the state set.`); });

  const delta = new Map();
  const transitions = [];
  String(def.transitions || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    const ln = `Line ${i + 1}`;
    const parts = line.split(/->|→/);
    if (parts.length !== 2) { errors.push(`${ln}: use  state, symbol -> target1, target2`); return; }
    const lhs = parts[0].split(',').map(x => x.trim());
    if (lhs.length !== 2 || !lhs[0] || !lhs[1]) { errors.push(`${ln}: left side must be  state, symbol`); return; }
    const from = lhs[0];
    let sym = lhs[1];
    if (EPS_WORDS.includes(sym.toLowerCase())) sym = EPS;
    const targets = dedupe(splitList(parts[1]));
    if (!targets.length) { errors.push(`${ln}: no target state given.`); return; }
    if (!states.includes(from)) { errors.push(`${ln}: unknown state "${from}".`); return; }
    if (sym !== EPS && !alphabet.includes(sym)) { errors.push(`${ln}: symbol "${sym}" is not in Σ (use eps for ε).`); return; }
    for (const t of targets) {
      if (!states.includes(t)) { errors.push(`${ln}: unknown target state "${t}".`); return; }
    }
    const key = from + '\u0000' + sym;
    const cur = delta.get(key) || [];
    targets.forEach(t => {
      if (!cur.includes(t)) { cur.push(t); transitions.push({ from, sym, to: t }); }
    });
    delta.set(key, cur);
  });

  if (errors.length) return { ok: false, errors, nfa: null };

  const nfa = {
    states, alphabet, start,
    accept: new Set(accept),
    delta, transitions,
    next(state, sym) { return delta.get(state + '\u0000' + sym) || []; }
  };
  return { ok: true, errors: [], nfa };
}

/** ε-closure of a set of states. Also returns the ε-edges walked (for highlighting). */
function closure(nfa, seeds) {
  const seen = new Set(seeds);
  const stack = Array.from(seeds);
  const edges = [];
  while (stack.length) {
    const s = stack.pop();
    for (const t of nfa.next(s, EPS)) {
      edges.push([s, t, EPS]);
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return { states: nfa.states.filter(s => seen.has(s)), edges };
}

/**
 * PARALLEL-PATH simulation.
 * Tracks the set of every active state after each input symbol.
 */
function simulateParallel(nfa, input) {
  const chars = Array.from(input);
  const c0 = closure(nfa, [nfa.start]);
  let current = c0.states;
  const steps = [{
    kind: 'start', pos: 0, symbol: null,
    from: [], moved: [nfa.start], active: current, edges: c0.edges
  }];
  let dead = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const moved = new Set();
    const edges = [];
    for (const s of current) {
      for (const t of nfa.next(s, ch)) { moved.add(t); edges.push([s, t, ch]); }
    }
    const movedArr = nfa.states.filter(s => moved.has(s));
    const cl = closure(nfa, movedArr);
    steps.push({
      kind: 'read', pos: i + 1, symbol: ch,
      from: current, moved: movedArr, active: cl.states, edges: edges.concat(cl.edges)
    });
    current = cl.states;
    if (!current.length) { dead = true; break; }
  }

  const accepted = !dead && current.some(s => nfa.accept.has(s));
  return { steps, accepted, dead, chars };
}

/**
 * BACKTRACKING simulation (depth-first search over configurations (state, position)).
 *  - ε-cycle guard: a configuration already on the current path is skipped.
 *  - memo: a configuration already proven to fail is skipped.
 *  - stops at the first accepting path.
 *  - `cap` limits logged events so the UI stays responsive.
 */
function simulateBacktrack(nfa, input, cap) {
  cap = cap || 2500;
  const chars = Array.from(input);
  const events = [];
  const onPath = new Set();
  const trail = [];
  const failed = new Set();
  let accepted = false;
  let acceptPath = null;
  let truncated = false;

  const push = ev => { ev.path = trail.map(t => [t.state, t.via]); events.push(ev); };

  function dfs(state, pos, via, depth) {
    if (events.length >= cap) { truncated = true; return false; }
    const key = state + '\u0000' + pos;
    if (onPath.has(key)) { push({ type: 'cycle', state, pos, via, depth }); return false; }
    if (failed.has(key)) { push({ type: 'pruned', state, pos, via, depth }); return false; }

    trail.push({ state, pos, via });
    onPath.add(key);
    push({ type: 'visit', state, pos, via, depth });

    let found = false;
    if (pos === chars.length && nfa.accept.has(state)) {
      found = true;
      accepted = true;
      acceptPath = trail.map(t => ({ state: t.state, pos: t.pos, via: t.via }));
      push({ type: 'accept', state, pos, via, depth });
    } else {
      for (const t of nfa.next(state, EPS)) {
        if (dfs(t, pos, EPS, depth + 1)) { found = true; break; }
        if (truncated) break;
      }
      if (!found && !truncated && pos < chars.length) {
        for (const t of nfa.next(state, chars[pos])) {
          if (dfs(t, pos + 1, chars[pos], depth + 1)) { found = true; break; }
          if (truncated) break;
        }
      }
      if (!found && !truncated) {
        failed.add(key);
        push({ type: 'dead', state, pos, via, depth });
      }
    }

    trail.pop();
    onPath.delete(key);
    return found;
  }

  dfs(nfa.start, 0, null, 0);
  return { events, accepted, acceptPath, truncated, chars };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EPS, PRESETS, parseNFA, closure, simulateParallel, simulateBacktrack };
}

/* ------------------------------------------------------------------
   PART 2 · USER INTERFACE
   ------------------------------------------------------------------ */

if (typeof document !== 'undefined') {
  (function () {
    const $ = id => document.getElementById(id);
    const STORE_KEY = 'nfa-engine:machine:v1';

    const S = {
      nfa: null,
      presetId: PRESETS[0].id,
      mode: 'parallel',
      input: '',
      par: null,
      bt: null,
      idx: 0,
      playing: false,
      timer: null,
      graph: null,
      unknownSyms: []
    };

    const MODE_TEXT = {
      parallel: 'Tracks the whole set of active states at once. For each symbol: take every move from every active state, then add everything reachable by ε. Accept if any active state is accepting at the end.',
      backtrack: 'Explores one path at a time (depth-first). On a dead end it backtracks to the last choice point and tries the next option. Stops at the first accepting path; failed (state, position) pairs are remembered.'
    };

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = a => a.length ? '{' + a.join(', ') + '}' : '∅';
    const q = s => `'${s}'`;

    /* ---------- machine form ---------- */
    function fillFields(def) {
      $('fStates').value = def.states;
      $('fAlpha').value = def.alphabet;
      $('fStart').value = def.start;
      $('fAccept').value = def.accept;
      $('fTrans').value = def.transitions;
    }
    function readFields() {
      return {
        states: $('fStates').value,
        alphabet: $('fAlpha').value,
        start: $('fStart').value,
        accept: $('fAccept').value,
        transitions: $('fTrans').value
      };
    }

    function populatePresets() {
      const sel = $('preset');
      sel.innerHTML = PRESETS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') +
        '<option value="custom">✎ Custom (your edits)</option>';
    }

    function showErrors(errors) {
      const box = $('machineErrors');
      if (!errors.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = '<ul>' + errors.map(e => `<li>${esc(e)}</li>`).join('') + '</ul>';
    }

    function applyMachine(persist) {
      const def = readFields();
      const res = parseNFA(def);
      showErrors(res.errors);
      if (!res.ok) return false;
      stopPlay();
      S.nfa = res.nfa;
      S.par = S.bt = null;
      S.idx = 0;
      buildGraph();
      showFormal();
      buildExamples();
      buildTrace();
      $('banner').hidden = true;
      render();
      if (persist) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ presetId: S.presetId, def })); } catch (e) { /* storage unavailable */ }
      }
      return true;
    }

    function choosePreset(id) {
      const p = PRESETS.find(x => x.id === id);
      if (!p) return;
      S.presetId = id;
      $('preset').value = id;
      $('presetDesc').textContent = p.desc;
      fillFields(p.def);
      applyMachine(true);
    }

    function showFormal() {
      const n = S.nfa;
      const hasEps = n.transitions.some(t => t.sym === EPS);
      $('formal').innerHTML =
        `<b>N</b> = (Q, Σ, δ, q₀, F)<br>` +
        `<b>Q</b> = ${esc(fmt(n.states))}<br>` +
        `<b>Σ</b> = ${esc(fmt(n.alphabet))}<br>` +
        `<b>q₀</b> = ${esc(n.start)} &nbsp; <b>F</b> = ${esc(fmt(n.states.filter(s => n.accept.has(s))))}<br>` +
        `<b>|δ|</b> = ${n.transitions.length} transition${n.transitions.length === 1 ? '' : 's'}` +
        (hasEps ? ' (includes ε-moves)' : '');
    }

    function buildExamples() {
      const box = $('examples');
      const p = S.presetId === 'custom' ? null : PRESETS.find(x => x.id === S.presetId);
      if (!p) { box.innerHTML = ''; return; }
      box.innerHTML = p.examples.map(e =>
        `<button class="chip" type="button" data-s="${esc(e.s)}">${esc(e.s)}<small class="${e.ok ? 'y' : 'n'}">${e.ok ? '✓' : '✗'}</small></button>`
      ).join('') + '<button class="chip" type="button" data-s="">ε<small class="muted">empty</small></button>';
    }

    /* ---------- graph ---------- */
    const NS = 'http://www.w3.org/2000/svg';
    const R = 20;

    function buildGraph() {
      const nfa = S.nfa;
      const idx = new Map(nfa.states.map((s, i) => [s, i]));

      // BFS layering from the start state (left to right, like a textbook diagram)
      const adj = new Map(nfa.states.map(s => [s, []]));
      nfa.transitions.forEach(t => adj.get(t.from).push(t.to));
      const layer = new Map([[nfa.start, 0]]);
      const queue = [nfa.start];
      while (queue.length) {
        const u = queue.shift();
        for (const v of adj.get(u)) if (!layer.has(v)) { layer.set(v, layer.get(u) + 1); queue.push(v); }
      }
      let maxL = Math.max(...layer.values());
      const unreachable = nfa.states.filter(s => !layer.has(s));
      if (unreachable.length) { maxL += 1; unreachable.forEach(s => layer.set(s, maxL)); }

      const groups = [];
      for (let l = 0; l <= maxL; l++) groups.push(nfa.states.filter(s => layer.get(s) === l));
      const maxCount = Math.max(...groups.map(g => g.length));

      const GX = 112, GY = 80, PX = 64, PT = 74, PB = 54;
      const W = (maxL) * GX + PX * 2;
      const H = (maxCount - 1) * GY + PT + PB;
      const pos = new Map();
      const rank = new Map();
      groups.forEach((g, l) => g.forEach((s, i) => {
        pos.set(s, { x: PX + l * GX, y: PT + ((maxCount - 1) * GY) / 2 + (i - (g.length - 1) / 2) * GY });
        rank.set(s, i);
      }));

      // merge parallel edges
      const pairs = new Map();
      nfa.transitions.forEach(t => {
        const k = idx.get(t.from) + '>' + idx.get(t.to);
        if (!pairs.has(k)) pairs.set(k, { from: t.from, to: t.to, syms: [] });
        const o = pairs.get(k);
        if (!o.syms.includes(t.sym)) o.syms.push(t.sym);
      });

      const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };

      let edgesSvg = '';
      pairs.forEach((o, k) => {
        const label = esc(o.syms.join(','));
        const a = pos.get(o.from), b = pos.get(o.to);
        if (o.from === o.to) {
          const x = a.x, y = a.y;
          const d = `M ${x - R * .5} ${y - R * .87} C ${x - R * 1.25} ${y - R * 2.5}, ${x + R * 1.25} ${y - R * 2.5}, ${x + R * .5 + 1} ${y - R * .87 - 4}`;
          edgesSvg += `<g class="edge" data-k="${k}"><path class="ep" d="${d}" marker-end="url(#arr-n)"/>` +
            `<text class="el" x="${x}" y="${y - R * 2.15}">${label}</text></g>`;
          return;
        }
        const hasRev = pairs.has(idx.get(o.to) + '>' + idx.get(o.from));
        const ld = Math.abs(layer.get(o.from) - layer.get(o.to));
        const sameFar = ld === 0 && Math.abs(rank.get(o.from) - rank.get(o.to)) > 1;
        let c = 0;
        if (hasRev) c = ld > 1 ? 44 : 26;
        else if (ld > 1 || sameFar) c = -46;

        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const cx = mx + nx * c * 2, cy = my + ny * c * 2;
        const ua = unit(cx - a.x, cy - a.y), ub = unit(cx - b.x, cy - b.y);
        const sx = a.x + ua.x * R, sy = a.y + ua.y * R;
        const ex = b.x + ub.x * (R + 3), ey = b.y + ub.y * (R + 3);
        const lx = .25 * sx + .5 * cx + .25 * ex, ly = .25 * sy + .5 * cy + .25 * ey;
        let off = 11, sgn;
        if (c === 0) sgn = ny <= 0 ? 1 : -1; else sgn = c > 0 ? 1 : -1;
        const tx = lx + nx * sgn * off, ty = ly + ny * sgn * off;
        edgesSvg += `<g class="edge" data-k="${k}"><path class="ep" d="M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}" marker-end="url(#arr-n)"/>` +
          `<text class="el" x="${tx}" y="${ty}">${label}</text></g>`;
      });

      let nodesSvg = '';
      nfa.states.forEach(s => {
        const p = pos.get(s);
        const fs = s.length > 4 ? 9 : s.length > 2 ? 11 : 13;
        nodesSvg += `<g class="node" data-i="${idx.get(s)}" transform="translate(${p.x},${p.y})">` +
          `<circle r="${R}"/>` + (nfa.accept.has(s) ? `<circle class="inner" r="${R - 4.5}"/>` : '') +
          `<text style="font-size:${fs}px">${esc(s)}</text></g>`;
      });

      const sp = pos.get(nfa.start);
      const startSvg = `<path class="startarrow" d="M ${sp.x - R - 40} ${sp.y} L ${sp.x - R - 3} ${sp.y}" marker-end="url(#arr-n)"/>`;

      const svg =
        `<svg id="graphSvg" xmlns="${NS}" viewBox="0 0 ${W} ${H}" style="min-width:${W}px;width:100%;max-width:${Math.round(W * 1.5)}px" role="img" aria-label="NFA transition diagram">` +
        `<defs>` +
        `<marker id="arr-n" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path class="mk-n" d="M0,0 L10,5 L0,10 z"/></marker>` +
        `<marker id="arr-h" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path class="mk-h" d="M0,0 L10,5 L0,10 z"/></marker>` +
        `</defs>${startSvg}${edgesSvg}${nodesSvg}</svg>`;

      $('graphWrap').innerHTML = svg;

      S.graph = { nodes: new Map(), edges: new Map() };
      $('graphWrap').querySelectorAll('g.node').forEach(el => S.graph.nodes.set(nfa.states[+el.dataset.i], el));
      $('graphWrap').querySelectorAll('g.edge').forEach(el => S.graph.edges.set(el.dataset.k, el));
      S.graph.idx = idx;
    }

    function paintGraph(v) {
      if (!S.graph) return;
      const act = new Set(v ? v.active : []);
      const trail = new Set(v ? (v.trail || []) : []);
      const win = new Set(v ? v.win : []);
      S.graph.nodes.forEach((el, s) => {
        el.classList.toggle('active', act.has(s));
        el.classList.toggle('trail', !act.has(s) && trail.has(s));
        el.classList.toggle('win', win.has(s));
      });
      const hot = new Set();
      if (v) v.edges.forEach(e => hot.add(S.graph.idx.get(e[0]) + '>' + S.graph.idx.get(e[1])));
      S.graph.edges.forEach((el, k) => {
        const h = hot.has(k);
        el.classList.toggle('hot', h);
        const p = el.querySelector('path');
        if (p) p.setAttribute('marker-end', h ? 'url(#arr-h)' : 'url(#arr-n)');
      });
    }

    /* ---------- step views (unify both algorithms for the stepper) ---------- */
    function parView(s, i) {
      const last = i === S.par.steps.length - 1;
      const finalWin = last && S.par.accepted ? s.active.filter(x => S.nfa.accept.has(x)) : [];
      let title, detail, cls = '';
      if (s.kind === 'start') {
        title = 'Start';
        detail = `Begin in ${S.nfa.start}, then follow every ε-move: ε-closure({${S.nfa.start}}) = ${fmt(s.active)}.`;
      } else {
        title = `Read ${q(s.symbol)}`;
        detail = `From ${fmt(s.from)} move on ${q(s.symbol)} → ${fmt(s.moved)}; after ε-closure → ${fmt(s.active)}.`;
        if (!s.active.length) { detail += ' Every thread has died, so the string is rejected.'; cls = 'dead'; }
      }
      if (finalWin.length) { detail += ` Input consumed and ${finalWin.join(', ')} accepting → ACCEPT.`; cls = 'good'; }
      else if (last && S.par.chars.length === s.pos && s.active.length) { detail += ' Input consumed, but no active state is accepting → REJECT.'; cls = 'dead'; }
      return {
        kind: 'par', title, detail, cls,
        active: s.active, trail: [], edges: s.edges, win: finalWin, pos: s.pos,
        deadChar: (!s.active.length && s.kind === 'read') ? s.pos - 1 : -1,
        activeText: `Active states: ${fmt(s.active)}`,
        pathText: `${s.active.length} parallel thread${s.active.length === 1 ? '' : 's'}`
      };
    }

    function btView(e) {
      const trail = e.path.map(p => p[0]);
      const pathText = 'Current path: ' + (e.path.length
        ? e.path.map((p, i) => i ? `—${p[1] === EPS ? 'ε' : p[1]}→ ${p[0]}` : p[0]).join(' ')
        : '(empty)');
      let edges = [];
      if (e.type === 'cycle' || e.type === 'pruned') {
        if (e.path.length) edges = [[e.path[e.path.length - 1][0], e.state, e.via]];
      } else if (e.path.length >= 2) {
        edges = [[e.path[e.path.length - 2][0], e.path[e.path.length - 1][0], e.via]];
      }
      let title, detail, cls = '';
      switch (e.type) {
        case 'visit':
          if (e.via === null) { title = 'Start'; detail = `Begin at ${e.state}, position ${e.pos}.`; }
          else if (e.via === EPS) { title = 'ε-move'; detail = `Take an ε-move into ${e.state} (position stays ${e.pos}).`; }
          else { title = `Read ${q(e.via)}`; detail = `Consume ${q(e.via)} and move into ${e.state} (position ${e.pos}).`; }
          break;
        case 'accept':
          title = 'Accept'; cls = 'good';
          detail = `Whole input consumed and ${e.state} is accepting → ACCEPT. Search stops here.`; break;
        case 'dead':
          title = 'Dead end'; cls = 'dead';
          detail = `At ${e.state}, position ${e.pos}: no untried moves remain (and not accepting). Backtrack to the previous choice.`; break;
        case 'cycle':
          title = 'ε-cycle'; cls = 'skip';
          detail = `(${e.state}, position ${e.pos}) is already on the current path — skipping to avoid looping forever.`; break;
        case 'pruned':
          title = 'Already failed'; cls = 'skip';
          detail = `(${e.state}, position ${e.pos}) was explored before and failed — skipping the repeat work.`; break;
      }
      return {
        kind: 'bt', title, detail, cls,
        active: [e.state], trail, edges, win: e.type === 'accept' ? [e.state] : [], pos: e.pos,
        deadChar: -1,
        activeText: `Position ${e.pos} of ${S.bt.chars.length} · state ${e.state}`,
        pathText
      };
    }

    function steps() {
      if (!S.par) return [];
      return S.mode === 'parallel'
        ? S.par.steps.map(parView)
        : S.bt.events.map(btView);
    }

    /* ---------- trace list ---------- */
    function buildTrace() {
      const box = $('trace');
      if (!S.par) {
        box.innerHTML = '<div class="tr-empty">The step-by-step trace appears here after you run a string.</div>';
        $('traceCount').textContent = '';
        return;
      }
      let html = '';
      if (S.mode === 'parallel') {
        S.par.steps.forEach((s, i) => {
          if (s.kind === 'start') {
            html += `<button class="tr" data-i="${i}"><span class="ic i-go">▸</span>start <span class="k">→</span> ${esc(fmt(s.active))}</button>`;
          } else {
            const ok = s.active.length > 0;
            html += `<button class="tr" data-i="${i}"><span class="ic ${ok ? 'i-go' : 'i-bad'}">${ok ? '▸' : '✗'}</span>` +
              `${esc(q(s.symbol))} <span class="k">${esc(fmt(s.from))} →</span> ${esc(fmt(s.active))}</button>`;
          }
        });
        $('traceCount').textContent = `· ${S.par.steps.length} step${S.par.steps.length === 1 ? '' : 's'}`;
      } else {
        S.bt.events.forEach((e, i) => {
          const d = Math.min(e.depth, 14);
          let ic, txt;
          switch (e.type) {
            case 'visit':
              ic = '<span class="ic i-go">→</span>';
              txt = e.via === null ? `start at ${e.state}` :
                e.via === EPS ? `ε <span class="k">→</span> ${e.state}` : `${q(e.via)} <span class="k">→</span> ${e.state}`;
              txt += ` <span class="k">@${e.pos}</span>`; break;
            case 'accept': ic = '<span class="ic i-ok">✓</span>'; txt = `ACCEPT at ${e.state} <span class="k">@${e.pos}</span>`; break;
            case 'dead': ic = '<span class="ic i-bad">✗</span>'; txt = `dead end at ${e.state} <span class="k">@${e.pos} · backtrack</span>`; break;
            case 'cycle': ic = '<span class="ic i-skip">⟲</span>'; txt = `ε-cycle at ${e.state} <span class="k">@${e.pos} · skip</span>`; break;
            case 'pruned': ic = '<span class="ic i-skip">◌</span>'; txt = `${e.state} <span class="k">@${e.pos} already failed · skip</span>`; break;
          }
          html += `<button class="tr" data-i="${i}" style="--d:${d}">${ic}${txt}</button>`;
        });
        $('traceCount').textContent = `· ${S.bt.events.length} event${S.bt.events.length === 1 ? '' : 's'}`;
      }
      box.innerHTML = html;
    }

    function paintTrace() {
      const box = $('trace');
      const prev = box.querySelector('.tr.cur');
      if (prev) prev.classList.remove('cur');
      const el = box.querySelector(`.tr[data-i="${S.idx}"]`);
      if (!el) return;
      el.classList.add('cur');
      const top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, top - box.clientHeight / 2);
      }
    }

    /* ---------- tape, banner, explain ---------- */
    function paintTape(v) {
      const chars = S.par ? S.par.chars : [];
      const tape = $('tape');
      if (!S.par) { tape.innerHTML = '<span class="tape-empty">Input tape appears here.</span>'; return; }
      if (!chars.length) { tape.innerHTML = '<span class="tape-empty">ε — the empty string (nothing to read)</span>'; return; }
      const pos = v ? v.pos : 0;
      tape.innerHTML = chars.map((c, i) => {
        let cls = 'cell';
        if (i === v.deadChar) cls += ' dead';
        else if (i < pos) cls += ' read';
        else if (i === pos) cls += ' next';
        return `<span class="${cls}">${esc(c)}</span>`;
      }).join('');
    }

    function paintBanner() {
      const b = $('banner');
      if (!S.par) { b.hidden = true; return; }
      const acc = S.par.accepted;
      const label = S.input === '' ? 'ε (empty string)' : `"${esc(S.input)}"`;
      const btKnown = !S.bt.truncated || S.bt.accepted;
      const agree = btKnown ? S.bt.accepted === acc : null;
      const parTxt = S.par.dead ? `died after ${S.par.steps.length - 1} symbol${S.par.steps.length === 2 ? '' : 's'}` : `${S.par.steps.length - 1} step${S.par.steps.length === 2 ? '' : 's'}`;
      let sub = `Parallel: ${acc ? 'accept' : 'reject'} (${parTxt}) · Backtracking: `;
      sub += btKnown ? `${S.bt.accepted ? 'accept' : 'reject'} (${S.bt.events.length} events)` : 'stopped early (too many events)';
      if (agree === true) sub += ' · engines agree ✓';
      let warn = '';
      if (agree === false) warn = '⚠ The two engines disagree — please report this input.';
      if (S.bt.truncated && !S.bt.accepted) warn += (warn ? ' ' : '') + `Backtracking log was cut at ${S.bt.events.length} events; the parallel result is authoritative.`;
      if (S.unknownSyms.length) warn += (warn ? ' ' : '') + `Symbol${S.unknownSyms.length > 1 ? 's' : ''} ${S.unknownSyms.map(q).join(', ')} not in Σ — no transition can read ${S.unknownSyms.length > 1 ? 'them' : 'it'}.`;
      b.className = 'banner ' + (acc ? 'ok' : 'bad');
      b.innerHTML = `<div class="big">${acc ? '✓ ACCEPTED' : '✗ REJECTED'}</div>` +
        `<div class="sub">${label} ${acc ? '∈' : '∉'} L(N)</div><div class="sub">${esc(sub)}</div>` +
        (warn ? `<div class="warn">${esc(warn)}</div>` : '');
      b.hidden = false;
    }

    function paintExplain(v, n) {
      const box = $('explain');
      if (!v) {
        box.className = 'explain';
        box.innerHTML = '<p class="muted">Press <b>Run</b> to start the simulation.</p>';
        return;
      }
      box.className = 'explain ' + v.cls;
      box.innerHTML = `<div class="t">${esc(v.title)}</div><div class="d">${esc(v.detail)}</div>` +
        `<div class="a">${esc(v.activeText)}</div><div class="p">${esc(v.pathText)}</div>`;
    }

    /* ---------- master render ---------- */
    function render() {
      const list = steps();
      const has = list.length > 0;
      if (S.idx > list.length - 1) S.idx = Math.max(0, list.length - 1);
      const v = has ? list[S.idx] : null;

      ['btnFirst', 'btnPrev', 'btnNext', 'btnLast', 'btnPlay'].forEach(id => { $(id).disabled = !has; });
      if (has) {
        $('btnFirst').disabled = $('btnPrev').disabled = S.idx === 0;
        $('btnNext').disabled = $('btnLast').disabled = S.idx >= list.length - 1;
      }
      $('btnPlay').innerHTML = S.playing ? '&#9208;' : '&#9654;';
      $('stepLabel').textContent = has ? `step ${S.idx + 1} / ${list.length}  ·  ${S.mode === 'parallel' ? 'parallel paths' : 'backtracking'}` : '–';

      paintGraph(v);
      paintTape(v);
      paintExplain(v);
      paintBanner();
      paintTrace();
    }

    /* ---------- run / navigation ---------- */
    function run(autoplay) {
      if (!S.nfa) return;
      stopPlay();
      let raw = $('inputStr').value.replace(/\s+/g, '');
      if (raw === 'ε') raw = '';
      S.input = raw;
      S.unknownSyms = dedupe(Array.from(raw).filter(c => !S.nfa.alphabet.includes(c)));
      S.par = simulateParallel(S.nfa, raw);
      S.bt = simulateBacktrack(S.nfa, raw);
      S.idx = 0;
      buildTrace();
      render();
      if (autoplay !== false && steps().length > 1) play();
    }

    function go(i) {
      const n = steps().length;
      if (!n) return;
      S.idx = Math.max(0, Math.min(n - 1, i));
      render();
    }

    function speed() { return +$('speed').value || 900; }

    function play() {
      const n = steps().length;
      if (!n) return;
      if (S.idx >= n - 1) S.idx = 0;
      S.playing = true;
      clearInterval(S.timer);
      S.timer = setInterval(() => {
        if (S.idx >= steps().length - 1) { stopPlay(); return; }
        S.idx++;
        render();
      }, speed());
      render();
    }

    function stopPlay() {
      S.playing = false;
      clearInterval(S.timer);
      S.timer = null;
      if (S.par) render();
    }

    function setMode(m) {
      if (S.mode === m) return;
      stopPlay();
      S.mode = m;
      $('modePar').classList.toggle('on', m === 'parallel');
      $('modeBt').classList.toggle('on', m === 'backtrack');
      $('modeDesc').textContent = MODE_TEXT[m];
      S.idx = 0;
      buildTrace();
      render();
    }

    /* ---------- PWA bits ---------- */
    function setupPwa() {
      let deferred = null;
      const btn = $('installBtn');
      window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        deferred = e;
        btn.hidden = false;
      });
      btn.addEventListener('click', async () => {
        if (!deferred) return;
        deferred.prompt();
        try { await deferred.userChoice; } catch (e) { /* dismissed */ }
        deferred = null;
        btn.hidden = true;
      });
      window.addEventListener('appinstalled', () => { btn.hidden = true; deferred = null; });

      const net = () => { $('netState').textContent = navigator.onLine ? 'Online' : 'Offline mode'; };
      window.addEventListener('online', net);
      window.addEventListener('offline', net);
      net();

      if ('serviceWorker' in navigator) {
        // register straight away (not on 'load') so audit tools such as PWABuilder detect it reliably
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .catch(err => console.warn('Service worker not registered:', err));
      }
    }

    /* ---------- init ---------- */
    function init() {
      populatePresets();
      $('modeDesc').textContent = MODE_TEXT.parallel;

      $('preset').addEventListener('change', e => { if (e.target.value !== 'custom') choosePreset(e.target.value); });
      $('applyBtn').addEventListener('click', () => {
        S.presetId = 'custom';
        $('preset').value = 'custom';
        $('presetDesc').textContent = 'Your own machine. It is saved on this device.';
        applyMachine(true);
      });
      $('resetBtn').addEventListener('click', () => {
        const id = S.presetId === 'custom' ? PRESETS[0].id : S.presetId;
        choosePreset(id);
      });

      $('runBtn').addEventListener('click', () => run());
      $('inputStr').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      $('examples').addEventListener('click', e => {
        const b = e.target.closest('.chip');
        if (!b) return;
        $('inputStr').value = b.dataset.s;
        run();
      });

      $('modePar').addEventListener('click', () => setMode('parallel'));
      $('modeBt').addEventListener('click', () => setMode('backtrack'));

      $('btnFirst').addEventListener('click', () => { stopPlay(); go(0); });
      $('btnPrev').addEventListener('click', () => { stopPlay(); go(S.idx - 1); });
      $('btnNext').addEventListener('click', () => { stopPlay(); go(S.idx + 1); });
      $('btnLast').addEventListener('click', () => { stopPlay(); go(steps().length - 1); });
      $('btnPlay').addEventListener('click', () => { S.playing ? stopPlay() : play(); });
      $('speed').addEventListener('change', () => { if (S.playing) play(); });

      $('trace').addEventListener('click', e => {
        const b = e.target.closest('.tr');
        if (!b) return;
        stopPlay();
        go(+b.dataset.i);
      });

      document.addEventListener('keydown', e => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (e.key === 'ArrowRight') { stopPlay(); go(S.idx + 1); }
        else if (e.key === 'ArrowLeft') { stopPlay(); go(S.idx - 1); }
        else if (e.key === ' ' && S.par) { e.preventDefault(); S.playing ? stopPlay() : play(); }
      });

      // restore the last machine, otherwise start with the first preset
      let restored = false;
      try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (saved && saved.def) {
          fillFields(saved.def);
          S.presetId = PRESETS.some(p => p.id === saved.presetId) ? saved.presetId : 'custom';
          $('preset').value = S.presetId;
          const p = PRESETS.find(x => x.id === S.presetId);
          $('presetDesc').textContent = p ? p.desc : 'Your own machine. It is saved on this device.';
          restored = applyMachine(false);
        }
      } catch (e) { restored = false; }
      if (!restored) choosePreset(PRESETS[0].id);

      // on phones, keep the editor collapsed so the graph and run controls are visible first
      const body = $('machineBody'), tog = $('toggleMachine');
      const setOpen = open => { body.hidden = !open; tog.textContent = open ? 'Hide editor ▴' : 'Edit machine ▾'; tog.setAttribute('aria-expanded', open); };
      setOpen(window.innerWidth >= 980);
      tog.addEventListener('click', () => setOpen(body.hidden));

      setupPwa();
    }

    function dedupe(a) { return Array.from(new Set(a)); }

    init();
  })();
}
