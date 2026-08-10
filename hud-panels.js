// =============================================================
// HUD composition: the command header and the three panels.
//
// This is a presentation layer. It creates decorative wrappers and MOVES
// existing nodes into them; it never rebuilds a control, so every listener
// main.html attached keeps working.
//
// Two constraints shape the whole file:
//
//   1. renderRouting() queries `#goalList .gm-row`. That is a DESCENDANT
//      selector, so the panels are built INSIDE #goalList and the rows stay
//      its descendants. Nothing in main.html's JS changes.
//
//   2. renderListInto() empties #goalList with innerHTML on every render, so
//      the panels are destroyed and rebuilt constantly. A MutationObserver
//      puts them back. If this file fails or is removed, the rows simply stay
//      in one flat list, which is the pre-HUD behaviour.
//
// Runs after focus-mode.js (script order), which has already lifted #gmArrow
// to the top of the card.
// =============================================================
(function () {
  'use strict';

  // Defaults, overridable from the console without a deploy:
  //   localStorage.setItem('hud:workStart', '9')
  //   localStorage.setItem('hud:workEnd', '17')
  //   localStorage.setItem('hud:bedtime', '22')
  var DEFAULTS = { workStart: 9, workEnd: 17, bedtime: 22 };

  function setting(name) {
    var raw = null;
    try { raw = localStorage.getItem('hud:' + name); } catch (e) {}
    var n = raw === null ? NaN : parseFloat(raw);
    return isFinite(n) ? n : DEFAULTS[name];
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function byId(id) { return document.getElementById(id); }

  // ---------- command header ----------

  // main.html treats the day as flipping at 06:00, so a task added at 01:00
  // still belongs to the previous day. The header has to agree with it.
  function activeDate() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return d;
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function dayName() { return DAYS[activeDate().getDay()]; }
  function dateLine() {
    var d = activeDate();
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function minutesUntil(hour) {
    var now = new Date();
    var mark = new Date(now);
    var h = Math.floor(hour);
    mark.setHours(h, Math.round((hour - h) * 60), 0, 0);
    return Math.round((mark - now) / 60000);
  }

  function fmtHm(mins) {
    if (mins <= 0) return '0m';
    return mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
  }

  function bedtimeLeft() {
    var mins = minutesUntil(setting('bedtime'));
    return mins <= 0 ? 'past' : fmtHm(mins);
  }

  /**
   * Work time left in the day's work window.
   * A fixed window, not the calendar: the app cannot read the calendar, and
   * the context file says it is often not real anyway. This number is true
   * because it only claims to be the clock against a window you set.
   */
  function workLeft() {
    var start = setting('workStart');
    var end = setting('workEnd');
    var total = Math.max(1, Math.round((end - start) * 60));
    var toEnd = minutesUntil(end);
    var toStart = minutesUntil(start);

    if (toEnd <= 0) return { mins: 0, total: total, state: 'over', label: 'Done' };
    if (toStart > 0) return { mins: total, total: total, state: 'before', label: fmtHm(total) };

    var left = Math.min(toEnd, total);
    return {
      mins: left,
      total: total,
      state: left <= 60 ? 'low' : 'ok',
      label: fmtHm(left),
    };
  }

  var header = null;

  function buildHeader() {
    var title = document.querySelector('.dash-title');
    if (!title || !title.parentNode || byId('hudHeader')) return;

    header = el('header', 'hud-cmd');
    header.id = 'hudHeader';

    // Top strip: live readout on the left, reticle on the right.
    var top = el('div', 'hud-cmd-top');
    var readout = el('div', 'hud-readout');
    readout.id = 'hudReadout';

    // The energy chips and the streak badge are moved, not copied, so their
    // click handlers and main.html's re-render both keep working.
    var checkin = byId('gmCheckin');
    if (checkin) readout.appendChild(checkin);
    var streak = byId('gmStreak');
    if (streak) readout.appendChild(streak);

    var bed = el('span', 'hud-readout-item');
    bed.appendChild(el('span', null, 'Bedtime'));
    var bedVal = el('b', null, bedtimeLeft());
    bedVal.id = 'hudBedtime';
    bed.appendChild(bedVal);
    readout.appendChild(bed);

    top.appendChild(readout);
    top.appendChild(buildWorkRing());
    header.appendChild(top);

    // Centred title: mode plus the date main.html already computed.
    var row = el('div', 'hud-title-row');
    row.appendChild(el('span', 'hud-rule'));
    row.appendChild(el('span', 'hud-bracket', '‹‹ /'));
    var h1 = el('h1', 'hud-title', dayName());
    h1.id = 'hudTitle';
    row.appendChild(h1);
    row.appendChild(el('span', 'hud-bracket', '/ ››'));
    row.appendChild(el('span', 'hud-rule hud-rule-r'));
    header.appendChild(row);

    var sub = el('div', 'hud-cmd-date');
    sub.id = 'hudDate';
    header.appendChild(sub);

    // Day progress: the existing segment bar, relabelled.
    var prog = el('div', 'hud-progress-row');
    prog.appendChild(el('span', 'hud-label', 'Day'));
    var bar = byId('gmBar');
    if (bar) prog.appendChild(bar);
    var value = el('span', 'hud-progress-value', '');
    value.id = 'hudProgressValue';
    prog.appendChild(value);
    header.appendChild(prog);

    title.parentNode.insertBefore(header, title.nextSibling);
    title.classList.add('hud-hidden');   // replaced by the command title
    syncHeader();
  }

  var RING_R = 21;
  var RING_C = 2 * Math.PI * RING_R;

  function buildWorkRing() {
    var wrap = el('div', 'hud-workring');
    wrap.id = 'hudWorkRing';

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 52 52');
    svg.setAttribute('aria-hidden', 'true');

    function circle(cls) {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '26');
      c.setAttribute('cy', '26');
      c.setAttribute('r', String(RING_R));
      c.setAttribute('class', cls);
      return c;
    }
    svg.appendChild(circle('hud-workring-track'));
    var fill = circle('hud-workring-fill');
    fill.id = 'hudWorkRingFill';
    fill.setAttribute('stroke-dasharray', String(RING_C));
    fill.setAttribute('stroke-dashoffset', String(RING_C));
    svg.appendChild(fill);
    wrap.appendChild(svg);

    var value = el('div', 'hud-workring-value', '');
    value.id = 'hudWorkRingValue';
    wrap.appendChild(value);

    var caption = el('div', 'hud-workring-caption', 'Work');
    wrap.appendChild(caption);
    return wrap;
  }

  function syncWorkRing() {
    var wrap = byId('hudWorkRing');
    var fill = byId('hudWorkRingFill');
    var value = byId('hudWorkRingValue');
    if (!wrap || !fill || !value) return;

    var w = workLeft();
    var frac = Math.max(0, Math.min(1, w.mins / w.total));
    fill.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    value.textContent = w.label;
    wrap.dataset.state = w.state;
    wrap.title =
      'Work window ' + setting('workStart') + ':00 to ' + setting('workEnd') + ':00. ' +
      (w.state === 'over' ? 'Window closed.' : fmtHm(w.mins) + ' left.');
  }

  function pad2(v) {
    var n = parseInt(String(v).replace(/\D+/g, ''), 10);
    return isNaN(n) ? '--' : (n < 10 ? '0' + n : String(n));
  }

  function syncHeader() {
    if (!header) return;
    var titleEl = byId('hudTitle');
    if (titleEl) titleEl.textContent = dayName();
    var bed = byId('hudBedtime');
    if (bed) bed.textContent = bedtimeLeft();
    syncWorkRing();

    // Mirror the counts main.html already renders rather than recomputing them.
    var dateOut = byId('hudDate');
    if (dateOut) dateOut.textContent = dateLine();
    var num = byId('gmProgressNum');
    var total = byId('gmProgressTotal');
    var value = byId('hudProgressValue');
    if (num && total && value) {
      value.textContent = pad2(num.textContent) + ' / ' + pad2(total.textContent);
    }
  }

  // ---------- three panels ----------

  var COLUMNS = [
    { key: 'movers', label: 'Movers', code: 'Sec-01', match: function (row) {
        return !!row.querySelector('.gm-energy-mover');
      } },
    { key: 'admin', label: 'Admin / Prep', code: 'Sec-02', match: function () {
        return true;   // everything else: prep, admin, untagged, done
      } },
  ];

  var observer = null;
  var rebuilding = false;

  function makeColumn(spec) {
    var col = el('div', 'hud-col hud-col-' + spec.key);
    col.dataset.hudCol = spec.key;

    var head = el('div', 'hud-panel-head');
    head.appendChild(el('span', 'hud-heading', spec.label));
    var count = el('span', 'hud-count', '00');
    head.appendChild(count);
    col.appendChild(head);

    var body = el('div', 'hud-col-body');
    col.appendChild(body);

    var foot = el('div', 'hud-panel-foot');
    foot.appendChild(el('span', 'hud-micro', spec.code));
    var idx = el('span', 'hud-micro', 'Idx 00');
    foot.appendChild(idx);
    col.appendChild(foot);

    col._body = body;
    col._count = count;
    col._idx = idx;
    return col;
  }

  function distribute() {
    var list = byId('goalList');
    if (!list || rebuilding) return;

    // Every row anywhere under the list, not just the direct children.
    // After a pass the rows live inside the columns, and reading only direct
    // children would report an empty list and delete the panels, taking the
    // rows with them.
    var rows = Array.prototype.slice.call(list.querySelectorAll('.gm-row'));

    var loose = [];   // rows main.html just re-rendered, still flat
    var tail = [];    // the show-more toggle and anything else it appends
    Array.prototype.forEach.call(list.children, function (child) {
      if (child.dataset && child.dataset.hudCol) return;      // our own panels
      if (child.classList.contains('gm-row')) loose.push(child);
      else tail.push(child);
    });

    // Nothing to lay out: drop the panels so an empty list looks empty.
    if (!rows.length) {
      rebuilding = true;
      Array.prototype.slice.call(list.querySelectorAll('[data-hud-col]')).forEach(function (n) {
        n.parentNode.removeChild(n);
      });
      rebuilding = false;
      return;
    }

    // Already distributed and nothing new arrived: this is the observer seeing
    // our own writes. Leave the DOM alone so the pass cannot cascade.
    if (!loose.length && list.querySelector('[data-hud-col]')) return;

    rebuilding = true;

    var cols = COLUMNS.map(function (spec) {
      var existing = list.querySelector('[data-hud-col="' + spec.key + '"]');
      var col = existing || makeColumn(spec);
      if (!col._body) {
        col._body = col.querySelector('.hud-col-body');
        col._count = col.querySelector('.hud-count');
        col._idx = col.querySelector('.hud-micro:last-child');
      }
      col._body.textContent = '';
      return { spec: spec, node: col };
    });

    rows.forEach(function (row) {
      for (var i = 0; i < cols.length; i++) {
        if (cols[i].spec.match(row)) { cols[i].node._body.appendChild(row); return; }
      }
      cols[cols.length - 1].node._body.appendChild(row);
    });

    cols.forEach(function (c) {
      var n = c.node._body.children.length;
      c.node._count.textContent = n < 10 ? '0' + n : String(n);
      c.node._idx.textContent = 'Idx ' + (n < 10 ? '0' + n : String(n));
      // An empty column would be a headed panel with nothing in it.
      c.node.classList.toggle('hud-col-empty', n === 0);
      list.appendChild(c.node);
    });

    // Keep the show-more toggle after the panels.
    tail.forEach(function (node) { list.appendChild(node); });

    rebuilding = false;
  }

  function start() {
    var list = byId('goalList');
    if (!list) return;

    buildHeader();
    distribute();

    // renderListInto() wipes the list on every render, taking the panels with
    // it. Rebuild whenever that happens, guarded so our own writes do not
    // retrigger the observer.
    observer = new MutationObserver(function () {
      if (rebuilding) return;
      distribute();
      syncHeader();
    });
    observer.observe(list, { childList: true });

    window.addEventListener('goals-changed', syncHeader);
    window.addEventListener('storage', syncHeader);
    setInterval(syncHeader, 60000);   // bedtime countdown and the 06:00 day rollover
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
