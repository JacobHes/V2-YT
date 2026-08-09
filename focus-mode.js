// =============================================================
// Focus mode: one screen, one arrow.
//
// The dashboard measured 2651px tall at phone width with 59 controls and only
// 5 of them above the fold. The arrow, the one thing the whole system is built
// around, sat seventh in the Today card behind a ring, a ticker, a streak,
// energy chips and a banner.
//
// This file rearranges what is already on the page. It does not rewrite
// main.html's logic and it does not own any state:
//   - the arrow moves to the top of the Today card
//   - the day ring and goal ticker move below it, from competing to reference
//   - loops, tomorrow and history collapse into disclosures with live counts
//
// Everything here MOVES existing nodes rather than rebuilding them, so the
// listeners main.html attached keep working and its re-renders (which replace
// list contents, never the cards) land where they always did.
// =============================================================
(function () {
  'use strict';

  var COLLAPSE_KEY = 'focus:open';   // which folds the user left open

  function openFolds() {
    try {
      var raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function rememberFold(id, isOpen) {
    var list = openFolds().filter(function (x) { return x !== id; });
    if (isOpen) list.push(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function byId(id) { return document.getElementById(id); }

  /**
   * Wrap a card in a disclosure.
   * `count` returns the badge text, or '' for no badge.
   */
  function fold(cardId, label, count) {
    var card = byId(cardId);
    if (!card || !card.parentNode || card.closest('.focus-fold')) return null;

    var details = document.createElement('details');
    details.className = 'focus-fold';
    details.dataset.foldId = cardId;
    if (openFolds().indexOf(cardId) !== -1) details.open = true;

    var summary = document.createElement('summary');
    summary.className = 'focus-summary';

    var name = document.createElement('span');
    name.className = 'focus-summary-label';
    name.textContent = label;

    var badge = document.createElement('span');
    badge.className = 'focus-summary-count';

    summary.appendChild(name);
    summary.appendChild(badge);
    details.appendChild(summary);

    card.parentNode.insertBefore(details, card);
    details.appendChild(card);

    details.addEventListener('toggle', function () {
      rememberFold(cardId, details.open);
    });

    return { details: details, badge: badge, count: count };
  }

  var folds = [];

  function refreshCounts() {
    folds.forEach(function (f) {
      if (!f) return;
      var value = '';
      try { value = f.count() || ''; } catch (e) { value = ''; }
      f.badge.textContent = value;
      f.badge.classList.toggle('is-zero', !value || value === '0');
    });
  }

  function textOf(id) {
    var node = byId(id);
    return node ? node.textContent.trim() : '';
  }

  function apply() {
    var today = byId('gmCardToday');
    if (!today) return;   // layout changed; leave the page alone

    document.body.classList.add('focus-mode');

    // 1. The arrow leads. It is rendered in place by main.html, so moving the
    //    container is enough and survives every re-render.
    var arrow = byId('gmArrow');
    if (arrow && arrow.parentNode === today) {
      today.insertBefore(arrow, today.firstChild);
    }
    // The cooked-day banner is what explains the arrow, so it rides with it.
    var cooked = byId('gmCookedBanner');
    if (cooked && arrow) today.insertBefore(cooked, arrow);

    // 2. Everything that is not today folds away, with its count still visible
    //    so nothing silently disappears.
    folds = [
      fold('gmCardLoops', 'Open loops', function () { return textOf('gmLoopsBadge'); }),
      fold('gmCardTomorrow', 'Plan ahead', function () {
        var sub = textOf('planSub');           // e.g. "2 planned"
        var n = /^\d+/.exec(sub);
        return n ? n[0] : '';
      }),
      fold('gmCardHistory', 'Past days', function () { return ''; }),
    ].filter(Boolean);

    // 3. Ring and ticker stop competing for the first screen. They keep their
    //    information but move to the foot of the page, after the folds, so the
    //    reading order is arrow, then work, then ambient day state.
    var page = today.closest('.page') || document.body;
    var ring = document.querySelector('.day-ring-wrap');
    var ticker = document.querySelector('.ticker-row');
    [ring, ticker].forEach(function (node) {
      if (node) page.appendChild(node);
    });

    refreshCounts();

    // main.html fires both of these whenever it rewrites a list.
    window.addEventListener('goals-changed', refreshCounts);
    window.addEventListener('storage', refreshCounts);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
