/* Scheduling engine.
   Dates are never stored. They are computed from durations, dependencies and
   any manual overrides, so every browser showing the same data shows the same
   chart. All arithmetic runs on an index into a list of working days, which
   makes weekend and holiday handling fall out for free. */

export const FS = '0', SS = '1', FF = '2', SF = '3';

export function iso(d) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

export function parseISO(s) {
  const p = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

export function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

export function todayISO() {
  const n = new Date();
  return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())));
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export function buildCalendar(anchorISO, holidays = [], back = 500, forward = 3000) {
  const holiday = new Set(holidays);
  const days = [];
  const index = new Map();
  let cur = addDays(parseISO(anchorISO), -back);
  for (let i = 0; i <= back + forward; i++) {
    const s = iso(cur);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holiday.has(s)) {
      index.set(s, days.length);
      days.push(s);
    }
    cur = addDays(cur, 1);
  }
  return {
    days,
    length: days.length,
    isWorking(dateISO) { return index.has(dateISO); },
    /* index of a date, snapping forward off weekends and holidays */
    idx(dateISO) {
      let d = parseISO(dateISO);
      for (let i = 0; i < 40; i++) {
        const hit = index.get(iso(d));
        if (hit !== undefined) return hit;
        d = addDays(d, 1);
      }
      return 0;
    },
    date(i) {
      return days[Math.max(0, Math.min(days.length - 1, i))];
    }
  };
}

/* Tasks arrive as a flat list carrying parent and order. Turn that into
   display order, depth-first, with a depth on each row. */
export function flatten(tasks) {
  const kids = new Map();
  for (const t of tasks) {
    const p = t.parent || 0;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const out = [];
  const walk = (parent, depth, visibleChain) => {
    for (const t of kids.get(parent) || []) {
      const hasKids = (kids.get(t.id) || []).length > 0;
      out.push({ task: t, depth, hasKids, visible: visibleChain });
      walk(t.id, depth + 1, visibleChain && (t.open !== false));
    }
  };
  walk(0, 0, true);
  return out;
}

export function childrenOf(tasks) {
  const kids = new Map();
  for (const t of tasks) {
    const p = t.parent || 0;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t.id);
  }
  return kids;
}

/* The core. Returns a new array of task objects with computed fields:
   s (start index), e (exclusive end index), start, finish, isSummary,
   pct (0-100), colour, plus a warnings list. */
export function schedule(model) {
  const warnings = [];
  const tasks = model.tasks.map(t => ({ ...t }));
  const links = (model.links || []).filter(Boolean);
  const projectStart = model.projectStart || todayISO();
  const cal = buildCalendar(projectStart, model.holidays || []);
  const P0 = cal.idx(projectStart);

  const byId = new Map(tasks.map(t => [t.id, t]));
  const kids = childrenOf(tasks);
  const isSummary = t => (kids.get(t.id) || []).length > 0;

  const leaves = tasks.filter(t => !isSummary(t));
  const leafIds = new Set(leaves.map(t => t.id));

  const dur = t => {
    const d = Number(t.duration);
    if (!isFinite(d) || d < 0) return 1;
    return Math.round(d);
  };

  /* validate links */
  const good = [];
  for (const l of links) {
    if (!byId.has(l.source) || !byId.has(l.target)) continue;
    if (l.source === l.target) continue;
    if (!leafIds.has(l.source) || !leafIds.has(l.target)) {
      warnings.push(
        `"${byId.get(l.source).text}" to "${byId.get(l.target).text}": links on rows ` +
        `that have sub tasks are not scheduled. Link the sub tasks instead.`);
      continue;
    }
    good.push(l);
  }

  /* topological order */
  const preds = new Map(), succs = new Map(), indeg = new Map();
  for (const t of leaves) { preds.set(t.id, []); succs.set(t.id, []); indeg.set(t.id, 0); }
  for (const l of good) {
    preds.get(l.target).push(l);
    succs.get(l.source).push(l);
    indeg.set(l.target, indeg.get(l.target) + 1);
  }

  const queue = leaves.filter(t => indeg.get(t.id) === 0).map(t => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const l of succs.get(id)) {
      indeg.set(l.target, indeg.get(l.target) - 1);
      if (indeg.get(l.target) === 0) queue.push(l.target);
    }
  }

  const cycle = new Set();
  if (order.length !== leaves.length) {
    const seen = new Set(order);
    for (const t of leaves) if (!seen.has(t.id)) { cycle.add(t.id); order.push(t.id); }
    warnings.push(
      'Circular dependency between: ' +
      [...cycle].map(i => `"${byId.get(i).text}"`).join(', ') +
      '. Delete one of those links to fix it.');
  }

  /* forward pass */
  const S = new Map(), E = new Map();
  for (const id of order) {
    const t = byId.get(id);
    const D = dur(t);
    let s;

    /* A date set by hand is honoured exactly, even if that overlaps whatever
       comes before it. Dragging a bar has to put the bar where you dropped it,
       otherwise the drag looks broken. Successors still follow along. */
    if (t.startOverride) {
      s = cal.idx(t.startOverride);
      S.set(id, s);
      E.set(id, s + D);
      continue;
    }

    if (preds.get(id).length) s = -Infinity;
    else s = cal.idx(t.start || projectStart);

    if (!cycle.has(id)) {
      for (const l of preds.get(id)) {
        const ps = S.get(l.source), pe = E.get(l.source);
        if (ps === undefined) continue;
        const lag = Number(l.lag) || 0;
        let need;
        switch (String(l.type)) {
          case SS: need = ps + lag; break;
          case FF: need = pe + lag - D; break;
          case SF: need = ps + lag - D; break;
          default: need = pe + lag;
        }
        if (need > s) s = need;
      }
    }

    if (!isFinite(s)) s = P0;
    if (s < 0) s = 0;
    S.set(id, s);
    E.set(id, s + D);
  }

  for (const t of leaves) {
    const D = dur(t);
    t.s = S.get(t.id);
    t.e = E.get(t.id);
    t.duration = D;
    t.isSummary = false;
    t.isMilestone = D === 0;
    t.start = cal.date(t.s);
    /* the finish users expect is the last working day, not the exclusive end */
    t.finish = cal.date(D === 0 ? t.s : t.e - 1);
    t.pct = clampPct(t.progress);
    t.pinned = !!t.startOverride;
  }

  /* roll summaries up from the deepest level outwards */
  const depthOf = t => {
    let d = 0, cur = t;
    while (cur && cur.parent && byId.has(cur.parent) && d < 60) { d++; cur = byId.get(cur.parent); }
    return d;
  };
  const summaries = tasks.filter(isSummary).sort((a, b) => depthOf(b) - depthOf(a));
  for (const t of summaries) {
    const ch = kids.get(t.id).map(i => byId.get(i));
    t.s = Math.min(...ch.map(c => c.s));
    t.e = Math.max(...ch.map(c => c.e));
    t.duration = t.e - t.s;
    t.isSummary = true;
    t.isMilestone = false;
    t.start = cal.date(t.s);
    t.finish = cal.date(Math.max(t.s, t.e - 1));
    /* percent complete weighted by task length, so a 20 day task counts for
       more than a 2 day one */
    const total = ch.reduce((a, c) => a + Math.max(c.duration, 0), 0);
    t.pct = total
      ? Math.round(ch.reduce((a, c) => a + Math.max(c.duration, 0) * c.pct, 0) / total)
      : Math.round(ch.reduce((a, c) => a + c.pct, 0) / (ch.length || 1));
    t.pinned = false;
  }

  /* colour: a top level row owns a colour, everything under it inherits */
  for (const row of flatten(tasks)) {
    const t = row.task;
    if (row.depth === 0) t.colour = t.color || null;
    else t.colour = byId.get(t.parent)?.colour || null;
  }

  const projectEnd = tasks.length ? Math.max(...tasks.map(t => t.e)) : P0;

  return {
    tasks, links: good, warnings, calendar: cal,
    start: cal.date(P0),
    end: cal.date(Math.max(P0, projectEnd - 1)),
    workdays: projectEnd - P0
  };
}

function clampPct(v) {
  const n = Math.round(Number(v) || 0);
  return Math.max(0, Math.min(100, n));
}

/* Nearest working day in a given direction. The drag handlers use this so the
   bar you are dragging sits where it will actually land. */
export function snapWorking(cal, dateISO, dir = 1) {
  let d = parseISO(dateISO);
  for (let i = 0; i < 21; i++) {
    if (cal.isWorking(iso(d))) return iso(d);
    d = addDays(d, dir);
  }
  return dateISO;
}

/* Number of working days from one date to another, used when someone edits
   the Finish column directly. */
export function workdaysSpan(cal, startISO, finishISO) {
  const a = cal.idx(startISO);
  let d = parseISO(finishISO);
  /* snap the finish backwards onto a working day */
  for (let i = 0; i < 40; i++) {
    if (cal.isWorking(iso(d))) break;
    d = addDays(d, -1);
  }
  const b = cal.idx(iso(d));
  return Math.max(1, b - a + 1);
}
