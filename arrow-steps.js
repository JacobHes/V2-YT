// =============================================================
// Breakdown panel under the arrow.
//
// The arrow is by definition the big task of the day, so it usually is not one
// action but several that batch together. This gives it a list of steps that
// live on the task itself, so they carry forward with it and Grant can read
// and write them.
//
// Stored on the arrow task as `steps: [{id, text, done}]` in goals:<date>.
// Writes dispatch the `storage` event main.html already re-renders from, so
// none of its functions are called or changed.
//
// Every write goes to the task the panel is SHOWING (its id and list key,
// captured at render), found by id in a fresh read. If a sync merge moved the
// arrow to another task in between, the step still lands on the task the user
// was looking at, and a step typed for a task that has since gone is kept in
// the input rather than lost.
// =============================================================
(function () {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }
  // Must match main.html: the day flips at 06:00.
  function todayKey() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return 'goals:' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function commit(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { return false; }
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(new CustomEvent('goals-changed'));
    return true;
  }
  function genId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function arrowTask(list) {
    return list.find(function (g) { return g && g.arrow; }) || null;
  }

  // The task the panel currently shows: { key, id }.
  var shown = null;

  /** Change the shown task, by id in a fresh read. False if it is gone. */
  function mutateShown(fn) {
    if (!shown || shown.id == null) return false;
    var list = read(shown.key);
    var task = list.find(function (g) { return g && g.id === shown.id; });
    if (!task) return false;
    if (!Array.isArray(task.steps)) task.steps = [];
    fn(task);
    return commit(shown.key, list);
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var panel = null;
  var rendering = false;

  function build() {
    panel = el('div', 'arrow-steps');
    panel.id = 'arrowSteps';

    var head = el('div', 'arrow-steps-head');
    head.appendChild(el('span', 'arrow-steps-title', 'Breakdown'));
    var count = el('span', 'arrow-steps-count', '');
    count.id = 'arrowStepsCount';
    head.appendChild(count);
    panel.appendChild(head);

    var list = el('div', 'arrow-steps-list');
    list.id = 'arrowStepsList';
    panel.appendChild(list);

    var form = el('div', 'arrow-steps-form');
    var input = el('input', 'arrow-steps-input');
    input.type = 'text';
    input.placeholder = 'Break it into a step…';
    input.autocomplete = 'off';
    input.id = 'arrowStepsInput';
    var add = el('button', 'arrow-steps-add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add step');

    function submit() {
      var raw = input.value;
      var text = raw.trim();
      if (!text) return;
      input.value = '';
      var ok = mutateShown(function (task) {
        task.steps.push({ id: genId(), text: text, done: false });
      });
      if (!ok) { input.value = raw; render(); }   // the task is gone: keep what was typed
    }
    add.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    // Renders skipped while typing (see render) catch up here.
    input.addEventListener('blur', function () { setTimeout(render, 0); });

    form.appendChild(input);
    form.appendChild(add);
    panel.appendChild(form);
    return panel;
  }

  // The breakdown input has focus. Removing or moving the panel then would
  // drop the focus mid-typing, so those wait for the blur.
  function typingInPanel() {
    var a = document.activeElement;
    return !!(panel && a && a.id === 'arrowStepsInput' && panel.contains(a));
  }

  function render() {
    if (rendering) return;
    var arrowEl = document.getElementById('gmArrow');
    if (!arrowEl || !arrowEl.parentNode) return;

    var key = todayKey();
    var list = read(key);
    var task = arrowTask(list);

    // While a step is being typed, keep the panel on the task it is being
    // typed for, even if a sync merge moved the arrow meanwhile. The blur
    // re-renders onto the current arrow.
    if (typingInPanel() && shown && shown.id != null) {
      var pinned = read(shown.key).find(function (g) { return g && g.id === shown.id; });
      if (pinned) { key = shown.key; task = pinned; }
    }

    // No arrow aimed: nothing to break down.
    if (!task) {
      if (typingInPanel()) return;   // keep the panel and its text until the blur
      shown = null;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      return;
    }

    rendering = true;
    shown = { key: key, id: task.id };
    if (!panel) build();
    // main.html re-renders around it, so re-seat the panel under the arrow.
    if (panel.previousSibling !== arrowEl && !typingInPanel()) {
      arrowEl.parentNode.insertBefore(panel, arrowEl.nextSibling);
    }

    var steps = Array.isArray(task.steps) ? task.steps : [];
    var listEl = document.getElementById('arrowStepsList');
    var countEl = document.getElementById('arrowStepsCount');
    listEl.textContent = '';

    var doneCount = steps.filter(function (s) { return s.done; }).length;
    countEl.textContent = steps.length ? doneCount + ' / ' + steps.length : '';

    steps.forEach(function (step) {
      var row = el('div', 'arrow-step' + (step.done ? ' is-done' : ''));

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'arrow-step-check';
      box.checked = !!step.done;
      box.addEventListener('change', function () {
        var checked = box.checked;
        if (!mutateShown(function (t) {
          var s = t.steps.find(function (x) { return x && x.id === step.id; });
          if (s) s.done = checked;
        })) render();
      });
      row.appendChild(box);

      row.appendChild(el('span', 'arrow-step-text', step.text));

      var del = el('button', 'arrow-step-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove step');
      del.addEventListener('click', function () {
        if (!mutateShown(function (t) {
          t.steps = t.steps.filter(function (x) { return !(x && x.id === step.id); });
        })) render();
      });
      row.appendChild(del);

      listEl.appendChild(row);
    });

    rendering = false;
  }

  function start() {
    render();
    window.addEventListener('goals-changed', render);
    window.addEventListener('storage', render);
    var card = document.getElementById('gmCardToday');
    if (card) {
      new MutationObserver(function () { if (!rendering) render(); })
        .observe(card, { childList: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
