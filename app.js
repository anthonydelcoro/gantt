/* =============================================================================
   Collaborative Gantt — a small MS Project stand-in that lives in a Git repo.

   Three parts:
     1. SCHEDULER  — working-day calendar + CPM forward/backward pass.
                     (DHTMLX's MIT build draws dependencies but does not
                     schedule from them, so we do that ourselves.)
     2. STORE      — loads/saves schedule.json through the GitHub Contents API,
                     using the file SHA for safe concurrent writes.
     3. UI         — DHTMLX Gantt wiring, plus SVG/PNG/CSV export.
   ============================================================================= */
(function () {
  'use strict';

  /* ===========================================================================
     1. SCHEDULER
     ======================================================================== */

  var LINK = { FS: '0', SS: '1', FF: '2', SF: '3' };
  var TYPE_NAME = { '0': 'FS', '1': 'SS', '2': 'FF', '3': 'SF' };
  var NAME_TYPE = { FS: '0', SS: '1', FF: '2', SF: '3' };

  function iso(d) {
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function parseISO(s) {
    var p = String(s).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function addDays(d, n) {
    var r = new Date(d.getTime());
    r.setUTCDate(r.getUTCDate() + n);
    return r;
  }
  function todayISO() {
    var n = new Date();
    return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())));
  }

  function buildCalendar(anchorISO, opts) {
    opts = opts || {};
    var workdays = opts.workdays || [1, 2, 3, 4, 5];
    var holidays = new Set(opts.holidays || []);
    var back = opts.back == null ? 400 : opts.back;
    var fwd = opts.forward == null ? 2600 : opts.forward;

    var days = [], index = Object.create(null);
    var cur = addDays(parseISO(anchorISO), -back);
    for (var i = 0; i <= back + fwd; i++) {
      var s = iso(cur);
      if (workdays.indexOf(cur.getUTCDay()) !== -1 && !holidays.has(s)) {
        index[s] = days.length;
        days.push(s);
      }
      cur = addDays(cur, 1);
    }
    return {
      days: days,
      isWorkday: function (dateISO) { return index[dateISO] !== undefined; },
      idx: function (dateISO) {
        var d = parseISO(dateISO);
        for (var i = 0; i < 30; i++) {
          var s = iso(d);
          if (index[s] !== undefined) return index[s];
          d = addDays(d, 1);
        }
        return 0;
      },
      date: function (i) {
        if (i < 0) i = 0;
        if (i >= days.length) i = days.length - 1;
        return days[i];
      }
    };
  }

  function childrenMap(tasks) {
    var kids = Object.create(null);
    tasks.forEach(function (t) {
      var p = t.parent || 0;
      (kids[p] = kids[p] || []).push(t.id);
    });
    return kids;
  }
  function hasKids(task, kids) { return !!(kids[task.id] && kids[task.id].length); }

  function schedule(model) {
    var tasks = model.tasks.map(function (t) { return Object.assign({}, t); });
    var links = (model.links || []).filter(Boolean);
    var warnings = [];

    var projectStart = model.project_start || todayISO();
    var cal = buildCalendar(projectStart, {
      workdays: model.workdays, holidays: model.holidays
    });
    var P0 = cal.idx(projectStart);

    var byId = Object.create(null);
    tasks.forEach(function (t) { byId[t.id] = t; });
    var kids = childrenMap(tasks);

    var leaves = tasks.filter(function (t) { return !hasKids(t, kids); });
    var leafIds = new Set(leaves.map(function (t) { return t.id; }));

    function dur(t) {
      if (t.type === 'milestone') return 0;
      var d = Number(t.duration);
      return isFinite(d) && d > 0 ? Math.round(d) : 1;
    }

    var good = [];
    links.forEach(function (l) {
      if (!byId[l.source] || !byId[l.target]) {
        warnings.push('A dependency points at a row that no longer exists — ignored.');
        return;
      }
      if (l.source === l.target) { return; }
      if (!leafIds.has(l.source) || !leafIds.has(l.target)) {
        warnings.push('“' + byId[l.source].text + '” → “' + byId[l.target].text +
          '”: dependencies on summary rows are not scheduled. Link the child tasks instead.');
        return;
      }
      good.push(l);
    });

    var preds = Object.create(null), succs = Object.create(null), indeg = Object.create(null);
    leaves.forEach(function (t) { indeg[t.id] = 0; preds[t.id] = []; succs[t.id] = []; });
    good.forEach(function (l) {
      preds[l.target].push(l);
      succs[l.source].push(l);
      indeg[l.target]++;
    });

    var queue = leaves.filter(function (t) { return indeg[t.id] === 0; })
      .map(function (t) { return t.id; });
    var order = [];
    while (queue.length) {
      var id = queue.shift();
      order.push(id);
      succs[id].forEach(function (l) { if (--indeg[l.target] === 0) queue.push(l.target); });
    }

    var inCycle = [];
    if (order.length !== leaves.length) {
      var seen = new Set(order);
      leaves.forEach(function (t) {
        if (!seen.has(t.id)) { inCycle.push(t.id); order.push(t.id); }
      });
      warnings.push('Circular dependency involving: ' +
        inCycle.map(function (i) { return '“' + byId[i].text + '”'; }).join(', ') +
        '. Those rows were left at their own dates — remove one of the links to fix it.');
    }
    var cycleSet = new Set(inCycle);

    /* forward pass */
    var ES = Object.create(null), EF = Object.create(null);
    order.forEach(function (id) {
      var t = byId[id], D = dur(t), es;

      if (t.constraint_date) es = cal.idx(t.constraint_date);
      else if (preds[id].length) es = -Infinity;
      else es = cal.idx(t.start_date || projectStart);

      if (!cycleSet.has(id)) {
        preds[id].forEach(function (l) {
          var pES = ES[l.source], pEF = EF[l.source];
          if (pES === undefined) return;
          var lag = Number(l.lag) || 0, need;
          switch (String(l.type)) {
            case LINK.SS: need = pES + lag; break;
            case LINK.FF: need = pEF + lag - D; break;
            case LINK.SF: need = pES + lag - D; break;
            default: need = pEF + lag;
          }
          if (need > es) es = need;
        });
      }
      if (!isFinite(es)) es = P0;
      if (es < 0) es = 0;
      ES[id] = es;
      EF[id] = es + D;
    });

    /* backward pass -> total float */
    var projectEnd = order.length
      ? Math.max.apply(null, order.map(function (i) { return EF[i]; })) : P0;
    var LF = Object.create(null);
    for (var i = order.length - 1; i >= 0; i--) {
      var tid = order[i], td = dur(byId[tid]);
      var lf = succs[tid].length ? Infinity : projectEnd;
      succs[tid].forEach(function (l) {
        var sLF = LF[l.target];
        if (sLF === undefined) return;
        var sD = dur(byId[l.target]), sLS = sLF - sD, lag = Number(l.lag) || 0, allowed;
        switch (String(l.type)) {
          case LINK.SS: allowed = sLS - lag + td; break;
          case LINK.FF: allowed = sLF - lag; break;
          case LINK.SF: allowed = sLF - lag + td; break;
          default: allowed = sLS - lag;
        }
        if (allowed < lf) lf = allowed;
      });
      if (!isFinite(lf)) lf = projectEnd;
      LF[tid] = lf;
    }

    leaves.forEach(function (t) {
      t._es = ES[t.id]; t._ef = EF[t.id];
      t._float = LF[t.id] - EF[t.id];
      t._critical = t._float <= 0;
      t._cycle = cycleSet.has(t.id);
      t.start_date = cal.date(ES[t.id]);
      t.end_date = cal.date(EF[t.id]);
      t.duration = dur(t);
      t._summary = false;
    });

    function depth(t) {
      var d = 0, cur = t;
      while (cur && cur.parent && byId[cur.parent] && d < 50) { d++; cur = byId[cur.parent]; }
      return d;
    }
    tasks.filter(function (t) { return hasKids(t, kids); })
      .sort(function (a, b) { return depth(b) - depth(a); })
      .forEach(function (t) {
        var ch = kids[t.id].map(function (i) { return byId[i]; });
        var es = Math.min.apply(null, ch.map(function (c) { return c._es; }));
        var ef = Math.max.apply(null, ch.map(function (c) { return c._ef; }));
        t._es = es; t._ef = ef;
        t._float = null;
        t._critical = ch.some(function (c) { return c._critical; });
        t.start_date = cal.date(es);
        t.end_date = cal.date(ef);
        t.duration = ef - es;
        t.type = 'project';
        t._summary = true;
      });

    return {
      tasks: tasks, links: good, warnings: warnings, calendar: cal,
      projectStart: cal.date(P0), projectEnd: cal.date(projectEnd),
      totalWorkdays: projectEnd - P0
    };
  }

  function parsePredecessors(str) {
    var out = [];
    if (!str) return out;
    String(str).split(/[,;]/).forEach(function (chunk) {
      var m = chunk.trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?\s*d?$/i);
      if (!m) return;
      out.push({
        source: Number(m[1]),
        type: NAME_TYPE[(m[2] || 'FS').toUpperCase()],
        lag: m[3] ? Number(m[3].replace(/\s+/g, '')) : 0
      });
    });
    return out;
  }
  function formatPredecessors(links) {
    return links.map(function (l) {
      var t = TYPE_NAME[String(l.type)] || 'FS', lag = Number(l.lag) || 0;
      return l.source + (t === 'FS' && !lag ? '' : t) +
        (lag ? (lag > 0 ? '+' : '') + lag + 'd' : '');
    }).join(', ');
  }

  /* ===========================================================================
     2. STORE — GitHub Contents API
     ======================================================================== */

  var LS = {
    cfg: 'gantt.repo.config',
    token: 'gantt.repo.token'
  };

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function detectRepo() {
    var host = location.hostname, parts = location.pathname.split('/').filter(Boolean);
    var owner = '', repo = '';
    if (/\.github\.io$/i.test(host)) {
      owner = host.replace(/\.github\.io$/i, '');
      repo = parts.length ? parts[0] : host;
      if (/\.html?$/i.test(repo)) repo = host;
    }
    return { owner: owner, repo: repo, branch: 'main', path: 'schedule.json' };
  }

  var Store = {
    cfg: null,
    sha: null,

    init: function () {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(LS.cfg) || 'null'); } catch (e) { }
      this.cfg = Object.assign(detectRepo(), saved || {});
      return this.cfg;
    },
    saveCfg: function (cfg) {
      this.cfg = Object.assign({}, this.cfg, cfg);
      try { localStorage.setItem(LS.cfg, JSON.stringify(this.cfg)); } catch (e) { }
    },
    token: function () {
      try { return localStorage.getItem(LS.token) || ''; } catch (e) { return ''; }
    },
    setToken: function (t) {
      try { t ? localStorage.setItem(LS.token, t) : localStorage.removeItem(LS.token); }
      catch (e) { }
    },
    canWrite: function () {
      return !!(this.token() && this.cfg.owner && this.cfg.repo);
    },
    apiURL: function () {
      var c = this.cfg;
      return 'https://api.github.com/repos/' + encodeURIComponent(c.owner) + '/' +
        encodeURIComponent(c.repo) + '/contents/' +
        c.path.split('/').map(encodeURIComponent).join('/');
    },
    headers: function () {
      var h = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      var t = this.token();
      if (t) h['Authorization'] = 'Bearer ' + t;
      return h;
    },

    /* Read. With a token we go through the API so we also get the SHA, which is
       what makes safe concurrent writes possible. Without one we just pull the
       file off the Pages site — no rate limit, no auth, read-only. */
    load: function () {
      var self = this;
      if (this.token() && this.cfg.owner && this.cfg.repo) {
        return fetch(this.apiURL() + '?ref=' + encodeURIComponent(this.cfg.branch),
          { headers: this.headers(), cache: 'no-store' })
          .then(function (r) {
            if (r.status === 404) return { missing: true };
            if (r.status === 401 || r.status === 403) {
              return r.json().catch(function () { return {}; }).then(function (j) {
                throw new Error('GitHub rejected the token (' + r.status + '). ' +
                  (j.message || '') + ' Check that it has Contents: Read and write on this repo.');
              });
            }
            if (!r.ok) throw new Error('GitHub returned ' + r.status);
            return r.json();
          })
          .then(function (j) {
            if (j.missing) { self.sha = null; return null; }
            self.sha = j.sha;
            return JSON.parse(b64decode(j.content));
          });
      }
      var url = (this.cfg.path || 'schedule.json') + '?t=' + Date.now();
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('Could not read ' + self.cfg.path + ' (' + r.status + ')');
        return r.json();
      });
    },

    /* Poll for someone else's commit. Returns the new SHA, or null. */
    remoteSha: function () {
      if (!this.token()) return Promise.resolve(null);
      return fetch(this.apiURL() + '?ref=' + encodeURIComponent(this.cfg.branch),
        { headers: this.headers(), cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return j ? j.sha : null; })
        .catch(function () { return null; });
    },

    save: function (model, message) {
      var self = this;
      var body = {
        message: message || 'Update schedule',
        content: b64encode(JSON.stringify(model, null, 2) + '\n'),
        branch: this.cfg.branch
      };
      if (this.sha) body.sha = this.sha;

      return fetch(this.apiURL(), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers()),
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.status === 409 || r.status === 422) {
          var err = new Error('conflict');
          err.conflict = true;
          throw err;
        }
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error('Save failed (' + r.status + '). ' + (j.message || ''));
          });
        }
        return r.json();
      }).then(function (j) {
        self.sha = j.content.sha;
        return j;
      });
    }
  };

  /* ===========================================================================
     3. UI
     ======================================================================== */

  var $ = function (id) { return document.getElementById(id); };
  var gantt = window.gantt;

  var State = {
    model: null,
    computed: null,
    dirty: false,
    readonly: true,
    applying: false,
    showCritical: false,
    undo: [],
    lastSaved: null,
    renderedPreds: Object.create(null)
  };

  function starterModel() {
    var start = todayISO();
    return {
      project: 'New Project',
      project_start: start,
      holidays: [],
      tasks: [
        { id: 1, text: 'Planning', parent: 0, duration: 1 },
        { id: 2, text: 'Define scope', parent: 1, duration: 3, progress: 0, constraint_date: start },
        { id: 3, text: 'Draft schedule', parent: 1, duration: 2, progress: 0 },
        { id: 4, text: 'Execution', parent: 0, duration: 1 },
        { id: 5, text: 'Build', parent: 4, duration: 10, progress: 0 },
        { id: 6, text: 'Review', parent: 4, duration: 3, progress: 0 },
        { id: 7, text: 'Delivered', parent: 0, duration: 0, type: 'milestone' }
      ],
      links: [
        { id: 1, source: 2, target: 3, type: '0', lag: 0 },
        { id: 2, source: 3, target: 5, type: '0', lag: 0 },
        { id: 3, source: 5, target: 6, type: '0', lag: 0 },
        { id: 4, source: 6, target: 7, type: '0', lag: 0 }
      ]
    };
  }

  /* ---------- small helpers ---------- */

  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
  }

  function fmtDate(isoStr) {
    if (!isoStr) return '';
    var d = parseISO(isoStr);
    return d.getUTCDate() + ' ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] +
      ' ' + String(d.getUTCFullYear()).slice(2);
  }

  /* the finish date users expect to see is the last working day, not the
     exclusive end we schedule with */
  function displayFinish(t, cal) {
    if (t.type === 'milestone' || t._ef === t._es) return cal.date(t._es);
    return cal.date(t._ef - 1);
  }

  function nextTaskId() {
    var max = 0;
    State.model.tasks.forEach(function (t) {
      var n = Number(t.id);
      if (isFinite(n) && n > max) max = n;
    });
    return max + 1;
  }
  function nextLinkId() {
    var max = 0;
    (State.model.links || []).forEach(function (l) {
      var n = Number(l.id);
      if (isFinite(n) && n > max) max = n;
    });
    return max + 1;
  }

  function snapshot() {
    try {
      State.undo.push(JSON.stringify(State.model));
      if (State.undo.length > 60) State.undo.shift();
    } catch (e) { }
  }

  function markDirty() {
    State.dirty = true;
    setStatus('Unsaved changes', 'dirty');
    $('btnSave').disabled = !Store.canWrite();
  }

  function setStatus(text, cls) {
    var el = $('status');
    el.textContent = text;
    el.className = cls || '';
  }

  /* ---------- render pipeline ---------- */

  function recompute(rerender) {
    State.computed = schedule(State.model);
    showWarnings(State.computed.warnings);
    if (rerender !== false) paint();
  }

  function showWarnings(list) {
    var el = $('warnBanner');
    if (!list || !list.length) { el.className = 'banner'; el.innerHTML = ''; return; }
    var uniq = list.filter(function (v, i, a) { return a.indexOf(v) === i; });
    el.className = 'banner show';
    el.innerHTML = '<b>Check these dependencies</b><ul>' +
      uniq.map(function (w) { return '<li>' + escapeHTML(w) + '</li>'; }).join('') + '</ul>';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Build the array DHTMLX renders, in model order. */
  function ganttData() {
    var c = State.computed;
    var byId = Object.create(null);
    c.tasks.forEach(function (t) { byId[t.id] = t; });

    var incoming = Object.create(null);
    c.links.forEach(function (l) { (incoming[l.target] = incoming[l.target] || []).push(l); });

    State.renderedPreds = Object.create(null);
    var data = c.tasks.map(function (t) {
      var predStr = formatPredecessors(incoming[t.id] || []);
      State.renderedPreds[t.id] = predStr;
      return {
        id: t.id,
        text: t.text,
        start_date: t.start_date,
        duration: Math.max(t.type === 'milestone' ? 0 : 1, t.duration || 0),
        progress: Number(t.progress) || 0,
        parent: t.parent || 0,
        type: t.type === 'milestone' ? gantt.config.types.milestone
          : (t._summary ? gantt.config.types.project : gantt.config.types.task),
        open: true,
        preds: predStr,
        crit: !!t._critical,
        flt: t._float,
        pin: !!t.constraint_date,
        computedStart: t.start_date,
        finishLabel: displayFinish(t, c.calendar)
      };
    });

    return {
      data: data,
      links: c.links.map(function (l) {
        return { id: l.id, source: l.source, target: l.target, type: String(l.type), lag: l.lag || 0 };
      })
    };
  }

  function paint() {
    var scroll = null;
    var selected = null;
    try { scroll = gantt.getScrollState(); selected = gantt.getSelectedId(); } catch (e) { }

    State.applying = true;
    try {
      gantt.clearAll();
      gantt.parse(ganttData());
    } finally {
      State.applying = false;
    }
    try {
      if (scroll) gantt.scrollTo(scroll.x, scroll.y);
      if (selected != null && gantt.isTaskExists(selected)) gantt.selectTask(selected);
    } catch (e) { }
  }

  /* ---------- read the grid back into the model ---------- */

  function syncFromGantt() {
    var prev = Object.create(null);
    State.model.tasks.forEach(function (t) { prev[t.id] = t; });

    var computedPrev = Object.create(null);
    if (State.computed) State.computed.tasks.forEach(function (t) { computedPrev[t.id] = t; });

    var toISO = gantt.date.date_to_str('%Y-%m-%d');
    var tasks = [];
    var predEdits = [];

    gantt.eachTask(function (t) {
      var old = prev[t.id] || {};
      var isMilestone = t.type === gantt.config.types.milestone;
      var startISO = t.start_date ? toISO(t.start_date) : (old.start_date || State.model.project_start);

      /* If the bar moved (drag, resize, or a lightbox edit), pin it — this is
         what MS Project calls a Start-No-Earlier-Than constraint. */
      var constraint = old.constraint_date || null;
      var wasComputed = computedPrev[t.id] ? computedPrev[t.id].start_date : null;
      var isSummary = gantt.hasChild(t.id);
      if (!isSummary && wasComputed && startISO !== wasComputed) constraint = startISO;

      tasks.push({
        id: t.id,
        text: t.text,
        parent: t.parent || 0,
        duration: isMilestone ? 0 : Math.max(1, parseInt(t.duration, 10) || 1),
        progress: Math.round((Number(t.progress) || 0) * 100) / 100,
        type: isMilestone ? 'milestone' : 'task',
        constraint_date: constraint,
        start_date: startISO
      });

      /* Only a genuine text edit counts. A link created by dragging an arrow
         leaves this cell stale, and treating that as an edit would delete the
         link the user just drew. */
      if (typeof t.preds === 'string' && t.preds !== State.renderedPreds[t.id]) {
        predEdits.push({ id: t.id, str: t.preds });
      }
    });

    var links = gantt.getLinks().map(function (l) {
      return {
        id: l.id, source: l.source, target: l.target,
        type: String(l.type), lag: Number(l.lag) || 0
      };
    });

    State.model.tasks = tasks;
    State.model.links = links;

    /* apply any typed-in predecessor strings */
    applyPredEdits(predEdits);
  }

  function applyPredEdits(edits) {
    var byId = Object.create(null);
    State.model.tasks.forEach(function (t) { byId[t.id] = t; });

    var incoming = Object.create(null);
    State.model.links.forEach(function (l) { (incoming[l.target] = incoming[l.target] || []).push(l); });

    var changed = false;
    edits.forEach(function (e) {
      var current = formatPredecessors(incoming[e.id] || []);
      var typed = (e.str || '').trim();
      if (typed === current) return;

      var wanted = parsePredecessors(typed);
      var valid = wanted.filter(function (w) {
        return byId[w.source] && w.source !== e.id;
      });
      if (valid.length !== wanted.length) {
        toast('Ignored a predecessor that does not match a row number.');
      }
      /* drop this task's incoming links and rebuild */
      State.model.links = State.model.links.filter(function (l) { return l.target !== e.id; });
      valid.forEach(function (w) {
        State.model.links.push({
          id: nextLinkId(), source: w.source, target: e.id,
          type: w.type, lag: w.lag
        });
      });
      changed = true;
    });
    return changed;
  }

  var syncTimer = null;
  function scheduleSync() {
    if (State.applying) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      snapshot();
      syncFromGantt();
      markDirty();
      recompute();
    }, 0);
  }

  /* ---------- DHTMLX configuration ---------- */

  var SCALES = {
    day: {
      min_column_width: 34,
      scales: [
        { unit: 'month', step: 1, format: '%F %Y' },
        { unit: 'day', step: 1, format: '%j' }
      ]
    },
    week: {
      min_column_width: 60,
      scales: [
        { unit: 'month', step: 1, format: '%F %Y' },
        {
          unit: 'week', step: 1, format: function (d) {
            return gantt.date.date_to_str('%d %M')(d);
          }
        }
      ]
    },
    month: {
      min_column_width: 70,
      scales: [
        { unit: 'year', step: 1, format: '%Y' },
        { unit: 'month', step: 1, format: '%M' }
      ]
    },
    quarter: {
      min_column_width: 90,
      scales: [
        { unit: 'year', step: 1, format: '%Y' },
        {
          unit: 'quarter', step: 1, format: function (d) {
            return 'Q' + (Math.floor(d.getMonth() / 3) + 1);
          }
        }
      ]
    }
  };

  function setupGantt() {
    gantt.config.date_format = '%Y-%m-%d';
    gantt.config.duration_unit = 'day';
    gantt.config.work_time = true;
    gantt.config.skip_off_time = false;
    gantt.config.row_height = 30;
    gantt.config.bar_height = 18;
    gantt.config.scale_height = 52;
    gantt.config.grid_width = 470;
    gantt.config.order_branch = true;
    gantt.config.order_branch_free = true;
    gantt.config.drag_links = true;
    gantt.config.drag_progress = true;
    gantt.config.auto_types = false;
    gantt.config.details_on_dblclick = true;
    gantt.config.show_errors = false;

    gantt.config.columns = [
      {
        name: 'id', label: '#', width: 40, align: 'center', resize: false,
        template: function (t) { return '<span class="cell-muted">' + t.id + '</span>'; }
      },
      {
        name: 'text', label: 'Task name', tree: true, width: 190, resize: true,
        editor: { type: 'text', map_to: 'text' }
      },
      {
        name: 'preds', label: 'Pred.', width: 74, align: 'center', resize: true,
        editor: { type: 'text', map_to: 'preds' },
        template: function (t) {
          if (t.type === gantt.config.types.project) return '';
          return t.preds ? escapeHTML(t.preds) : '<span class="cell-muted">–</span>';
        }
      },
      {
        name: 'start_date', label: 'Start', width: 78, align: 'center', resize: true,
        template: function (t) {
          return (t.pin ? '📌 ' : '') + fmtDate(gantt.date.date_to_str('%Y-%m-%d')(t.start_date));
        }
      },
      {
        name: 'finish', label: 'Finish', width: 78, align: 'center', resize: true,
        template: function (t) { return fmtDate(t.finishLabel); }
      },
      {
        name: 'duration', label: 'Days', width: 48, align: 'center', resize: true,
        editor: { type: 'number', map_to: 'duration', min: 0, max: 3650 },
        template: function (t) {
          return t.type === gantt.config.types.milestone ? '–' : t.duration;
        }
      },
      {
        name: 'flt', label: 'Float', width: 52, align: 'center', resize: true,
        template: function (t) {
          if (t.type === gantt.config.types.project || t.flt == null) return '';
          return t.flt <= 0 ? '<span class="cell-crit">0</span>' : t.flt + 'd';
        }
      }
    ];

    gantt.templates.task_class = function (start, end, task) {
      var cls = [];
      if (State.showCritical && task.crit) cls.push('critical');
      if (task.pin) cls.push('pinned');
      return cls.join(' ');
    };
    gantt.templates.tooltip_text = function (start, end, task) {
      var lines = ['<b>' + escapeHTML(task.text) + '</b>',
      'Start: ' + fmtDate(gantt.date.date_to_str('%Y-%m-%d')(start)),
      'Finish: ' + fmtDate(task.finishLabel)];
      if (task.type !== gantt.config.types.milestone) lines.push('Duration: ' + task.duration + ' working days');
      if (task.flt != null) lines.push('Float: ' + task.flt + ' days' + (task.crit ? ' (critical)' : ''));
      if (task.preds) lines.push('After: ' + escapeHTML(task.preds));
      if (task.pin) lines.push('Date pinned — dependencies will not move it earlier');
      return lines.join('<br>');
    };
    gantt.templates.grid_row_class = function (s, e, t) {
      return t.type === gantt.config.types.project ? 'summary-row' : '';
    };

    applyZoom('week');
    gantt.init('gantt');

    ['onAfterTaskUpdate', 'onAfterTaskAdd', 'onAfterTaskDelete', 'onAfterTaskMove',
      'onAfterLinkAdd', 'onAfterLinkDelete', 'onAfterLinkUpdate', 'onRowDragEnd']
      .forEach(function (ev) { gantt.attachEvent(ev, scheduleSync); });

    gantt.attachEvent('onAfterTaskDrag', function () { scheduleSync(); });
  }

  function applyZoom(key) {
    var z = SCALES[key] || SCALES.week;
    gantt.config.min_column_width = z.min_column_width;
    gantt.config.scales = z.scales;
    try { gantt.render(); } catch (e) { }
  }

  function applyWorkTime() {
    try {
      gantt.config.work_time = true;
      (State.model.holidays || []).forEach(function (h) {
        gantt.setWorkTime({ date: parseISO(h), hours: false });
      });
    } catch (e) { }
  }

  function setReadonly(ro) {
    State.readonly = ro;
    gantt.config.readonly = ro;
    ['btnAdd', 'btnMilestone', 'btnIndent', 'btnOutdent', 'btnDelete', 'btnUnpin']
      .forEach(function (id) { $(id).disabled = ro; });
    $('projectName').readOnly = ro;
    $('btnSave').style.display = ro ? 'none' : '';
    try { gantt.render(); } catch (e) { }
  }

  /* ---------- toolbar actions ---------- */

  function addRow(isMilestone) {
    var sel = gantt.getSelectedId();
    var parent = 0, index = State.model.tasks.length;
    if (sel != null && gantt.isTaskExists(sel)) {
      parent = gantt.getParent(sel) || 0;
      index = gantt.getTaskIndex(sel) + 1;
    }
    snapshot();
    var id = nextTaskId();
    var startFrom = State.computed && State.computed.projectStart || todayISO();
    State.model.tasks.push({
      id: id,
      text: isMilestone ? 'New milestone' : 'New task',
      parent: parent,
      duration: isMilestone ? 0 : 3,
      progress: 0,
      type: isMilestone ? 'milestone' : 'task',
      constraint_date: startFrom,
      start_date: startFrom
    });
    /* place it right after the selected row in model order */
    var moved = State.model.tasks.pop();
    var insertAt = State.model.tasks.findIndex(function (t) { return t.id === sel; });
    State.model.tasks.splice(insertAt >= 0 ? insertAt + 1 : State.model.tasks.length, 0, moved);

    markDirty();
    recompute();
    try { gantt.selectTask(id); gantt.showTask(id); } catch (e) { }
  }

  function indentRow() {
    var id = gantt.getSelectedId();
    if (id == null || !gantt.isTaskExists(id)) return;
    var prev = gantt.getPrevSibling(id);
    if (!prev) { toast('Nothing above this row to nest it under.'); return; }
    snapshot();
    gantt.moveTask(id, -1, prev);
    gantt.open(prev);
    scheduleSync();
  }

  function outdentRow() {
    var id = gantt.getSelectedId();
    if (id == null || !gantt.isTaskExists(id)) return;
    var parent = gantt.getParent(id);
    if (!parent || parent === gantt.config.root_id) { toast('Already at the top level.'); return; }
    snapshot();
    gantt.moveTask(id, gantt.getTaskIndex(parent) + 1, gantt.getParent(parent));
    scheduleSync();
  }

  function deleteRow() {
    var id = gantt.getSelectedId();
    if (id == null || !gantt.isTaskExists(id)) return;
    var t = gantt.getTask(id);
    var kids = gantt.getChildren(id).length;
    var msg = kids
      ? 'Delete “' + t.text + '” and its ' + kids + ' sub-task' + (kids > 1 ? 's' : '') + '?'
      : 'Delete “' + t.text + '”?';
    if (!confirm(msg)) return;
    snapshot();
    gantt.deleteTask(id);
    scheduleSync();
  }

  function unpinRow() {
    var id = gantt.getSelectedId();
    if (id == null) return;
    var t = State.model.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (!t.constraint_date) { toast('That row is not pinned.'); return; }
    var hasPred = State.model.links.some(function (l) { return l.target === id; });
    if (!hasPred) { toast('This row has no predecessor, so its date is all it has.'); return; }
    snapshot();
    t.constraint_date = null;
    markDirty();
    recompute();
    toast('Date released — dependencies drive it now.');
  }

  function undo() {
    if (!State.undo.length) { toast('Nothing to undo.'); return; }
    var prev = State.undo.pop();
    try {
      State.model = JSON.parse(prev);
      $('projectName').value = State.model.project || 'Project';
      markDirty();
      recompute();
      toast('Undone.');
    } catch (e) { toast('Could not undo.'); }
  }

  /* ---------- save / load / conflict ---------- */

  function doSave() {
    if (!Store.canWrite()) { openSettings(); return; }
    State.model.project = $('projectName').value.trim() || 'Project';
    $('btnSave').disabled = true;
    setStatus('Saving…');

    Store.save(State.model, 'Update schedule: ' + State.model.project)
      .then(function () {
        State.dirty = false;
        State.lastSaved = new Date();
        setStatus('Saved ' + State.lastSaved.toLocaleTimeString(), 'saved');
        $('staleBanner').className = 'banner stale';
      })
      .catch(function (err) {
        $('btnSave').disabled = false;
        if (err.conflict) {
          setStatus('Save blocked', 'error');
          showStale(true);
        } else {
          setStatus('Save failed', 'error');
          alert(err.message || 'Save failed.');
        }
      });
  }

  function showStale(isConflict) {
    var el = $('staleBanner');
    el.className = 'banner stale show';
    el.innerHTML = isConflict
      ? '<b>Someone else saved first</b>Your copy is based on an older version, so ' +
      'GitHub refused the write rather than overwriting their work. Open the file ' +
      'history to see what changed, then reload and re-apply your edits.' +
      '<button id="reloadNow">Reload (discards my edits)</button>'
      : '<b>Updated on GitHub</b>Someone saved a newer version while you were editing.' +
      '<button id="reloadNow">Reload (discards my edits)</button>';
    var b = $('reloadNow');
    if (b) b.onclick = function () { location.reload(); };
  }

  function bootLoad() {
    setStatus('Loading…');
    return Store.load()
      .then(function (model) {
        if (!model) {
          State.model = starterModel();
          setStatus(Store.canWrite()
            ? 'No schedule.json yet — save to create it'
            : 'No schedule.json found', Store.canWrite() ? 'dirty' : 'error');
          State.dirty = true;
        } else {
          State.model = normalize(model);
          setStatus('Loaded', 'saved');
        }
        $('projectName').value = State.model.project || 'Project';
        applyWorkTime();
        recompute();
        setReadonly(!Store.canWrite());
        $('btnSave').disabled = !Store.canWrite() || !State.dirty;
      })
      .catch(function (err) {
        setStatus('Load failed', 'error');
        State.model = starterModel();
        recompute();
        setReadonly(true);
        alert(err.message || 'Could not load the schedule.');
      });
  }

  function normalize(m) {
    m = m || {};
    m.project = m.project || 'Project';
    m.project_start = m.project_start || todayISO();
    m.holidays = m.holidays || [];
    m.tasks = (m.tasks || []).map(function (t) {
      return {
        id: t.id,
        text: t.text == null ? '' : String(t.text),
        parent: t.parent || 0,
        duration: t.type === 'milestone' ? 0 : (Number(t.duration) || 1),
        progress: Number(t.progress) || 0,
        type: t.type === 'milestone' ? 'milestone' : 'task',
        constraint_date: t.constraint_date || null,
        start_date: t.start_date || null
      };
    });
    m.links = (m.links || []).map(function (l) {
      return {
        id: l.id, source: l.source, target: l.target,
        type: String(l.type == null ? '0' : l.type), lag: Number(l.lag) || 0
      };
    });
    return m;
  }

  function startPolling() {
    setInterval(function () {
      if (document.hidden || !Store.token() || !Store.sha) return;
      Store.remoteSha().then(function (sha) {
        if (!sha || sha === Store.sha) return;
        if (State.dirty) { showStale(false); return; }
        Store.load().then(function (model) {
          if (!model) return;
          State.model = normalize(model);
          $('projectName').value = State.model.project || 'Project';
          recompute();
          setStatus('Updated from GitHub', 'saved');
          toast('Schedule updated by a teammate.');
        }).catch(function () { });
      });
    }, 45000);
  }

  /* ---------- settings dialog ---------- */

  function openSettings() {
    var c = Store.cfg;
    $('setOwner').value = c.owner || '';
    $('setRepo').value = c.repo || '';
    $('setBranch').value = c.branch || 'main';
    $('setPath').value = c.path || 'schedule.json';
    $('setToken').value = Store.token();
    $('settings').showModal();
  }

  function wireSettings() {
    $('btnSettings').onclick = openSettings;
    $('setCancel').onclick = function () { $('settings').close(); };
    $('setForget').onclick = function () {
      Store.setToken('');
      $('setToken').value = '';
      toast('Token removed from this browser.');
      $('settings').close();
      location.reload();
    };
    $('setSave').onclick = function () {
      Store.saveCfg({
        owner: $('setOwner').value.trim(),
        repo: $('setRepo').value.trim(),
        branch: $('setBranch').value.trim() || 'main',
        path: $('setPath').value.trim() || 'schedule.json'
      });
      Store.setToken($('setToken').value.trim());
      $('settings').close();
      location.reload();
    };
  }

  /* ===========================================================================
     EXPORTS — SVG (print-ready), PNG, CSV
     ======================================================================== */

  function flattenForExport() {
    var c = State.computed;
    var byId = Object.create(null);
    c.tasks.forEach(function (t) { byId[t.id] = t; });
    var kids = Object.create(null);
    c.tasks.forEach(function (t) { (kids[t.parent || 0] = kids[t.parent || 0] || []).push(t); });

    var rows = [];
    (function walk(parent, depth) {
      (kids[parent] || []).forEach(function (t) {
        rows.push({ task: t, depth: depth });
        walk(t.id, depth + 1);
      });
    })(0, 0);
    return rows;
  }

  function buildSVG() {
    var c = State.computed;
    var rows = flattenForExport();
    var incoming = Object.create(null);
    c.links.forEach(function (l) { (incoming[l.target] = incoming[l.target] || []).push(l); });

    var LEFT = 250, ROW = 24, HEAD = 56, PAD = 20, TITLE = 54;
    var startD = parseISO(c.projectStart);
    var endD = parseISO(c.projectEnd);
    /* pad the window a little on each side */
    startD = addDays(startD, -3);
    endD = addDays(endD, 6);
    /* keep the "today" marker on the page when it sits just outside the plan */
    var nowD = parseISO(todayISO());
    if (nowD < startD && (startD - nowD) / 86400000 < 90) startD = addDays(nowD, -2);
    if (nowD > endD && (nowD - endD) / 86400000 < 90) endD = addDays(nowD, 2);
    var totalDays = Math.max(1, Math.round((endD - startD) / 86400000));
    var pxDay = Math.max(2.2, Math.min(24, 1180 / totalDays));
    var chartW = totalDays * pxDay;
    var W = LEFT + chartW + PAD * 2;
    var H = TITLE + HEAD + rows.length * ROW + PAD * 2 + 26;

    function x(dateISO) {
      return PAD + LEFT + Math.round(((parseISO(dateISO) - startD) / 86400000) * pxDay);
    }
    function rowY(i) { return PAD + TITLE + HEAD + i * ROW; }

    var s = [];
    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(W) + '" height="' + Math.round(H) +
      '" viewBox="0 0 ' + Math.round(W) + ' ' + Math.round(H) + '" font-family="Helvetica, Arial, sans-serif">');
    s.push('<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">' +
      '<path d="M0,0 L7,3.5 L0,7 z" fill="#8a90a0"/></marker></defs>');
    s.push('<rect width="100%" height="100%" fill="#ffffff"/>');

    /* title */
    s.push('<text x="' + PAD + '" y="' + (PAD + 20) + '" font-size="17" font-weight="700" fill="#1b1f26">' +
      esc(State.model.project || 'Project') + '</text>');
    s.push('<text x="' + PAD + '" y="' + (PAD + 38) + '" font-size="11" fill="#6b7280">' +
      esc(fmtDate(c.projectStart) + ' – ' + fmtDate(c.calendar.date(c.calendar.idx(c.projectEnd) - 1)) +
        '  ·  ' + c.totalWorkdays + ' working days  ·  ' + rows.length + ' rows  ·  exported ' +
        fmtDate(todayISO())) + '</text>');

    /* zebra stripes first, so the weekend shading laid over them stays visible */
    var top = PAD + TITLE + HEAD, bottom = top + rows.length * ROW;
    rows.forEach(function (r, i) {
      if (i % 2 === 1) {
        s.push('<rect x="' + PAD + '" y="' + rowY(i) + '" width="' + (LEFT + chartW) +
          '" height="' + ROW + '" fill="#fafbfc"/>');
      }
    });

    if (pxDay >= 5) {
      for (var d = new Date(startD.getTime()); d < endD; d = addDays(d, 1)) {
        var wd = d.getUTCDay();
        if (wd === 0 || wd === 6 || (State.model.holidays || []).indexOf(iso(d)) !== -1) {
          s.push('<rect x="' + x(iso(d)) + '" y="' + top + '" width="' + Math.ceil(pxDay) +
            '" height="' + (bottom - top) + '" fill="#f4f5f7"/>');
        }
      }
    }

    /* month scale */
    var m = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), 1));
    var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    while (m < endD) {
      var next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
      var mx = x(iso(m < startD ? startD : m));
      var mx2 = x(iso(next > endD ? endD : next));
      s.push('<line x1="' + mx + '" y1="' + (top - HEAD + 22) + '" x2="' + mx + '" y2="' + bottom +
        '" stroke="#dfe2e8" stroke-width="1"/>');
      if (mx2 - mx > 34) {
        s.push('<text x="' + (mx + 5) + '" y="' + (top - HEAD + 38) + '" font-size="11" font-weight="600" fill="#4b5563">' +
          esc(mx2 - mx > 78 ? MON[m.getUTCMonth()] + ' ' + m.getUTCFullYear()
            : MON[m.getUTCMonth()].slice(0, 3)) + '</text>');
      }
      m = next;
    }
    s.push('<line x1="' + (PAD + LEFT) + '" y1="' + (top - 1) + '" x2="' + (PAD + LEFT + chartW) +
      '" y2="' + (top - 1) + '" stroke="#c9ced8"/>');
    s.push('<line x1="' + (PAD + LEFT - 8) + '" y1="' + (top - HEAD + 14) + '" x2="' + (PAD + LEFT - 8) +
      '" y2="' + bottom + '" stroke="#c9ced8"/>');

    /* today marker */
    var t0 = todayISO();
    if (parseISO(t0) >= startD && parseISO(t0) <= endD) {
      s.push('<line x1="' + x(t0) + '" y1="' + (top - 8) + '" x2="' + x(t0) + '" y2="' + bottom +
        '" stroke="#2f6feb" stroke-width="1.2" stroke-dasharray="3 3"/>');
      s.push('<text x="' + (x(t0) + 4) + '" y="' + (top - 10) + '" font-size="10" fill="#2f6feb">today</text>');
    }

    /* rows */
    var pos = Object.create(null);
    rows.forEach(function (r, i) {
      var t = r.task, y = rowY(i), cy = y + ROW / 2;
      var label = t.text || '';
      var maxChars = Math.floor((LEFT - 14 - r.depth * 12) / 5.6);
      if (label.length > maxChars) label = label.slice(0, Math.max(3, maxChars - 1)) + '…';
      s.push('<text x="' + (PAD + 4 + r.depth * 12) + '" y="' + (cy + 4) + '" font-size="11.5" fill="#1b1f26"' +
        (t._summary ? ' font-weight="700"' : '') + '>' + esc(label) + '</text>');

      var x1 = x(t.start_date), x2 = x(t.end_date);
      var barW = Math.max(3, x2 - x1);
      var crit = State.showCritical && t._critical;
      var fill = t._summary ? '#4b5563' : (crit ? '#d9453d' : '#5b8def');

      if (t.type === 'milestone') {
        var r0 = 6;
        s.push('<path d="M' + x1 + ',' + (cy - r0) + ' L' + (x1 + r0) + ',' + cy +
          ' L' + x1 + ',' + (cy + r0) + ' L' + (x1 - r0) + ',' + cy + ' Z" fill="#1b1f26"/>');
        pos[t.id] = { x1: x1, x2: x1, cy: cy };
      } else if (t._summary) {
        s.push('<rect x="' + x1 + '" y="' + (cy - 4) + '" width="' + barW + '" height="8" fill="' + fill + '"/>');
        s.push('<path d="M' + x1 + ',' + (cy + 4) + ' l0,5 l5,-5 z" fill="' + fill + '"/>');
        s.push('<path d="M' + (x1 + barW) + ',' + (cy + 4) + ' l0,5 l-5,-5 z" fill="' + fill + '"/>');
        pos[t.id] = { x1: x1, x2: x1 + barW, cy: cy };
      } else {
        s.push('<rect x="' + x1 + '" y="' + (cy - 7) + '" width="' + barW + '" height="14" rx="2.5" fill="' +
          fill + '"/>');
        var prog = Math.max(0, Math.min(1, Number(t.progress) || 0));
        if (prog > 0) {
          s.push('<rect x="' + x1 + '" y="' + (cy - 7) + '" width="' + (barW * prog) +
            '" height="14" rx="2.5" fill="rgba(0,0,0,0.28)"/>');
        }
        pos[t.id] = { x1: x1, x2: x1 + barW, cy: cy };
        if (barW > 34) {
          s.push('<text x="' + (x1 + 5) + '" y="' + (cy + 3.5) + '" font-size="9.5" ' +
            'fill="#ffffff" opacity="0.92">' + t.duration + 'd</text>');
        }
      }
    });

    /* dependency arrows */
    c.links.forEach(function (l) {
      var a = pos[l.source], b = pos[l.target];
      if (!a || !b) return;
      var type = String(l.type);
      var sx = (type === LINK.SS || type === LINK.SF) ? a.x1 : a.x2;
      var tx = (type === LINK.FF || type === LINK.SF) ? b.x2 : b.x1;
      var sy = a.cy, ty = b.cy, path;
      if (tx >= sx + 12) {
        path = 'M' + sx + ',' + sy + ' H' + (sx + 7) + ' V' + ty + ' H' + (tx - 6);
      } else {
        var yMid = ty > sy ? sy + ROW / 2 : sy - ROW / 2;
        path = 'M' + sx + ',' + sy + ' H' + (sx + 7) + ' V' + yMid +
          ' H' + (tx - 14) + ' V' + ty + ' H' + (tx - 6);
      }
      s.push('<path d="' + path + '" fill="none" stroke="#8a90a0" stroke-width="1.1" marker-end="url(#ah)"/>');
    });

    /* legend */
    var ly = PAD + TITLE + HEAD + rows.length * ROW + 18;
    var lx = PAD;
    function chip(color, label, shape) {
      if (shape === 'diamond') {
        s.push('<path d="M' + (lx + 6) + ',' + (ly - 5) + ' l6,5 l-6,5 l-6,-5 z" fill="' + color + '"/>');
      } else {
        s.push('<rect x="' + lx + '" y="' + (ly - 5) + '" width="14" height="10" rx="2" fill="' + color + '"/>');
      }
      s.push('<text x="' + (lx + 20) + '" y="' + (ly + 3.5) + '" font-size="10.5" fill="#4b5563">' +
        esc(label) + '</text>');
      lx += 24 + label.length * 6;
    }
    chip('#4b5563', 'Summary');
    chip('#5b8def', 'Task');
    if (State.showCritical) chip('#d9453d', 'Critical path');
    chip('#1b1f26', 'Milestone', 'diamond');

    s.push('</svg>');
    return s.join('');
  }

  function esc(v) {
    return String(v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function slug() {
    return (State.model.project || 'schedule').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schedule';
  }

  function exportSVG() {
    download(new Blob([buildSVG()], { type: 'image/svg+xml;charset=utf-8' }), slug() + '.svg');
  }

  function exportPNG() {
    var svg = buildSVG();
    var img = new Image();
    var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    img.onload = function () {
      var scale = 2;
      var canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (b) { download(b, slug() + '.png'); }, 'image/png');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      toast('PNG export failed — the SVG download works everywhere.');
    };
    img.src = url;
  }

  function exportCSV() {
    var c = State.computed;
    var incoming = Object.create(null);
    c.links.forEach(function (l) { (incoming[l.target] = incoming[l.target] || []).push(l); });

    var head = ['ID', 'Task', 'Level', 'Start', 'Finish', 'Working days',
      'Predecessors', 'Percent complete', 'Total float', 'Critical'];
    var rows = flattenForExport().map(function (r) {
      var t = r.task;
      return [
        t.id, t.text, r.depth,
        t.start_date, displayFinish(t, c.calendar),
        t.type === 'milestone' ? 0 : t.duration,
        formatPredecessors(incoming[t.id] || []),
        Math.round((Number(t.progress) || 0) * 100),
        t._float == null ? '' : t._float,
        t._summary ? '' : (t._critical ? 'yes' : 'no')
      ];
    });
    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (v) {
        v = v == null ? '' : String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
    download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), slug() + '.csv');
  }

  /* ---------- chart menu ---------- */

  function wireChartMenu() {
    var btn = $('btnSvg');
    btn.onclick = function (e) {
      e.stopPropagation();
      var existing = document.getElementById('chartMenu');
      if (existing) { existing.remove(); return; }
      var menu = document.createElement('div');
      menu.id = 'chartMenu';
      var r = btn.getBoundingClientRect();
      menu.style.cssText = 'position:fixed;z-index:1000;background:#fff;border:1px solid #e2e5ea;' +
        'border-radius:7px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:4px;min-width:172px;' +
        'top:' + (r.bottom + 4) + 'px;left:' + Math.max(8, r.left - 60) + 'px;';
      [['Download SVG (vector)', exportSVG], ['Download PNG (image)', exportPNG]]
        .forEach(function (pair) {
          var item = document.createElement('button');
          item.textContent = pair[0];
          item.style.cssText = 'display:block;width:100%;text-align:left;border:none;background:none;' +
            'padding:7px 10px;border-radius:5px;font-size:13px;cursor:pointer;';
          item.onmouseenter = function () { item.style.background = '#f2f4f7'; };
          item.onmouseleave = function () { item.style.background = 'none'; };
          item.onclick = function () { menu.remove(); pair[1](); };
          menu.appendChild(item);
        });
      document.body.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function close() {
          var el = document.getElementById('chartMenu');
          if (el) el.remove();
          document.removeEventListener('click', close);
        });
      }, 0);
    };
  }

  /* ---------- wire up ---------- */

  function wireToolbar() {
    $('btnAdd').onclick = function () { addRow(false); };
    $('btnMilestone').onclick = function () { addRow(true); };
    $('btnIndent').onclick = indentRow;
    $('btnOutdent').onclick = outdentRow;
    $('btnDelete').onclick = deleteRow;
    $('btnUnpin').onclick = unpinRow;
    $('btnSave').onclick = doSave;
    $('btnCsv').onclick = exportCSV;

    $('zoom').onchange = function () { applyZoom(this.value); };

    $('btnCritical').onclick = function () {
      State.showCritical = !State.showCritical;
      this.classList.toggle('toggled', State.showCritical);
      try { gantt.render(); } catch (e) { }
    };

    $('projectName').onchange = function () {
      if (State.readonly) return;
      snapshot();
      State.model.project = this.value.trim() || 'Project';
      markDirty();
    };

    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!State.readonly) doSave(); }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
        e.preventDefault();
        if (!State.readonly) undo();
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (State.dirty && !State.readonly) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function boot() {
    Store.init();
    setupGantt();
    wireToolbar();
    wireSettings();
    wireChartMenu();
    bootLoad().then(startPolling);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* exposed for the console / debugging */
  window.GanttApp = {
    state: State, store: Store, schedule: schedule, buildSVG: buildSVG,
    parsePredecessors: parsePredecessors, formatPredecessors: formatPredecessors
  };
})();
