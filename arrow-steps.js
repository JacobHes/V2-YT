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

  function read() {
    try { var v = JSON.parse(localStorage.getItem(todayKey())); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function commit(list) {
    try { localStorage.setItem(todayKey(), JSON.stringify(list)); } catch (e) { return; }
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(new CustomEvent('goals-changed'));
  }
  function genId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function arrowTask(list) {
    return list.find(function (g) { return g.arrow; }) || null;
  }

  function mutateArrow(fn) {
    var list = read();
    var task = arrowTask(list);
    if (!task) return;
    if (!Array.isArray(task.steps)) task.steps = [];
    fn(task);
    commit(list);
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
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      mutateArrow(function (task) {
        task.steps.push({ id: genId(), text: text, done: false });
      });
    }
    add.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    form.appendChild(input);
    form.appendChild(add);
    panel.appendChild(form);
    return panel;
  }

  function render() {
    if (rendering) return;
    var arrowEl = document.getElementById('gmArrow');
    if (!arrowEl || !arrowEl.parentNode) return;

    var list = read();
    var task = arrowTask(list);

    // No arrow aimed: nothing to break down.
    if (!task) {
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      return;
    }

    rendering = true;
    if (!panel) build();
    // main.html re-renders around it, so re-seat the panel under the arrow.
    if (panel.previousSibling !== arrowEl) {
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
        mutateArrow(function (t) {
          var s = t.steps.find(function (x) { return x.id === step.id; });
          if (s) s.done = box.checked;
        });
      });
      row.appendChild(box);

      row.appendChild(el('span', 'arrow-step-text', step.text));

      var del = el('button', 'arrow-step-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove step');
      del.addEventListener('click', function () {
        mutateArrow(function (t) {
          t.steps = t.steps.filter(function (x) { return x.id !== step.id; });
        });
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
