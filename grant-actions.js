// =============================================================
// Executes the tools Grant calls, in the browser, against the same
// localStorage main.html owns.
//
// Grant's tools run here rather than on the server because that is where the
// data is. The server sends back tool_use blocks, this file performs them and
// hands the results back, and main.html re-renders off the `storage` event it
// already listens for. No function in main.html is called or changed.
//
// Moving and deleting ask first. Everything else applies straight away,
// because adding a task or a tag is cheap to undo and losing work is not.
// =============================================================
(function () {
  'use strict';

  var CONFIRM = ['push_task', 'delete_task'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateToKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  // Both must match main.html: the day flips at 06:00.
  function todayKey() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return dateToKey(d);
  }
  function tomorrowKey() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() >= 6) d.setDate(d.getDate() + 1);
    return dateToKey(d);
  }
  function dayKey(day) { return day === 'tomorrow' ? tomorrowKey() : todayKey(); }

  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function write(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { return false; }
    return true;
  }
  // One notification after a batch of tools, so main.html re-renders once.
  function notifyChanged() {
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(new CustomEvent('goals-changed'));
  }

  function genId() {
    return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  /** Find a task by id across today and tomorrow. */
  function locate(taskId) {
    var keys = ['goals:' + todayKey(), 'goals:' + tomorrowKey()];
    for (var i = 0; i < keys.length; i++) {
      var list = read(keys[i]);
      var idx = list.findIndex(function (g) { return g.id === taskId; });
      if (idx !== -1) return { key: keys[i], list: list, idx: idx, task: list[idx] };
    }
    return null;
  }

  function ok(data) { return { ok: true, result: data }; }
  function fail(message) { return { ok: false, result: { error: message } }; }

  var HANDLERS = {
    add_task: function (input) {
      var key = 'goals:' + dayKey(input.day);
      var list = read(key);
      var task = { id: genId(), text: String(input.title || '').trim(), bornOn: todayKey() };
      if (!task.text) return fail('title was empty');
      if (input.tag && input.tag !== 'NONE') task.energy = String(input.tag).toLowerCase();
      if (input.category) task.category = input.category;
      if (input.urgent) task.urgent = true;
      list.push(task);
      if (!write(key, list)) return fail('could not save');
      return ok({ task_id: task.id, day: input.day || 'today' });
    },

    set_tag: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      if (input.tag === 'NONE') delete f.task.energy;
      else f.task.energy = String(input.tag).toLowerCase();
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, tag: input.tag });
    },

    set_category: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      f.task.category = input.category;
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, category: input.category });
    },

    aim_arrow: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      // One arrow per day, so clear every other task in that day's list.
      f.list.forEach(function (g) {
        if (g.id === input.task_id) { g.arrow = true; if (!g.aimedCount) g.aimedCount = 1; }
        else delete g.arrow;
      });
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, arrow: true });
    },

    set_urgent: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      if (input.urgent) f.task.urgent = true; else delete f.task.urgent;
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, urgent: !!input.urgent });
    },

    complete_task: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      if (input.done) { f.task.done = true; f.task.doneAt = Date.now(); }
      else { delete f.task.done; delete f.task.doneAt; }
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, done: !!input.done });
    },

    set_day_energy: function (input) {
      var key = 'energy:' + todayKey();
      try {
        if (input.energy === 'none') localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(input.energy));
      } catch (e) { return fail('could not save'); }
      return ok({ energy: input.energy });
    },

    add_loop: function (input) {
      var text = String(input.text || '').trim();
      if (!text) return fail('text was empty');
      var loops = read('loops:open');
      loops.push({ id: genId(), text: text, createdAt: Date.now() });
      if (!write('loops:open', loops)) return fail('could not save');
      return ok({ text: text });
    },

    capture_breakpoint: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      f.task.breakpoint = {
        whereAmI: input.whereAmI || '',
        thinking: input.thinking || '',
        nextStep: input.nextStep || '',
        context: input.context || '',
      };
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id });
    },

    add_step: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      var text = String(input.text || '').trim();
      if (!text) return fail('text was empty');
      if (!Array.isArray(f.task.steps)) f.task.steps = [];
      f.task.steps.push({ id: genId(), text: text, done: false });
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, steps: f.task.steps.length });
    },

    complete_step: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      var steps = Array.isArray(f.task.steps) ? f.task.steps : [];
      var want = String(input.text || '').trim().toLowerCase();
      var step = steps.find(function (s) { return String(s.text).trim().toLowerCase() === want; });
      if (!step) return fail('no step with that text');
      step.done = !!input.done;
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ task_id: input.task_id, text: step.text, done: step.done });
    },

    push_task: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      var destKey = 'goals:' + dayKey(input.day);
      if (destKey === f.key) return fail('already on that day');
      var moved = f.list.splice(f.idx, 1)[0];
      delete moved.arrow;   // the arrow belongs to a day, not to the task
      var dest = read(destKey);
      dest.push(moved);
      if (!write(f.key, f.list) || !write(destKey, dest)) return fail('could not save');
      return ok({ task_id: input.task_id, day: input.day });
    },

    delete_task: function (input) {
      var f = locate(input.task_id);
      if (!f) return fail('no task with that id');
      var removed = f.list.splice(f.idx, 1)[0];
      if (!write(f.key, f.list)) return fail('could not save');
      return ok({ deleted: removed.text });
    },
  };

  /** Human-readable line for the confirmation prompt. */
  function describe(name, input) {
    var f = input.task_id ? locate(input.task_id) : null;
    var title = f ? f.task.text : input.task_id;
    if (name === 'push_task') return 'Move "' + title + '" to ' + input.day + '?';
    if (name === 'delete_task') return 'Delete "' + title + '" for good?';
    return name;
  }

  /**
   * Run one batch of tool_use blocks.
   * Returns the tool_result blocks to send back, plus a short list of what
   * actually changed so the panel can show it.
   */
  async function runTools(blocks, confirmFn) {
    var results = [];
    var applied = [];
    var touched = false;

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var handler = HANDLERS[block.name];
      var outcome;

      if (!handler) {
        outcome = fail('unknown tool: ' + block.name);
      } else if (CONFIRM.indexOf(block.name) !== -1) {
        var allowed = await confirmFn(describe(block.name, block.input || {}));
        outcome = allowed
          ? handler(block.input || {})
          : { ok: false, result: { declined: true, error: 'Jacob declined this one.' } };
      } else {
        outcome = handler(block.input || {});
      }

      if (outcome.ok) { touched = true; applied.push(block.name); }

      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(outcome.result),
        is_error: !outcome.ok,
      });
    }

    if (touched) notifyChanged();
    return { results: results, applied: applied };
  }

  window.GrantActions = { runTools: runTools, describe: describe, CONFIRM: CONFIRM };
})();
