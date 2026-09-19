// =============================================================
// Row controls: pick the energy tag from a menu, flag a task urgent.
//
// Adds behaviour without editing main.html's JS:
//
//   - The energy tag was click-to-cycle (none, mover, prep, admin), so landing
//     on the one you wanted meant clicking past the ones you did not. A
//     capture-phase listener intercepts the click before main.html's own
//     handler sees it and opens a menu instead. main.html's cycling code is
//     untouched and still there if this file is removed.
//
//   - Urgent is a new per-task flag with no control in main.html, so the
//     button is injected into each rendered row and re-injected after every
//     re-render.
//
// Rows are addressed by the task id and list key main.html puts on each row
// (data-id, data-key), and every write reads the list fresh. A position in
// the list is never used: a sync merge can reorder or replace the list
// between the render and the click, and the menu stays open across renders.
//
// Writes go straight to goals:<date> and then dispatch a `storage` event,
// which main.html already listens for to re-render. Nothing here calls into
// main.html's internals.
// =============================================================
(function () {
  'use strict';

  var TAGS = [
    { value: 'mover', label: 'Mover' },
    { value: 'prep',  label: 'Prep' },
    { value: 'admin', label: 'Admin' },
    { value: null,    label: 'No tag' },
  ];

  function pad2(n) { return String(n).padStart(2, '0'); }
  // Must match main.html: the day flips at 06:00.
  function activeKey() {
    var now = new Date();
    var d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return 'goals:' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function readList(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : null; }
    catch (e) { return null; }
  }

  function findById(list, id) {
    if (!list || id == null || id === '') return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id != null && String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  // The list a row belongs to, as main.html rendered it.
  function rowKey(row) { return (row && row.dataset.key) || activeKey(); }

  /** Mutate one task by id in a fresh read, and let main.html re-render itself. */
  function updateTask(key, id, mutate) {
    var list = readList(key);
    var task = findById(list, id);
    if (!task) return false;
    mutate(task);
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { return false; }
    // main.html re-renders on `storage`; sync.js carries it to Supabase.
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(new CustomEvent('goals-changed'));
    return true;
  }

  // ---------- energy menu ----------

  var menu = null;

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }

  function openMenu(button, key, id, current) {
    closeMenu();

    menu = document.createElement('div');
    menu.className = 'hud-tagmenu';

    TAGS.forEach(function (tag) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'hud-tagmenu-item' + (tag.value ? ' hud-tagmenu-' + tag.value : ' hud-tagmenu-none');
      if (current === tag.value) item.classList.add('is-current');
      item.textContent = tag.label;
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        updateTask(key, id, function (task) {
          if (tag.value) task.energy = tag.value;
          else delete task.energy;
        });
        closeMenu();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Anchor to the button, then pull back inside the viewport if it would
    // hang off the edge on a narrow screen.
    var r = button.getBoundingClientRect();
    var top = r.bottom + window.scrollY + 6;
    var left = r.left + window.scrollX;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    var m = menu.getBoundingClientRect();
    if (m.right > window.innerWidth - 8) {
      menu.style.left = Math.max(8, window.innerWidth - m.width - 8 + window.scrollX) + 'px';
    }
    if (m.bottom > window.innerHeight + window.scrollY - 8) {
      menu.style.top = (r.top + window.scrollY - m.height - 6) + 'px';
    }
  }

  // Capture phase, so this runs before the cycling handler main.html bound to
  // the button itself. stopPropagation keeps that handler from ever firing.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.gm-energy-btn');
    if (btn && btn.closest('#goalList')) {
      var row = btn.closest('.gm-row');
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      var key = rowKey(row);
      var id = row.dataset.id;
      var task = findById(readList(key), id);
      if (!task) return;
      openMenu(btn, key, id, task.energy || null);
      return;
    }
    if (menu && !e.target.closest('.hud-tagmenu')) closeMenu();
  }, true);

  window.addEventListener('resize', closeMenu);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  // ---------- urgent flag ----------

  var decorating = false;

  function decorate() {
    var list = document.getElementById('goalList');
    if (!list || decorating) return;

    decorating = true;
    var lists = {};   // one fresh read per key per pass
    Array.prototype.forEach.call(list.querySelectorAll('.gm-row'), function (row) {
      var key = rowKey(row);
      if (!(key in lists)) lists[key] = readList(key);
      var task = findById(lists[key], row.dataset.id);
      if (!task) return;

      row.classList.toggle('is-urgent', !!task.urgent);

      var btn = row.querySelector('.hud-urgent-btn');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hud-urgent-btn';
        btn.textContent = '!';
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          // Flip what the button shows, on whichever task has this id now.
          var want = !btn.classList.contains('is-on');
          updateTask(rowKey(row), row.dataset.id, function (t) {
            if (want) t.urgent = true; else delete t.urgent;
          });
        });
        // Sits with the other row controls, before the delete button.
        var del = row.querySelector('.goal-delete');
        if (del) row.insertBefore(btn, del); else row.appendChild(btn);
      }
      btn.classList.toggle('is-on', !!task.urgent);
      btn.title = task.urgent ? 'Urgent. Click to clear.' : 'Mark urgent';
      btn.setAttribute('aria-pressed', task.urgent ? 'true' : 'false');
    });
    decorating = false;
  }

  function start() {
    var list = document.getElementById('goalList');
    if (!list) return;
    decorate();
    new MutationObserver(function () {
      if (decorating) return;
      decorate();
    }).observe(list, { childList: true, subtree: true });
    window.addEventListener('goals-changed', decorate);
    window.addEventListener('storage', decorate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
