import {
  schedule, flatten, childrenOf, iso, parseISO, addDays, todayISO,
  daysBetween, workdaysSpan
} from './scheduler.js';
import * as store from './store.js';

/* ==========================================================================
   Constants
   ========================================================================== */

const PALETTE = [
  '#2f6feb', '#c0392b', '#27ae60', '#e0a80f',
  '#8e44ad', '#0f9b8e', '#d35400', '#546e7a'
];

const ZOOM = {
  day: { px: 26, weekend: true },
  week: { px: 9.5, weekend: false },
  month: { px: 3.4, weekend: false }
};

const COLS = [
  { key: 'num', label: '', w: 36, min: 30, fixed: true },
  { key: 'name', label: 'Task Name', w: 268, min: 130 },
  { key: 'owner', label: 'Responsible', w: 112, min: 60 },
  { key: 'duration', label: 'Days', w: 54, min: 44, align: 'center' },
  { key: 'start', label: 'Start', w: 84, min: 64, align: 'center' },
  { key: 'finish', label: 'Finish', w: 84, min: 64, align: 'center' },
  { key: 'pct', label: '% Done', w: 84, min: 58, align: 'center' }
];

const ROW_H = 30;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/* ==========================================================================
   State
   ========================================================================== */

const S = {
  meta: {},
  tasks: [],
  links: [],
  computed: null,
  rows: [],
  presence: [],
  zoom: 'week',
  sel: null,
  geom: new Map(),
  range: null,
  ready: false,
  undo: [],
  suppressUndo: false
};

const el = id => document.getElementById(id);

/* remember column widths and zoom per browser */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('gantt.prefs') || '{}');
    if (p.widths) COLS.forEach(c => { if (p.widths[c.key]) c.w = p.widths[c.key]; });
    if (p.zoom && ZOOM[p.zoom]) S.zoom = p.zoom;
  } catch (e) { /* first run */ }
}

function savePrefs() {
  try {
    const widths = {};
    COLS.forEach(c => widths[c.key] = c.w);
    localStorage.setItem('gantt.prefs', JSON.stringify({ widths, zoom: S.zoom }));
  } catch (e) { /* private browsing */ }
}

/* ==========================================================================
   Boot
   ========================================================================== */

loadPrefs();

el('signin').addEventListener('click', async () => {
  el('gateErr').textContent = '';
  try { await store.signIn(); }
  catch (err) { el('gateErr').textContent = store.friendlyAuthError(err); }
});

store.onPermissionError(() => {
  showWarning('The database refused that change. Check that the rules allow @vt.edu accounts and that you are signed in with yours.');
});

store.watchUser(
  async user => {
    el('gate').classList.add('hidden');
    el('app').classList.add('ready');
    store.announce(user);
    try { await store.seedIfEmpty(starterSchedule()); }
    catch (e) { /* someone else seeded it first, or rules blocked it */ }
    startListening();
    wireChrome();
  },
  message => {
    el('gate').classList.remove('hidden');
    el('app').classList.remove('ready');
    if (message) el('gateErr').textContent = message;
  }
);

let listening = false;
function startListening() {
  if (listening) return;
  listening = true;
  store.subscribe({
    meta: m => { S.meta = m; onData(); },
    tasks: t => { S.tasks = t; onData(); },
    links: l => { S.links = l; onData(); },
    presence: p => { S.presence = p; renderPeople(); }
  });
}

function onData() {
  S.ready = true;
  const t = el('title');
  if (document.activeElement !== t) t.value = S.meta.name || 'Project Schedule';
  document.title = (S.meta.name || 'Project Schedule');
  recompute();
  render();
}

function recompute() {
  S.computed = schedule({
    projectStart: S.meta.projectStart || todayISO(),
    holidays: Object.keys(S.meta.holidays || {}),
    tasks: S.tasks,
    links: S.links
  });
  S.rows = flatten(S.computed.tasks).filter(r => r.visible);
  showWarning(S.computed.warnings.join(' '));
}

function showWarning(text) {
  const w = el('warn');
  if (!text) { w.classList.remove('show'); w.textContent = ''; return; }
  w.classList.add('show');
  w.textContent = text;
}

/* ==========================================================================
   Helpers
   ========================================================================== */

function byId(id) { return S.computed.tasks.find(t => t.id === id); }

function fmtDate(isoStr) {
  if (!isoStr) return '';
  const d = parseISO(isoStr);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + String(d.getUTCFullYear()).slice(2);
}

function outlineCodes() {
  const codes = new Map();
  const kids = new Map();
  for (const t of S.computed.tasks) {
    const p = t.parent || 0;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const walk = (parent, prefix) => {
    (kids.get(parent) || []).forEach((t, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      codes.set(t.id, code);
      walk(t.id, code);
    });
  };
  walk(0, '');
  return codes;
}

function descendantsOf(id) {
  const kids = childrenOf(S.computed.tasks);
  const out = [];
  const walk = p => { for (const c of (kids.get(p) || [])) { out.push(c); walk(c); } };
  walk(id);
  return out;
}

function linksTouching(ids) {
  const set = new Set(ids);
  return S.links.filter(l => set.has(l.source) || set.has(l.target)).map(l => l.id);
}

function gridWidth() { return COLS.reduce((a, c) => a + c.w, 0); }

function toast(msg, ms = 2400) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* Snapshot for undo. Cheap because the plan is small. */
function snapshot() {
  if (S.suppressUndo) return;
  const tasks = {}, links = {};
  for (const t of S.tasks) { const { id, ...rest } = t; tasks[id] = rest; }
  for (const l of S.links) { const { id, ...rest } = l; links[id] = rest; }
  S.undo.push({ tasks, links });
  if (S.undo.length > 30) S.undo.shift();
}

async function undo() {
  const prev = S.undo.pop();
  if (!prev) { toast('Nothing to undo'); return; }
  S.suppressUndo = true;
  try {
    await store.applyPatch({ tasks: prev.tasks, links: prev.links });
    toast('Undone');
  } finally {
    S.suppressUndo = false;
  }
}

/* Order values are fractional so a row can always be inserted between two
   others without renumbering everything. */
function orderBetween(before, after) {
  if (before == null && after == null) return 1;
  if (before == null) return after - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

function siblingsOf(parent) {
  return S.computed.tasks
    .filter(t => (t.parent || 0) === (parent || 0))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/* ==========================================================================
   Rendering: grid
   ========================================================================== */

function render() {
  el('gridPane').style.width = gridWidth() + 'px';
  renderHead();
  renderRows();
  renderTimeline();
}

function renderHead() {
  const head = el('gridHead');
  head.innerHTML = '';
  COLS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'hcell' + (c.key === 'num' ? ' num' : '') +
      (c.align === 'center' ? ' center' : '');
    d.style.width = c.w + 'px';
    d.textContent = c.label;

    if (c.key === 'name') {
      const add = document.createElement('button');
      add.id = 'addPhase';
      add.title = 'Add a top level phase';
      add.textContent = '+';
      add.addEventListener('click', e => { e.stopPropagation(); addPhase(); });
      d.appendChild(add);
    }

    if (!c.fixed || c.key === 'num') {
      const grip = document.createElement('div');
      grip.className = 'hgrip';
      grip.addEventListener('mousedown', e => startColumnResize(e, i));
      d.appendChild(grip);
    }
    head.appendChild(d);
  });
}

function renderRows() {
  const body = el('gridBody');
  const keepScroll = body.scrollTop;
  body.innerHTML = '';
  const codes = outlineCodes();
  const frag = document.createDocumentFragment();

  S.rows.forEach((row, i) => {
    const t = row.task;
    const div = document.createElement('div');
    div.className = 'row' + (t.isSummary ? ' summary' : '') + (S.sel === t.id ? ' sel' : '');
    div.dataset.id = t.id;
    div.dataset.index = i;

    for (const c of COLS) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (c.align === 'center' ? ' center' : '');
      cell.style.width = c.w + 'px';
      cell.dataset.col = c.key;

      switch (c.key) {
        case 'num':
          cell.classList.add('num');
          cell.textContent = i + 1;
          cell.title = 'Drag to move this row';
          cell.addEventListener('mousedown', e => startRowDrag(e, t.id));
          break;

        case 'name': {
          cell.classList.add('name');
          cell.style.paddingLeft = (8 + row.depth * 15) + 'px';

          const tw = document.createElement('span');
          tw.className = 'twist' + (row.hasKids ? (t.open === false ? ' closed' : '') : ' leaf');
          tw.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          if (row.hasKids) {
            tw.addEventListener('click', e => {
              e.stopPropagation();
              store.patchTask(t.id, { open: t.open === false });
            });
          }
          cell.appendChild(tw);

          if (row.depth === 0) {
            const sw = document.createElement('span');
            sw.className = 'swatch';
            sw.style.background = t.colour || PALETTE[0];
            sw.title = 'Colour for this phase';
            sw.addEventListener('click', e => { e.stopPropagation(); openPalette(e, t.id); });
            cell.appendChild(sw);
          }

          const label = document.createElement('span');
          label.className = 'nametext' + (t.isMilestone ? ' milestone' : '');
          const code = codes.get(t.id) || '';
          label.innerHTML = `<span class="hint">${code}</span> ` + escapeHTML(t.text || '');
          label.addEventListener('click', e => { e.stopPropagation(); editText(t.id, label); });
          cell.appendChild(label);

          const btns = document.createElement('span');
          btns.className = 'rowbtns';
          btns.innerHTML =
            `<button class="add" title="Add a sub task here">` +
            `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>` +
            `<button class="del" title="Delete this row">` +
            `<svg width="12" height="12" viewBox="0 0 14 14"><path d="M2.5 3.5h9M5.5 3.5V2.2h3v1.3M4 3.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
          btns.querySelector('.add').addEventListener('click', e => { e.stopPropagation(); addChild(t.id); });
          btns.querySelector('.del').addEventListener('click', e => { e.stopPropagation(); deleteRow(t.id); });
          cell.appendChild(btns);
          break;
        }

        case 'owner':
          cell.classList.add('editable');
          cell.textContent = t.owner || '';
          if (!t.owner) { cell.innerHTML = '<span class="hint">&mdash;</span>'; }
          cell.addEventListener('click', () => editOwner(t.id, cell));
          break;

        case 'duration':
          if (t.isSummary) {
            cell.innerHTML = `<span class="hint">${t.duration}</span>`;
          } else {
            cell.classList.add('editable');
            cell.textContent = t.duration;
            cell.addEventListener('click', () => editNumber(t.id, cell, 'duration'));
          }
          break;

        case 'start':
          if (t.isSummary) {
            cell.innerHTML = `<span class="hint">${fmtDate(t.start)}</span>`;
          } else {
            cell.classList.add('editable');
            cell.innerHTML = (t.pinned ? '<span class="pinned-dot">&#9679;</span>' : '') + fmtDate(t.start);
            cell.title = t.pinned ? 'Date set by hand. Right click to let the dependency drive it again.' : '';
            cell.addEventListener('click', () => editDate(t.id, cell, 'start'));
            cell.addEventListener('contextmenu', e => { e.preventDefault(); unpin(t.id); });
          }
          break;

        case 'finish':
          if (t.isSummary || t.isMilestone) {
            cell.innerHTML = `<span class="hint">${fmtDate(t.finish)}</span>`;
          } else {
            cell.classList.add('editable');
            cell.textContent = fmtDate(t.finish);
            cell.addEventListener('click', () => editDate(t.id, cell, 'finish'));
          }
          break;

        case 'pct': {
          const wrap = document.createElement('span');
          wrap.className = 'pct-wrap';
          wrap.innerHTML =
            `<span class="pct-bar"><span class="pct-fill" style="width:${t.pct}%"></span></span>` +
            `<span class="pct-num">${t.pct}%</span>`;
          cell.appendChild(wrap);
          if (!t.isSummary) {
            cell.classList.add('editable');
            cell.addEventListener('click', () => editNumber(t.id, cell, 'progress'));
          }
          break;
        }
      }
      div.appendChild(cell);
    }

    div.addEventListener('mousedown', () => select(t.id));
    frag.appendChild(div);
  });

  body.appendChild(frag);
  body.scrollTop = keepScroll;

  if (!S.rows.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:26px 18px;color:#6b7684;line-height:1.6;';
    empty.innerHTML = 'Nothing here yet. ';
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.textContent = 'Add the first phase';
    b.addEventListener('click', addPhase);
    empty.appendChild(b);
    body.appendChild(empty);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function select(id) {
  if (S.sel === id) return;
  S.sel = id;
  document.querySelectorAll('#gridBody .row, .tlrow').forEach(r => {
    r.classList.toggle('sel', r.dataset.id === String(id));
  });
}

/* ==========================================================================
   Rendering: timeline
   ========================================================================== */

function timelineRange() {
  const c = S.computed;
  let min = c.start, max = c.end;
  for (const t of c.tasks) {
    if (t.start < min) min = t.start;
    if (t.finish > max) max = t.finish;
  }
  const today = todayISO();
  if (today < min) min = today;
  if (today > max) max = today;
  /* start on the Monday of that week so the day scale lines up */
  let from = parseISO(min);
  from = addDays(from, -(((from.getUTCDay() + 6) % 7) + 7));
  const to = addDays(parseISO(max), 21);
  return { from: iso(from), to: iso(to), days: Math.max(14, daysBetween(iso(from), iso(to))) };
}

function renderTimeline() {
  const c = S.computed;
  const z = ZOOM[S.zoom];
  const range = S.range = timelineRange();
  const px = z.px;
  const width = Math.ceil(range.days * px);
  const height = S.rows.length * ROW_H;

  const x = isoStr => Math.round(daysBetween(range.from, isoStr) * px);

  /* ---- header ---- */
  const head = el('tlHead');
  head.style.width = width + 'px';
  head.innerHTML = '';
  const top = document.createElement('div');
  top.className = 'scale-top';
  top.style.width = width + 'px';
  const bot = document.createElement('div');
  bot.className = 'scale-bot';
  bot.style.width = width + 'px';

  const stick = (left, w, text, cls) => {
    const s = document.createElement('div');
    s.className = 'stick' + (cls ? ' ' + cls : '');
    s.style.left = left + 'px';
    s.style.width = w + 'px';
    s.textContent = w > 16 ? text : '';
    s.title = text;
    return s;
  };

  if (S.zoom === 'day') {
    /* top: one band per week, labelled with the week's start date */
    for (let d = parseISO(range.from); iso(d) < range.to; d = addDays(d, 7)) {
      const left = x(iso(d));
      top.appendChild(stick(left, Math.round(7 * px),
        `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} '${String(d.getUTCFullYear()).slice(2)}`));
    }
    /* bottom: one cell per day, single letter */
    for (let d = parseISO(range.from); iso(d) < range.to; d = addDays(d, 1)) {
      const dow = d.getUTCDay();
      const off = dow === 0 || dow === 6 || (S.meta.holidays || {})[iso(d)];
      bot.appendChild(stick(x(iso(d)), Math.round(px), DOW[dow], off ? 'we' : ''));
    }
  } else if (S.zoom === 'week') {
    for (let d = firstOfMonth(range.from); iso(d) < range.to; d = nextMonth(d)) {
      const left = x(iso(d) < range.from ? range.from : iso(d));
      const right = x(minISO(iso(nextMonth(d)), range.to));
      top.appendChild(stick(left, right - left, `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`));
    }
    for (let d = parseISO(range.from); iso(d) < range.to; d = addDays(d, 7)) {
      bot.appendChild(stick(x(iso(d)), Math.round(7 * px), String(d.getUTCDate())));
    }
  } else {
    for (let y = parseISO(range.from).getUTCFullYear(); ; y++) {
      const s = `${y}-01-01`, e = `${y + 1}-01-01`;
      if (s >= range.to) break;
      const left = x(maxISO(s, range.from));
      const right = x(minISO(e, range.to));
      if (right > left) top.appendChild(stick(left, right - left, String(y)));
      if (e >= range.to) break;
    }
    for (let d = firstOfMonth(range.from); iso(d) < range.to; d = nextMonth(d)) {
      const left = x(maxISO(iso(d), range.from));
      const right = x(minISO(iso(nextMonth(d)), range.to));
      bot.appendChild(stick(left, right - left, MONTHS[d.getUTCMonth()].slice(0, 3)));
    }
  }
  head.appendChild(top);
  head.appendChild(bot);

  /* ---- body ---- */
  const canvas = el('tlCanvas');
  canvas.innerHTML = '';
  canvas.style.width = width + 'px';
  canvas.style.height = Math.max(height, 40) + 'px';

  const frag = document.createDocumentFragment();

  /* weekend shading, only when days are wide enough to read */
  if (z.weekend) {
    for (let d = parseISO(range.from); iso(d) < range.to; d = addDays(d, 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6 || (S.meta.holidays || {})[iso(d)]) {
        const w = document.createElement('div');
        w.className = 'wecol';
        w.style.left = x(iso(d)) + 'px';
        w.style.width = Math.ceil(px) + 'px';
        w.style.height = height + 'px';
        frag.appendChild(w);
      }
    }
  }

  /* vertical rules */
  const step = S.zoom === 'day' ? 1 : 7;
  if (S.zoom !== 'month') {
    for (let d = parseISO(range.from); iso(d) < range.to; d = addDays(d, step)) {
      const g = document.createElement('div');
      g.className = 'gline' + (d.getUTCDate() <= step ? ' strong' : '');
      g.style.left = x(iso(d)) + 'px';
      g.style.height = height + 'px';
      frag.appendChild(g);
    }
  } else {
    for (let d = firstOfMonth(range.from); iso(d) < range.to; d = nextMonth(d)) {
      const g = document.createElement('div');
      g.className = 'gline' + (d.getUTCMonth() === 0 ? ' strong' : '');
      g.style.left = x(iso(d)) + 'px';
      g.style.height = height + 'px';
      frag.appendChild(g);
    }
  }

  /* row bands */
  S.rows.forEach((row, i) => {
    const r = document.createElement('div');
    r.className = 'tlrow' + (i % 2 ? ' alt' : '') + (S.sel === row.task.id ? ' sel' : '');
    r.style.top = (i * ROW_H) + 'px';
    r.style.width = width + 'px';
    r.dataset.id = row.task.id;
    r.dataset.index = i;
    frag.appendChild(r);
  });

  /* today */
  const t0 = todayISO();
  if (t0 >= range.from && t0 <= range.to) {
    const tl = document.createElement('div');
    tl.id = 'today';
    tl.style.left = x(t0) + 'px';
    tl.style.height = height + 'px';
    tl.title = 'Today';
    frag.appendChild(tl);
  }

  /* dependency arrows sit under the bars */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'links';
  svg.setAttribute('width', width);
  svg.setAttribute('height', Math.max(height, 40));
  frag.appendChild(svg);

  /* bars */
  S.geom.clear();
  S.rows.forEach((row, i) => {
    const t = row.task;
    const bar = document.createElement('div');
    const y = i * ROW_H;
    const left = x(t.start);
    const right = t.isMilestone ? left : x(iso(addDays(parseISO(t.finish), 1)));
    const w = Math.max(t.isMilestone ? 13 : 4, right - left);

    bar.className = 'bar' + (t.isSummary ? ' summary' : '') + (t.isMilestone ? ' milestone' : '');
    bar.dataset.id = t.id;
    bar.style.left = (t.isMilestone ? left - 6 : left) + 'px';
    bar.style.top = (y + (t.isSummary ? 10 : t.isMilestone ? 8 : 7)) + 'px';
    if (!t.isMilestone) bar.style.width = w + 'px';
    if (!t.isSummary && !t.isMilestone) bar.style.background = t.colour || PALETTE[0];

    bar.title = `${t.text}\n${fmtDate(t.start)} to ${fmtDate(t.finish)}` +
      (t.isMilestone ? '' : `\n${t.duration} working day${t.duration === 1 ? '' : 's'}`) +
      (t.owner ? `\n${t.owner}` : '') + `\n${t.pct}% done`;

    if (!t.isMilestone && t.pct > 0) {
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = (w * t.pct / 100) + 'px';
      bar.appendChild(fill);
    }

    if (!t.isSummary) {
      if (!t.isMilestone) {
        const g = document.createElement('span');
        g.className = 'grip r';
        g.addEventListener('mousedown', e => startResize(e, t.id));
        bar.appendChild(g);
      }
      for (const side of ['l', 'r']) {
        const k = document.createElement('span');
        k.className = 'knob ' + side;
        k.addEventListener('mousedown', e => startLink(e, t.id, side));
        bar.appendChild(k);
      }
      bar.addEventListener('mousedown', e => startBarDrag(e, t.id));
    }

    S.geom.set(t.id, {
      x1: t.isMilestone ? left - 6 : left,
      x2: t.isMilestone ? left + 7 : left + w,
      y: y + ROW_H / 2, row: i
    });
    frag.appendChild(bar);
  });

  canvas.appendChild(frag);
  drawLinks();
}

function firstOfMonth(isoStr) {
  const d = parseISO(isoStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function nextMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
const minISO = (a, b) => a < b ? a : b;
const maxISO = (a, b) => a > b ? a : b;

function drawLinks() {
  const svg = el('links');
  if (!svg) return;
  svg.innerHTML =
    '<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">' +
    '<path d="M0,0 L7,3.5 L0,7 z" fill="#8b95a3"/></marker></defs>';

  for (const l of S.computed.links) {
    const a = S.geom.get(l.source), b = S.geom.get(l.target);
    if (!a || !b) continue;

    const type = String(l.type);
    const sx = (type === '1' || type === '3') ? a.x1 : a.x2;
    const tx = (type === '2' || type === '3') ? b.x2 : b.x1;
    const sy = a.y, ty = b.y;
    const out = (type === '1' || type === '3') ? -8 : 8;
    const into = (type === '2' || type === '3') ? 7 : -7;

    let d;
    if ((into < 0 && tx >= sx + 14) || (into > 0 && tx <= sx - 14)) {
      d = `M${sx},${sy} H${sx + out} V${ty} H${tx + into}`;
    } else {
      const mid = ty > sy ? sy + ROW_H / 2 : sy - ROW_H / 2;
      d = `M${sx},${sy} H${sx + out} V${mid} H${tx + into * 2} V${ty} H${tx + into}`;
    }

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'hit');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', d);
    arrow.setAttribute('class', 'arrow');
    arrow.setAttribute('marker-end', 'url(#ah)');
    g.appendChild(arrow);
    g.appendChild(hit);
    const sName = byId(l.source)?.text || '', tName = byId(l.target)?.text || '';
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${sName} to ${tName}. Click to remove.`;
    g.appendChild(title);
    hit.addEventListener('click', () => removeLinkById(l.id, sName, tName));
    svg.appendChild(g);
  }
}

function renderPeople() {
  const box = el('people');
  box.innerHTML = '';
  const me = store.user();
  for (const p of S.presence.slice(0, 6)) {
    const d = document.createElement('div');
    d.className = 'who';
    d.title = p.name + (me && p.id === me.uid ? ' (you)' : '');
    if (p.photo) {
      const img = document.createElement('img');
      img.src = p.photo;
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { d.textContent = initials(p.name); };
      d.appendChild(img);
    } else {
      d.textContent = initials(p.name);
    }
    box.appendChild(d);
  }
}

function initials(name) {
  return String(name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2)
    .map(s => s[0].toUpperCase()).join('');
}

/* ==========================================================================
   Cell editing
   ========================================================================== */

let activeEditor = null;

function closeEditor(commit) {
  if (!activeEditor) return;
  const ed = activeEditor;
  activeEditor = null;
  if (commit) { try { ed._commit(ed.value); } catch (e) { console.error(e); } }
  ed.remove();
}

/* The editor is positioned over the exact text it replaces, so nothing shifts
   when you click into an indented row. */
function openEditor(anchor, value, type, commit) {
  closeEditor(true);
  const r = anchor.getBoundingClientRect();
  const ed = document.createElement('input');
  ed.className = 'editor';
  ed.type = type;
  ed.value = value;
  ed.style.left = Math.round(r.left - 3) + 'px';
  ed.style.top = Math.round(r.top - 2) + 'px';
  ed.style.height = Math.max(22, Math.round(r.height + 4)) + 'px';
  ed.style.width = Math.max(70, Math.round(r.width + 12)) + 'px';
  ed._commit = commit;

  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); closeEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
    else if (e.key === 'Tab') { e.preventDefault(); closeEditor(true); }
    e.stopPropagation();
  });
  ed.addEventListener('blur', () => closeEditor(true));

  document.body.appendChild(ed);
  activeEditor = ed;
  ed.focus();
  if (type === 'date') { try { ed.showPicker(); } catch (e) { /* older browser */ } }
  else ed.select();
  return ed;
}

function editText(id, anchor) {
  const t = byId(id);
  openEditor(anchor, t.text || '', 'text', v => {
    const next = v.trim();
    if (next === (t.text || '')) return;
    snapshot();
    store.patchTask(id, { text: next });
  });
}

function editOwner(id, cell) {
  const t = byId(id);
  openEditor(cell, t.owner || '', 'text', v => {
    const next = v.trim();
    if (next === (t.owner || '')) return;
    snapshot();
    store.patchTask(id, { owner: next });
  });
}

function editNumber(id, cell, field) {
  const t = byId(id);
  const current = field === 'duration' ? t.duration : t.pct;
  openEditor(cell, String(current), 'number', v => {
    let n = Math.round(Number(v));
    if (!isFinite(n)) return;
    if (field === 'progress') n = Math.max(0, Math.min(100, n));
    else n = Math.max(0, Math.min(3650, n));
    if (n === current) return;
    snapshot();
    store.patchTask(id, field === 'duration' ? { duration: n } : { progress: n });
    if (field === 'duration' && n === 0) toast('Zero days makes this a milestone');
  });
}

function editDate(id, cell, which) {
  const t = byId(id);
  openEditor(cell, which === 'start' ? t.start : t.finish, 'date', v => {
    if (!v) return;
    snapshot();
    if (which === 'start') {
      if (v === t.start) return;
      store.patchTask(id, { startOverride: v, start: v });
    } else {
      if (v === t.finish) return;
      const days = workdaysSpan(S.computed.calendar, t.start, v);
      store.patchTask(id, { duration: days });
    }
  });
}

function unpin(id) {
  const t = byId(id);
  if (!t.startOverride) { toast('This row already follows its dependencies'); return; }
  const hasPred = S.links.some(l => l.target === id);
  if (!hasPred) { toast('Nothing links into this row, so its date is all it has'); return; }
  snapshot();
  store.patchTask(id, { startOverride: null });
  toast('Date released, dependencies drive it now');
}

/* ==========================================================================
   Adding, deleting, indenting
   ========================================================================== */

function addPhase() {
  const sibs = siblingsOf(0);
  const id = store.newId();
  snapshot();
  store.createTask(id, {
    text: 'New phase',
    parent: 0,
    order: orderBetween(sibs.length ? sibs[sibs.length - 1].order : null, null),
    duration: 5,
    progress: 0,
    owner: '',
    open: true,
    color: PALETTE[sibs.length % PALETTE.length],
    start: S.meta.projectStart || todayISO(),
    startOverride: S.meta.projectStart || todayISO()
  });
  select(id);
}

function addChild(parentId) {
  const parent = byId(parentId);
  const sibs = siblingsOf(parentId);
  const id = store.newId();
  snapshot();
  const patch = {};
  patch[`tasks/${id}`] = {
    text: 'New task',
    parent: parentId,
    order: orderBetween(sibs.length ? sibs[sibs.length - 1].order : null, null),
    duration: 3,
    progress: 0,
    owner: '',
    open: true,
    start: parent.start,
    startOverride: sibs.length ? null : parent.start
  };
  /* make sure the new child is visible */
  if (parent.open === false) patch[`tasks/${parentId}/open`] = true;
  store.applyPatch(patch);
  select(id);
}

function deleteRow(id) {
  const t = byId(id);
  const kids = descendantsOf(id);
  if (kids.length) {
    if (!confirm(`Delete "${t.text}" and its ${kids.length} sub task${kids.length > 1 ? 's' : ''}?`)) return;
  } else if ((t.text || '').trim() && t.text !== 'New task' && t.text !== 'New phase') {
    if (!confirm(`Delete "${t.text}"?`)) return;
  }
  const ids = [id, ...kids];
  snapshot();
  store.removeTasks(ids, linksTouching(ids));
  if (S.sel === id) S.sel = null;
}

function removeLinkById(linkId, from, to) {
  if (!confirm(`Remove the dependency from "${from}" to "${to}"?`)) return;
  snapshot();
  store.removeLink(linkId);
}

function indent() {
  const id = S.sel;
  if (!id) return;
  const t = byId(id);
  const sibs = siblingsOf(t.parent || 0);
  const pos = sibs.findIndex(s => s.id === id);
  if (pos <= 0) { toast('Nothing above this row to nest it under'); return; }
  const newParent = sibs[pos - 1];
  const under = siblingsOf(newParent.id);
  snapshot();
  store.applyPatch({
    [`tasks/${id}/parent`]: newParent.id,
    [`tasks/${id}/order`]: orderBetween(under.length ? under[under.length - 1].order : null, null),
    [`tasks/${newParent.id}/open`]: true
  });
}

function outdent() {
  const id = S.sel;
  if (!id) return;
  const t = byId(id);
  if (!t.parent) { toast('Already at the top level'); return; }
  const parent = byId(t.parent);
  const uncles = siblingsOf(parent.parent || 0);
  const pos = uncles.findIndex(s => s.id === parent.id);
  snapshot();
  store.applyPatch({
    [`tasks/${id}/parent`]: parent.parent || 0,
    [`tasks/${id}/order`]: orderBetween(parent.order, uncles[pos + 1] ? uncles[pos + 1].order : null)
  });
}

/* ==========================================================================
   Dragging bars
   ========================================================================== */

function pxPerDay() { return ZOOM[S.zoom].px; }

function dragSession(onMove, onDone) {
  const move = e => onMove(e);
  const up = e => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.style.userSelect = '';
    onDone(e);
  };
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function startBarDrag(e, id) {
  if (e.button !== 0) return;
  if (e.target.classList.contains('grip') || e.target.classList.contains('knob')) return;
  e.preventDefault();
  e.stopPropagation();
  select(id);

  const bar = e.currentTarget;
  const t = byId(id);
  const startX = e.clientX;
  const baseLeft = parseFloat(bar.style.left);
  let deltaDays = 0;

  dragSession(ev => {
    deltaDays = Math.round((ev.clientX - startX) / pxPerDay());
    bar.style.left = (baseLeft + deltaDays * pxPerDay()) + 'px';
    bar.classList.add('ghost');
  }, () => {
    bar.classList.remove('ghost');
    if (!deltaDays) { render(); return; }
    const next = iso(addDays(parseISO(t.start), deltaDays));
    snapshot();
    store.patchTask(id, { startOverride: next, start: next });
  });
}

function startResize(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  select(id);

  const bar = e.currentTarget.parentElement;
  const t = byId(id);
  const startX = e.clientX;
  const baseW = parseFloat(bar.style.width);
  let deltaDays = 0;

  dragSession(ev => {
    deltaDays = Math.round((ev.clientX - startX) / pxPerDay());
    bar.style.width = Math.max(4, baseW + deltaDays * pxPerDay()) + 'px';
  }, () => {
    if (!deltaDays) { render(); return; }
    const newFinish = iso(addDays(parseISO(t.finish), deltaDays));
    if (newFinish < t.start) {
      snapshot();
      store.patchTask(id, { duration: 0 });
      toast('Zero days, this is now a milestone');
      return;
    }
    const days = workdaysSpan(S.computed.calendar, t.start, newFinish);
    snapshot();
    store.patchTask(id, { duration: days });
  });
}

/* Drag from a knob on one bar to another bar to create a dependency. Which
   ends you join decides the type, the same four combinations Project uses. */
function startLink(e, sourceId, side) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const canvas = el('tlCanvas');
  const from = S.geom.get(sourceId);
  const x0 = side === 'l' ? from.x1 : from.x2;
  const y0 = from.y;

  const svgns = 'http://www.w3.org/2000/svg';
  const rubber = document.createElementNS(svgns, 'svg');
  rubber.id = 'rubber';
  rubber.setAttribute('width', canvas.style.width);
  rubber.setAttribute('height', canvas.style.height);
  rubber.style.left = '0';
  rubber.style.top = '0';
  const line = document.createElementNS(svgns, 'path');
  rubber.appendChild(line);
  canvas.appendChild(rubber);

  let target = null, targetSide = 'l';

  dragSession(ev => {
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    line.setAttribute('d', `M${x0},${y0} L${px},${py}`);

    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const bar = over && over.closest && over.closest('.bar');
    document.querySelectorAll('.bar.linking').forEach(b => b.classList.remove('linking'));
    target = null;
    if (bar && bar.dataset.id !== sourceId) {
      const tt = byId(bar.dataset.id);
      if (tt && !tt.isSummary) {
        target = bar.dataset.id;
        bar.classList.add('linking');
        /* Dropping anywhere on the bar attaches to its start, which is what
           people almost always mean. Only the last few pixels of the far edge
           give a finish to finish link. */
        const br = bar.getBoundingClientRect();
        targetSide = ev.clientX >= br.right - 16 ? 'r' : 'l';
      }
    }
  }, () => {
    rubber.remove();
    document.querySelectorAll('.bar.linking').forEach(b => b.classList.remove('linking'));
    if (!target) { render(); return; }

    /* right to left is finish to start, and so on round the four corners */
    const type = side === 'r'
      ? (targetSide === 'l' ? '0' : '2')
      : (targetSide === 'l' ? '1' : '3');

    const exists = S.links.some(l => l.source === sourceId && l.target === target);
    if (exists) { toast('Those two are already linked'); render(); return; }
    if (createsCycle(sourceId, target)) {
      toast('That would make a circular dependency');
      render();
      return;
    }
    snapshot();
    store.createLink(store.newId(), { source: sourceId, target, type, lag: 0 });
  });
}

/* Adding source -> target closes a loop when target can already reach source
   through the links that exist now. */
function createsCycle(source, target) {
  if (source === target) return true;
  const adj = new Map();
  for (const l of S.links) {
    if (!adj.has(l.source)) adj.set(l.source, []);
    adj.get(l.source).push(l.target);
  }
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const node = stack.pop();
    if (node === source) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) || []) stack.push(next);
  }
  return false;
}

/* ==========================================================================
   Dragging rows to reorder
   ========================================================================== */

function startRowDrag(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  select(id);

  const body = el('gridBody');
  const banned = new Set([id, ...descendantsOf(id)]);
  let drop = null;

  const clear = () => document.querySelectorAll('#gridBody .row')
    .forEach(r => r.classList.remove('drop-above', 'drop-below', 'drop-into'));

  dragSession(ev => {
    clear();
    drop = null;
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = over && over.closest && over.closest('#gridBody .row');
    if (!row || banned.has(row.dataset.id)) return;

    const r = row.getBoundingClientRect();
    const frac = (ev.clientY - r.top) / r.height;
    const targetRow = S.rows[Number(row.dataset.index)];
    const t = targetRow.task;

    if (frac < 0.35) { drop = { mode: 'before', target: t }; row.classList.add('drop-above'); }
    else if (frac > 0.65) {
      if (targetRow.hasKids && t.open !== false) { drop = { mode: 'firstChild', target: t }; row.classList.add('drop-into'); }
      else { drop = { mode: 'after', target: t }; row.classList.add('drop-below'); }
    } else {
      drop = { mode: 'child', target: t };
      row.classList.add('drop-into');
    }
  }, () => {
    clear();
    if (!drop) return;
    applyRowMove(id, drop);
  });
}

function applyRowMove(id, drop) {
  const t = drop.target;
  let parent, order;

  if (drop.mode === 'child' || drop.mode === 'firstChild') {
    parent = t.id;
    const kids = siblingsOf(t.id);
    order = drop.mode === 'firstChild'
      ? orderBetween(null, kids.length ? kids[0].order : null)
      : orderBetween(kids.length ? kids[kids.length - 1].order : null, null);
  } else {
    parent = t.parent || 0;
    const sibs = siblingsOf(parent).filter(s => s.id !== id);
    const pos = sibs.findIndex(s => s.id === t.id);
    if (drop.mode === 'before') {
      order = orderBetween(pos > 0 ? sibs[pos - 1].order : null, t.order);
    } else {
      order = orderBetween(t.order, sibs[pos + 1] ? sibs[pos + 1].order : null);
    }
  }

  const current = byId(id);
  if ((current.parent || 0) === parent && current.order === order) return;
  snapshot();
  const patch = { [`tasks/${id}/parent`]: parent, [`tasks/${id}/order`]: order };
  if (drop.mode === 'child' || drop.mode === 'firstChild') patch[`tasks/${t.id}/open`] = true;
  store.applyPatch(patch);
}

/* ==========================================================================
   Column resizing and the split
   ========================================================================== */

function startColumnResize(e, index) {
  e.preventDefault();
  e.stopPropagation();
  const col = COLS[index];
  const startX = e.clientX;
  const startW = col.w;
  dragSession(ev => {
    col.w = Math.max(col.min, Math.round(startW + (ev.clientX - startX)));
    render();
  }, () => savePrefs());
}

function wireSplitter() {
  el('splitter').addEventListener('mousedown', e => {
    e.preventDefault();
    const name = COLS.find(c => c.key === 'name');
    const startX = e.clientX;
    const startW = name.w;
    dragSession(ev => {
      name.w = Math.max(name.min, Math.round(startW + (ev.clientX - startX)));
      render();
    }, () => savePrefs());
  });
}

/* ==========================================================================
   Scroll syncing
   ========================================================================== */

function wireScroll() {
  const tl = el('tlBody'), grid = el('gridBody'), head = el('tlHead');
  let lock = false;

  tl.addEventListener('scroll', () => {
    if (lock) return;
    lock = true;
    grid.scrollTop = tl.scrollTop;
    head.style.transform = `translateX(${-tl.scrollLeft}px)`;
    lock = false;
  });

  grid.addEventListener('wheel', e => {
    tl.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}

function scrollToToday() {
  const tl = el('tlBody');
  if (!S.range) return;
  const x = daysBetween(S.range.from, todayISO()) * pxPerDay();
  tl.scrollLeft = Math.max(0, x - tl.clientWidth / 3);
}

/* ==========================================================================
   Menus
   ========================================================================== */

function popMenu(anchorRect, build) {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const m = document.createElement('div');
  m.className = 'menu';
  build(m, () => m.remove());
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(window.innerWidth - w - 10, Math.max(8, anchorRect.left)) + 'px';
  m.style.top = Math.min(window.innerHeight - h - 10, anchorRect.bottom + 6) + 'px';
  setTimeout(() => {
    const close = ev => {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
  }, 0);
  return m;
}

function openPalette(e, id) {
  const t = byId(id);
  popMenu(e.target.getBoundingClientRect(), (m, close) => {
    const grid = document.createElement('div');
    grid.className = 'palette';
    for (const c of PALETTE) {
      const i = document.createElement('i');
      i.style.background = c;
      if ((t.color || '') === c) i.className = 'on';
      i.addEventListener('click', () => {
        snapshot();
        store.patchTask(id, { color: c });
        close();
      });
      grid.appendChild(i);
    }
    m.appendChild(grid);
  });
}

function wireChrome() {
  const title = el('title');
  title.addEventListener('change', () => {
    const v = title.value.trim() || 'Project Schedule';
    if (v !== S.meta.name) { snapshot(); store.patchMeta({ name: v }); }
  });

  el('zoom').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    S.zoom = b.dataset.z;
    [...el('zoom').children].forEach(c => c.classList.toggle('on', c === b));
    savePrefs();
    render();
    scrollToToday();
  });
  [...el('zoom').children].forEach(c => c.classList.toggle('on', c.dataset.z === S.zoom));

  el('btnToday').addEventListener('click', scrollToToday);
  el('btnExport').addEventListener('click', e => openExportMenu(e.currentTarget.getBoundingClientRect()));
  el('btnAccount').addEventListener('click', e => openAccountMenu(e.currentTarget.getBoundingClientRect()));

  wireSplitter();
  wireScroll();

  document.addEventListener('keydown', e => {
    if (activeEditor) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Tab' && S.sel) { e.preventDefault(); e.shiftKey ? outdent() : indent(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteRow(S.sel); return; }

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && S.rows.length) {
      e.preventDefault();
      const i = S.rows.findIndex(r => r.task.id === S.sel);
      const next = e.key === 'ArrowDown' ? Math.min(S.rows.length - 1, i + 1) : Math.max(0, i - 1);
      select(S.rows[next].task.id);
    }
  });

  window.addEventListener('resize', () => { if (S.computed) render(); });
  setTimeout(scrollToToday, 250);
}

function openAccountMenu(rect) {
  const u = store.user();
  popMenu(rect, (m, close) => {
    const who = document.createElement('div');
    who.style.cssText = 'padding:8px 10px;color:#6b7684;font-size:12px;';
    who.textContent = u ? (u.email || u.displayName) : '';
    m.appendChild(who);
    m.appendChild(document.createElement('hr'));

    const holidays = document.createElement('button');
    holidays.textContent = 'Non working days';
    holidays.addEventListener('click', () => { close(); editHolidays(); });
    m.appendChild(holidays);

    const startBtn = document.createElement('button');
    startBtn.textContent = 'Project start date';
    startBtn.addEventListener('click', () => { close(); editProjectStart(); });
    m.appendChild(startBtn);

    m.appendChild(document.createElement('hr'));
    const out = document.createElement('button');
    out.textContent = 'Sign out';
    out.addEventListener('click', () => { close(); store.leave(); });
    m.appendChild(out);
  });
}

function editProjectStart() {
  const current = S.meta.projectStart || todayISO();
  const v = prompt('Project start date (YYYY-MM-DD). Rows with no date of their own begin here.', current);
  if (!v) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { toast('Use the format YYYY-MM-DD'); return; }
  snapshot();
  store.patchMeta({ projectStart: v.trim() });
}

function editHolidays() {
  const current = Object.keys(S.meta.holidays || {}).sort().join('\n');
  const v = prompt(
    'Non working days, one per line as YYYY-MM-DD. Weekends are already skipped.',
    current);
  if (v === null) return;
  const map = {};
  for (const line of v.split(/\s+/)) {
    const s = line.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) map[s] = true;
  }
  snapshot();
  store.patchMeta({ holidays: Object.keys(map).length ? map : null });
}

/* ==========================================================================
   Export
   ========================================================================== */

function openExportMenu(rect) {
  popMenu(rect, (m, close) => {
    const item = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { close(); fn(); });
      m.appendChild(b);
    };
    item('Chart as PNG', exportPNG);
    item('Chart as SVG', exportSVG);
    m.appendChild(document.createElement('hr'));
    item('Table as CSV', exportCSV);
  });
}

function slug() {
  return (S.meta.name || 'schedule').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schedule';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}

function esc(v) {
  return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* A standalone chart, laid out for printing rather than for the screen.
   No labels on the bars, matching what you see in the app. */
function buildSVG() {
  const c = S.computed;
  const codes = outlineCodes();
  const rows = flatten(c.tasks);              // every row, including collapsed ones
  const LEFT = 320, ROW = 22, HEAD = 46, PAD = 22, TITLE = 50;

  let from = c.start, to = c.end;
  for (const t of c.tasks) { if (t.start < from) from = t.start; if (t.finish > to) to = t.finish; }
  const startD = addDays(parseISO(from), -3);
  const endD = addDays(parseISO(to), 8);
  const totalDays = Math.max(1, Math.round((endD - startD) / 86400000));
  const px = Math.max(2, Math.min(20, 1120 / totalDays));
  const chartW = totalDays * px;
  const W = LEFT + chartW + PAD * 2;
  const H = TITLE + HEAD + rows.length * ROW + PAD * 2 + 20;

  const x = d => PAD + LEFT + Math.round(((parseISO(d) - startD) / 86400000) * px);
  const top = PAD + TITLE + HEAD;
  const bottom = top + rows.length * ROW;

  const s = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(W)} ${Math.round(H)}" font-family="Helvetica, Arial, sans-serif">`);
  s.push('<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#8b95a3"/></marker></defs>');
  s.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  s.push(`<text x="${PAD}" y="${PAD + 19}" font-size="16" font-weight="700" fill="#16202c">${esc(S.meta.name || 'Project Schedule')}</text>`);
  s.push(`<text x="${PAD}" y="${PAD + 36}" font-size="10.5" fill="#6b7684">${esc(`${fmtDate(c.start)} to ${fmtDate(c.end)}  ·  ${c.workdays} working days  ·  ${rows.length} rows  ·  exported ${fmtDate(todayISO())}`)}</text>`);

  rows.forEach((r, i) => {
    if (i % 2) s.push(`<rect x="${PAD}" y="${top + i * ROW}" width="${LEFT + chartW}" height="${ROW}" fill="#fafbfc"/>`);
  });

  for (let d = new Date(startD.getTime()); d < endD; d = addDays(d, 1)) {
    const dow = d.getUTCDay();
    if (px >= 5 && (dow === 0 || dow === 6 || (S.meta.holidays || {})[iso(d)])) {
      s.push(`<rect x="${x(iso(d))}" y="${top}" width="${Math.ceil(px)}" height="${bottom - top}" fill="#f2f4f7"/>`);
    }
  }

  let m = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), 1));
  while (m < endD) {
    const nxt = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const a = x(iso(m < startD ? startD : m));
    const b = x(iso(nxt > endD ? endD : nxt));
    s.push(`<line x1="${a}" y1="${top - 24}" x2="${a}" y2="${bottom}" stroke="#e3e7ec"/>`);
    if (b - a > 32) {
      s.push(`<text x="${a + 5}" y="${top - 10}" font-size="10.5" font-weight="600" fill="#4b5663">${esc(b - a > 74 ? MONTHS[m.getUTCMonth()] + ' ' + m.getUTCFullYear() : MONTHS[m.getUTCMonth()].slice(0, 3))}</text>`);
    }
    m = nxt;
  }
  s.push(`<line x1="${PAD + LEFT}" y1="${top - 1}" x2="${PAD + LEFT + chartW}" y2="${top - 1}" stroke="#c8ced7"/>`);

  const t0 = todayISO();
  if (parseISO(t0) >= startD && parseISO(t0) <= endD) {
    s.push(`<line x1="${x(t0)}" y1="${top - 6}" x2="${x(t0)}" y2="${bottom}" stroke="#e0574f" stroke-width="1.2" stroke-dasharray="3 3"/>`);
  }

  const pos = new Map();
  rows.forEach((r, i) => {
    const t = r.task;
    const y = top + i * ROW, cy = y + ROW / 2;
    const indent = r.depth * 12;
    const code = codes.get(t.id) || '';
    let label = t.text || '';
    const room = Math.floor((LEFT - 30 - indent - code.length * 5.5) / 5.4);
    if (label.length > room) label = label.slice(0, Math.max(3, room - 1)) + '…';
    s.push(`<text x="${PAD + 4 + indent}" y="${cy + 3.5}" font-size="10.5" fill="#16202c"${t.isSummary ? ' font-weight="700"' : ''}><tspan fill="#97a1ad">${esc(code)}</tspan> ${esc(label)}</text>`);

    const x1 = x(t.start);
    const x2 = t.isMilestone ? x1 : x(iso(addDays(parseISO(t.finish), 1)));
    const w = Math.max(3, x2 - x1);

    if (t.isMilestone) {
      s.push(`<path d="M${x1},${cy - 6} L${x1 + 6},${cy} L${x1},${cy + 6} L${x1 - 6},${cy} Z" fill="#16202c"/>`);
      pos.set(t.id, { x1: x1 - 6, x2: x1 + 6, cy });
    } else if (t.isSummary) {
      s.push(`<rect x="${x1}" y="${cy - 4}" width="${w}" height="8" fill="#1f3a5f"/>`);
      if (t.pct > 0) s.push(`<rect x="${x1}" y="${cy - 1.5}" width="${w * t.pct / 100}" height="3" fill="rgba(255,255,255,0.55)"/>`);
      s.push(`<path d="M${x1},${cy + 4} l0,5 l5,-5 z" fill="#1f3a5f"/>`);
      s.push(`<path d="M${x1 + w},${cy + 4} l0,5 l-5,-5 z" fill="#1f3a5f"/>`);
      pos.set(t.id, { x1, x2: x1 + w, cy });
    } else {
      const colour = t.colour || PALETTE[0];
      s.push(`<rect x="${x1}" y="${cy - 7}" width="${w}" height="14" rx="2.5" fill="${colour}"/>`);
      if (t.pct > 0) s.push(`<rect x="${x1}" y="${cy - 2.5}" width="${w * t.pct / 100}" height="5" fill="rgba(0,0,0,0.5)"/>`);
      pos.set(t.id, { x1, x2: x1 + w, cy });
    }
  });

  for (const l of c.links) {
    const a = pos.get(l.source), b = pos.get(l.target);
    if (!a || !b) continue;
    const type = String(l.type);
    const sx = (type === '1' || type === '3') ? a.x1 : a.x2;
    const tx = (type === '2' || type === '3') ? b.x2 : b.x1;
    let d;
    if (tx >= sx + 12) d = `M${sx},${a.cy} H${sx + 7} V${b.cy} H${tx - 6}`;
    else {
      const mid = b.cy > a.cy ? a.cy + ROW / 2 : a.cy - ROW / 2;
      d = `M${sx},${a.cy} H${sx + 7} V${mid} H${tx - 14} V${b.cy} H${tx - 6}`;
    }
    s.push(`<path d="${d}" fill="none" stroke="#8b95a3" stroke-width="1.1" marker-end="url(#ah)"/>`);
  }

  s.push('</svg>');
  return s.join('');
}

function exportSVG() {
  download(new Blob([buildSVG()], { type: 'image/svg+xml;charset=utf-8' }), slug() + '.svg');
}

function exportPNG() {
  const svg = buildSVG();
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob(b => download(b, slug() + '.png'), 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('PNG export failed, the SVG works everywhere'); };
  img.src = url;
}

function exportCSV() {
  const c = S.computed;
  const codes = outlineCodes();
  const incoming = new Map();
  for (const l of c.links) {
    if (!incoming.has(l.target)) incoming.set(l.target, []);
    incoming.get(l.target).push(l);
  }
  const nameOf = id => byId(id)?.text || '';
  const head = ['Outline', 'Task Name', 'Responsible', 'Days', 'Start', 'Finish', '% Done', 'Depends on'];
  const rows = flatten(c.tasks).map(r => {
    const t = r.task;
    return [
      codes.get(t.id) || '', t.text || '', t.owner || '',
      t.isMilestone ? 0 : t.duration, t.start, t.finish, t.pct,
      (incoming.get(t.id) || []).map(l => nameOf(l.source)).join('; ')
    ];
  });
  const csv = [head, ...rows].map(r => r.map(v => {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\r\n');
  download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), slug() + '.csv');
}

/* ==========================================================================
   First run content
   ========================================================================== */

function starterSchedule() {
  const start = todayISO();
  const T = {}, L = {};
  const id = n => 'seed' + n;

  const add = (n, text, parent, order, extra = {}) => {
    T[id(n)] = {
      text, parent: parent ? id(parent) : 0, order,
      duration: 5, progress: 0, owner: '', open: true, ...extra
    };
  };

  add(1, 'Project Management', 0, 1, { color: PALETTE[0], duration: 1 });
  add(2, 'Scheduling', 1, 1, { duration: 8, progress: 50, start, startOverride: start });
  add(3, 'Purchasing', 1, 2, { duration: 4, progress: 100 });
  add(4, 'Sponsor Coordination', 1, 3, { duration: 10 });

  add(5, 'Systems Engineering', 0, 2, { color: PALETTE[1], duration: 1 });
  add(6, 'Requirements', 5, 1, { duration: 7, progress: 100, start, startOverride: start });
  add(7, 'CONOPS', 5, 2, { duration: 12 });
  add(8, 'Interface Control', 5, 3, { duration: 10 });

  add(9, 'Mechanical', 0, 3, { color: PALETTE[2], duration: 1 });
  add(10, 'Structure design', 9, 1, { duration: 15 });
  add(11, 'Thermal analysis', 9, 2, { duration: 10 });
  add(12, 'Fabrication', 9, 3, { duration: 18 });

  add(13, 'Integration and Test', 0, 4, { color: PALETTE[3], duration: 1 });
  add(14, 'Subsystem integration', 13, 1, { duration: 12 });
  add(15, 'Environmental testing', 13, 2, { duration: 10 });
  add(16, 'Delivery', 13, 3, { duration: 0 });

  const link = (n, a, b, type = '0') => { L['seedl' + n] = { source: id(a), target: id(b), type, lag: 0 }; };
  link(1, 2, 3);
  link(2, 6, 7);
  link(3, 7, 8);
  link(4, 8, 10);
  link(5, 10, 11, '1');
  link(6, 10, 12);
  link(7, 11, 12);
  link(8, 12, 14);
  link(9, 14, 15);
  link(10, 15, 16);

  return {
    meta: { name: 'IDC Aerospace Imagery CubeSat', projectStart: start },
    tasks: T,
    links: L
  };
}
