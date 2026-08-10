// =============================================================
// Grant, client side. Loaded by main.html as a plain script.
//
// Three jobs:
//   1. ADAPTER  — turn what main.html already stores into the typed payload
//                 the /api/grant contract defines. Grant reads this; he never
//                 guesses at it, so anything we cannot honestly fill is null
//                 rather than invented.
//   2. TRANSPORT— POST to /api/grant and render the SSE stream as it arrives.
//   3. PANEL    — the five flows, as a card in the existing gm-card grid.
//
// Deliberately reads the same localStorage keys main.html owns rather than
// duplicating state: goals:<date>, plan:<date>, energy:<date>, debrief:<date>,
// loops:open, plus daily:<date> from the daily tracker page.
// =============================================================
(function () {
  'use strict';

  var ENDPOINT = '/api/grant';
  var HISTORY_KEY = 'grant:history';   // not in syncedPrefixes, stays local
  var MAX_STORED_TURNS = 40;

  // ---------- storage (mirrors main.html's helpers) ----------
  function storeGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    if (typeof key === 'string' && key.indexOf('goals:') === 0) {
      window.dispatchEvent(new CustomEvent('goals-changed'));
    }
  }
  function storeListKeys(prefix) {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) out.push(k);
    }
    return out;
  }

  // ---------- dates (must match main.html: the day flips at 06:00) ----------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateToKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function activeDate() {
    var now = new Date();
    if (now.getHours() < 6) {
      var d = new Date(now);
      d.setDate(d.getDate() - 1);
      return dateToKey(d);
    }
    return dateToKey(now);
  }
  function tomorrowDate() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() >= 6) d.setDate(d.getDate() + 1);
    return dateToKey(d);
  }
  function daysBetween(fromStr, toStr) {
    var a = fromStr.split('-').map(Number), b = toStr.split('-').map(Number);
    return Math.round((new Date(b[0], b[1] - 1, b[2]) - new Date(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function getGoals(dateStr) {
    var g = storeGet('goals:' + dateStr);
    return Array.isArray(g) ? g : [];
  }

  // ---------- adapter ----------

  // main.html tags energy as mover/prep/admin; the contract wants MOVER/PREP/ADMIN.
  function toTag(energy) {
    return energy ? String(energy).toUpperCase() : null;
  }

  // A task carries no createdAt, but rollover copies it forward by text, so the
  // oldest goals: date holding the same text is when it first appeared. That is
  // the number the doctrine cares about: how long it has been sitting.
  function ageDaysFor(task, todayStr) {
    if (!task.text) return null;
    var earliest = null;
    storeListKeys('goals:').forEach(function (key) {
      var dateStr = key.slice('goals:'.length);
      if (dateStr > todayStr) return;
      var hit = getGoals(dateStr).some(function (g) {
        return g.id === task.id || g.text === task.text;
      });
      if (hit && (earliest === null || dateStr < earliest)) earliest = dateStr;
    });
    return earliest === null ? null : daysBetween(earliest, todayStr);
  }

  // Grant needs to tell an aimed-but-never-fired arrow from a landed one, so the
  // debrief can be honest about which happened.
  function statusFor(task, isPastCutoff) {
    if (task.done) return 'done';
    if (task.firedAt) return 'fired';
    if (task.arrow && isPastCutoff) return 'UNFIRED';
    return 'open';
  }

  function breakpointFor(task) {
    var note = task.breakpoint;
    if (!note || typeof note !== 'object') return null;
    var any = note.whereAmI || note.thinking || note.nextStep || note.context;
    return any
      ? {
          whereAmI: note.whereAmI || '',
          thinking: note.thinking || '',
          nextStep: note.nextStep || '',
          context: note.context || '',
        }
      : null;
  }

  // Streak = consecutive days the arrow LANDED, matching main.html's
  // processStreak(). Task count is deliberately not what this measures.
  function arrowStreak(todayStr) {
    var dates = storeListKeys('goals:')
      .map(function (k) { return k.slice('goals:'.length); })
      .filter(function (d) { return d <= todayStr; })
      .sort();
    var count = 0;
    dates.forEach(function (dateStr) {
      var arrow = getGoals(dateStr).find(function (g) { return g.arrow; });
      if (arrow && arrow.done) count += 1;
      else if (dateStr < todayStr) count = 0;   // today is still in play
    });
    return count;
  }

  // Sleep, bedtime and meditation live on the daily tracker page under
  // daily:<date>. Same origin, so we can read them without a round trip.
  function trackerFor(dateStr) {
    var day = storeGet('daily:' + dateStr) || {};
    var out = {};
    if (day.bedTime) out.bedtime = day.bedTime;
    if (day.wakeTime) out.wakeTime = day.wakeTime;
    if (day.bedTime && day.wakeTime) {
      var bed = day.bedTime.split(':').map(Number);
      var wake = day.wakeTime.split(':').map(Number);
      var mins = wake[0] * 60 + wake[1] - (bed[0] * 60 + bed[1]);
      if (mins <= 0) mins += 24 * 60;
      out.sleepHours = Math.round((mins / 60) * 10) / 10;
    }
    if (day.meditation !== undefined && day.meditation !== '') {
      out.meditationMin = Number(day.meditation);
    }
    var plan = storeGet('plan:' + dateStr);
    out.planLocked = !!(plan && plan.locked);
    return out;
  }

  // energy:<date> stores one value per day, not an hourly series, so there is
  // no real curve to send. Null is honest; a fabricated curve would have Grant
  // timing the arrow against noise.
  function energyCurve() {
    return null;
  }

  function openLoops() {
    var loops = storeGet('loops:open');
    return Array.isArray(loops)
      ? loops.map(function (l) { return { text: l.text, closed: false }; })
      : [];
  }

  /**
   * Build the payload for one call.
   * @param {string} mode  night_before | morning | midday | debrief | adhoc
   * @param {string} message
   */
  function buildPayload(mode, message) {
    var todayStr = activeDate();
    // The night-before flow plans tomorrow, so it must read tomorrow's list.
    var targetDate = mode === 'night_before' ? tomorrowDate() : todayStr;
    var goals = getGoals(targetDate);
    var pastCutoff = new Date().getHours() >= 21 || mode === 'debrief';

    var tasks = goals.map(function (g) {
      return {
        id: g.id,
        title: g.text,
        tag: toTag(g.energy),
        category: g.category || null,   // set from the panel; never inferred
        ageDays: ageDaysFor(g, todayStr),
        isArrow: !!g.arrow,
        status: statusFor(g, pastCutoff),
        breakpointNote: breakpointFor(g),
        steps: Array.isArray(g.steps)
          ? g.steps.map(function (x) { return { text: x.text, done: !!x.done }; })
          : null,
      };
    });

    var arrow = goals.find(function (g) { return g.arrow; });

    return {
      mode: mode,
      now: new Date().toISOString(),
      energy: storeGet('energy:' + todayStr) || null,
      tasks: tasks,
      arrow: arrow ? arrow.id : null,
      arrowStreak: arrowStreak(todayStr),
      tracker: trackerFor(todayStr),
      energyCurve: energyCurve(),
      openLoops: openLoops(),
      history: loadHistory(),
      message: message || '',
    };
  }

  // ---------- history (the app owns it; Grant has no memory between calls) ----------
  //
  // grant:history  is the session in progress.
  // grant:sessions is the archive: [{id, startedAt, endedAt, title, turns}].
  // "New session" files the current one instead of throwing it away.
  var SESSIONS_KEY = 'grant:sessions';
  var MAX_SESSIONS = 30;

  function loadHistory() {
    var h = storeGet(HISTORY_KEY);
    return Array.isArray(h) ? h : [];
  }
  function pushHistory(role, content) {
    var h = loadHistory();
    h.push({ role: role, content: content });
    storeSet(HISTORY_KEY, h.slice(-MAX_STORED_TURNS));
  }
  /** Replace the whole transcript, used after a tool round-trip. */
  function setHistory(turns) {
    storeSet(HISTORY_KEY, turns.slice(-MAX_STORED_TURNS));
  }

  function loadSessions() {
    var s = storeGet(SESSIONS_KEY);
    return Array.isArray(s) ? s : [];
  }

  function turnText(turn) {
    if (Array.isArray(turn.content)) {
      return turn.content
        .map(function (b) { return b.type === 'text' ? b.text : ''; })
        .filter(Boolean).join(' ');
    }
    return String(turn.content || '');
  }

  /** File the running session and start an empty one. */
  function archiveSession() {
    var turns = loadHistory();
    if (turns.length) {
      var first = turns.find(function (t) { return t.role === 'user'; });
      var title = first ? turnText(first).slice(0, 60) : 'Session';
      var sessions = loadSessions();
      sessions.push({
        id: 'gs' + Date.now().toString(36),
        startedAt: Date.now(),
        title: title,
        turns: turns,
      });
      storeSet(SESSIONS_KEY, sessions.slice(-MAX_SESSIONS));
    }
    storeSet(HISTORY_KEY, []);
  }

  // ---------- transport ----------

  /**
   * POST the payload and stream the reply.
   * onDelta(text) fires per chunk; onDone({sectionIds, usage}) at the end.
   */
  async function ask(payload, onDelta, onDone, onError) {
    var response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      onError('Could not reach Grant. Check the connection.');
      return;
    }

    // A non-streaming error (bad payload, missing key) comes back as JSON.
    if (!response.ok) {
      var detail = '';
      try { detail = (await response.json()).error || ''; } catch (e) {}
      onError(detail || ('Grant returned ' + response.status));
      return;
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var meta = {};

    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE frames are separated by a blank line. Anything after the last
      // separator is a partial frame, so it stays in the buffer.
      var frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (var i = 0; i < frames.length; i++) {
        var lines = frames[i].split('\n');
        var event = '';
        var dataRaw = '';
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('event: ') === 0) event = lines[j].slice(7);
          else if (lines[j].indexOf('data: ') === 0) dataRaw += lines[j].slice(6);
        }
        if (!event || !dataRaw) continue;

        var data;
        try { data = JSON.parse(dataRaw); } catch (e) { continue; }

        if (event === 'meta') meta = data;
        else if (event === 'delta') onDelta(data.text);
        else if (event === 'error') { onError(data.message); return; }
        else if (event === 'done') { onDone(Object.assign({}, meta, data)); return; }
      }
    }

    // Stream ended without a done frame: the function was cut off mid-reply.
    onError('Grant was cut off before finishing.');
  }

  // ---------- panel ----------
  // Visual language carried over from the old Nova tile: floating orb, italic
  // serif wordmark, accent-edged reply bubbles, animated thinking dots.
  var els = {};
  var busy = false;

  var FLOWS = [
    { mode: 'night_before', label: 'Plan tomorrow', prompt: 'Plan tomorrow with me.' },
    { mode: 'morning', label: 'Morning', prompt: 'No plan locked. What am I doing today?' },
    { mode: 'midday', label: 'Energy check', prompt: 'Energy check in.' },
    { mode: 'adhoc', label: "I'm stuck", prompt: "I can't start. I'm stalling on the arrow." },
    { mode: 'debrief', label: 'Debrief', prompt: 'Debrief the day.' },
  ];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- reply formatting ----------
  // Grant writes short paragraphs and "- " bullets. Rendering them as real
  // paragraphs and lists is most of what makes the panel readable.
  //
  // Everything is HTML-escaped BEFORE any markup is added, so model output can
  // never inject an element. Only the three patterns below become markup.
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(str) {
    return esc(str)
      // "RULE BLOCK 2" is the doctrine citation Grant is told to name.
      .replace(/\b(RULE BLOCK \d+)/g, '<span class="grant-rule">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, '<span class="grant-strong">$1</span>');
  }

  function formatReply(text) {
    var blocks = String(text).trim().split(/\n{2,}/);
    var html = '';

    blocks.forEach(function (block) {
      var lines = block.split('\n');
      var buffer = [];
      var items = [];

      function flushText() {
        if (buffer.length) { html += '<p>' + inline(buffer.join(' ')) + '</p>'; buffer = []; }
      }
      function flushList() {
        if (items.length) { html += '<ul>' + items.join('') + '</ul>'; items = []; }
      }

      lines.forEach(function (line) {
        var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (bullet) {
          flushText();
          items.push('<li>' + inline(bullet[1]) + '</li>');
        } else if (line.trim()) {
          flushList();
          buffer.push(line.trim());
        }
      });
      flushText();
      flushList();
    });

    return html;
  }

  // Full section ids are long enough to wrap the footer onto three lines.
  // The file prefix and leading numbering carry no meaning at a glance.
  function shortSectionId(id) {
    var slug = String(id).split('#')[1] || id;
    slug = slug.replace(/^(part-)?[a-z0-9]+-/, '');
    return slug.length > 30 ? slug.slice(0, 29) + '…' : slug;
  }

  function setOrb(state) {
    if (!els.orb) return;
    els.orb.classList.toggle('is-thinking', state === 'thinking');
    els.orb.classList.toggle('is-done', state === 'done');
  }

  /** Append a message. Returns the bubble so a streaming reply can fill it. */
  function addMessage(role, text) {
    var msg = el('div', 'grant-msg grant-msg-' + role);
    var bubble = el('div', 'grant-bubble');

    if (role === 'grant') {
      bubble.appendChild(el('span', 'grant-tag', 'Grant'));
      var body = el('div', 'grant-body');
      if (text) body.innerHTML = formatReply(text);
      bubble.appendChild(body);
      msg.appendChild(bubble);
      els.log.appendChild(msg);
      els.log.scrollTop = els.log.scrollHeight;
      return { bubble: bubble, body: body };
    }

    bubble.textContent = text || '';
    msg.appendChild(bubble);
    els.log.appendChild(msg);
    els.log.scrollTop = els.log.scrollHeight;
    return { bubble: bubble, body: bubble };
  }

  function showDots(body) {
    body.innerHTML = '';
    var dots = el('span', 'grant-dots');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    body.appendChild(dots);
  }

  function setBusy(state) {
    busy = state;
    els.send.disabled = state;
    els.input.disabled = state;
    Array.prototype.forEach.call(els.flows.children, function (b) { b.disabled = state; });
  }

  /** Ask before a tool that is hard to undo. */
  function confirmAction(question) {
    return new Promise(function (resolve) {
      resolve(window.confirm(question));
    });
  }

  var MAX_TOOL_ROUNDS = 4;   // a stuck model must not loop on the tracker

  async function run(mode, message) {
    if (busy) return;
    var text = (message || '').trim();
    if (!text) return;

    setBusy(true);
    setOrb('thinking');
    addMessage('user', text);
    pushHistory('user', text);

    var slot = addMessage('grant', '');
    showDots(slot.body);

    var reply = '';
    var started = false;
    var lastInfo = null;
    var failed = false;
    var round = 0;
    // First call carries the message; later rounds carry only tool results.
    var pending = text;

    while (round <= MAX_TOOL_ROUNDS && !failed) {
      var payload = buildPayload(mode, pending);
      payload.history = loadHistory();
      var toolUse = null;
      var assistantContent = null;

      /* eslint-disable no-loop-func */
      await ask(
        payload,
        function onDelta(delta) {
          if (!started) { slot.body.innerHTML = ''; started = true; }
          reply += delta;
          slot.body.innerHTML = formatReply(reply);
          els.log.scrollTop = els.log.scrollHeight;
        },
        function onDone(info) {
          lastInfo = info;
          toolUse = info.toolUse || [];
          assistantContent = info.assistantContent || null;
        },
        function onError(message) {
          slot.bubble.classList.add('is-error');
          slot.body.textContent = message;
          failed = true;
        }
      );
      /* eslint-enable no-loop-func */

      if (failed || !toolUse || !toolUse.length) break;

      // Grant asked to change something. Do it here, where the data lives.
      slot.body.innerHTML = formatReply(reply || '') ;
      var note = document.createElement('div');
      note.className = 'grant-acting';
      note.textContent = 'working…';
      slot.body.appendChild(note);

      var outcome = await window.GrantActions.runTools(toolUse, confirmAction);
      if (note.parentNode) note.parentNode.removeChild(note);

      // The API needs the assistant turn that requested the tools, then the
      // results, before it will continue.
      var h = loadHistory();
      h.push({ role: 'assistant', content: assistantContent });
      h.push({ role: 'user', content: outcome.results });
      setHistory(h);

      if (outcome.applied.length) {
        var done = document.createElement('div');
        done.className = 'grant-applied';
        done.textContent = 'applied: ' + outcome.applied.join(', ');
        slot.body.appendChild(done);
      }

      pending = '';     // the tool results are the next turn
      round += 1;
    }

    if (!failed) {
      if (reply) pushHistory('assistant', reply);
      setOrb('done');
      setTimeout(function () { setOrb(null); }, 2200);
      var ids = (lastInfo && lastInfo.sectionIds) || [];
      els.meta.textContent = ids.length
        ? 'doctrine · ' + ids.map(shortSectionId).join('  ·  ')
        : 'doctrine · none loaded';
    } else {
      setOrb(null);
    }
    setBusy(false);
  }

  function renderHistoryList() {
    if (!els.history) return;
    els.history.textContent = '';
    var sessions = loadSessions().slice().reverse();
    if (!sessions.length) {
      els.history.appendChild(el('div', 'grant-history-empty', 'No past sessions yet.'));
      return;
    }
    sessions.forEach(function (session) {
      var item = el('button', 'grant-history-item');
      item.type = 'button';
      var when = new Date(session.startedAt);
      item.appendChild(el('span', 'grant-history-when',
        when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')));
      item.appendChild(el('span', 'grant-history-title', session.title));
      item.addEventListener('click', function () {
        // Read-only replay: the running session is not touched.
        els.log.textContent = '';
        session.turns.forEach(function (turn) {
          var text = turnText(turn);
          if (text) addMessage(turn.role === 'user' ? 'user' : 'grant', text);
        });
        els.meta.textContent = 'viewing an archived session, read only';
        els.history.classList.remove('is-open');
      });
      els.history.appendChild(item);
    });
  }

  function mount() {
    var today = document.getElementById('gmCardToday');
    if (!today || !today.parentNode) return;   // layout changed; fail quiet

    var card = el('div', 'gm-card grant-card');
    card.id = 'gmCardGrant';

    var head = el('div', 'grant-head');
    els.orb = el('div', 'grant-orb');
    head.appendChild(els.orb);

    var wordmark = el('div', 'grant-wordmark');
    wordmark.appendChild(el('div', 'grant-title', 'Grant'));
    head.appendChild(wordmark);

    var historyBtn = el('button', 'grant-reset', 'History');
    historyBtn.type = 'button';
    head.appendChild(historyBtn);
    var reset = el('button', 'grant-reset', 'New session');
    reset.type = 'button';
    head.appendChild(reset);
    card.appendChild(head);

    els.history = el('div', 'grant-history');
    card.appendChild(els.history);

    els.flows = el('div', 'grant-flows');
    FLOWS.forEach(function (flow) {
      var button = el('button', 'grant-flow', flow.label);
      button.type = 'button';
      button.addEventListener('click', function () { run(flow.mode, flow.prompt); });
      els.flows.appendChild(button);
    });
    card.appendChild(els.flows);

    els.log = el('div', 'grant-log');
    card.appendChild(els.log);

    els.meta = el('div', 'grant-meta', '');
    card.appendChild(els.meta);

    var composer = el('div', 'grant-composer');
    els.input = el('input');
    els.input.type = 'text';
    els.input.placeholder = 'Ask Grant…';
    els.input.autocomplete = 'off';
    els.send = el('button', null, '↑');
    els.send.type = 'button';
    els.send.setAttribute('aria-label', 'Send');
    composer.appendChild(els.input);
    composer.appendChild(els.send);
    card.appendChild(composer);

    function submit() {
      var text = els.input.value.trim();
      if (!text) return;
      els.input.value = '';
      run('adhoc', text);
    }
    els.send.addEventListener('click', submit);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    reset.addEventListener('click', function () {
      archiveSession();
      els.log.innerHTML = '';
      els.meta.textContent = '';
      renderHistoryList();
    });
    historyBtn.addEventListener('click', function () {
      els.history.classList.toggle('is-open');
      if (els.history.classList.contains('is-open')) renderHistoryList();
    });

    today.parentNode.insertBefore(card, today.nextSibling);

    // Replay this session so a reload does not look like Grant forgot.
    loadHistory().slice(-8).forEach(function (turn) {
      addMessage(turn.role === 'user' ? 'user' : 'grant', turn.content);
    });
  }

  // Exposed so the console and any future UI can drive the same code path.
  window.Grant = {
    buildPayload: buildPayload,
    ask: ask,
    run: run,
    archiveSession: archiveSession,
    loadSessions: loadSessions,
    /** Set CLIENT / INNER_WORK on a task. The jump-ship rule depends on it. */
    setCategory: function (dateStr, id, category) {
      var key = 'goals:' + dateStr;
      var list = storeGet(key);
      if (!Array.isArray(list)) return;
      list.forEach(function (g) {
        if (g.id !== id) return;
        if (category) g.category = category;
        else delete g.category;
      });
      storeSet(key, list);
    },
    /** Capture a breakpoint note when a MOVER is stopped mid-stream. */
    setBreakpoint: function (dateStr, id, note) {
      var key = 'goals:' + dateStr;
      var list = storeGet(key);
      if (!Array.isArray(list)) return;
      list.forEach(function (g) { if (g.id === id) g.breakpoint = note; });
      storeSet(key, list);
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
