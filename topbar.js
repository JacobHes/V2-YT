// =============================================================
// Shared chrome: the top bar with the menu, and the bottom tab bar.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It injects its own HTML and CSS. It holds no data and talks to nothing.
//
// The look is the lab theme's: walnut bars, a chalkboard drawer, typed
// labels. Tokens come from lab-theme.css; every var() carries a fallback so
// a page that has not loaded the theme yet still gets a usable bar.
// =============================================================
(function () {
  'use strict';

  // Every page, in the order the drawer lists them. `blurb` is the one line
  // that says what the page is for; the manual (guide.html) says the rest.
  const PAGES = [
    { href: 'main.html',     key: 'main',     label: 'Main',          blurb: "Today's arrow, the task list, plan tomorrow" },
    { href: 'daily.html',    key: 'daily',    label: 'Daily tracker', blurb: 'The daily log and the 30-day challenge' },
    { href: 'track.html',    key: 'track',    label: 'Timer',         blurb: 'Time tracking by project' },
    { href: 'finance.html',  key: 'finance',  label: 'Finance',       blurb: 'Net worth, subscriptions, spending' },
    { href: 'gym.html',      key: 'fitness',  label: 'Fitness',       blurb: 'Progressive overload log' },
    { href: 'health.html',   key: 'health',   label: 'Supplements',   blurb: 'The daily stack and WHOOP' },
    { href: 'caffeine.html', key: 'caffeine', label: 'Caffeine',      blurb: 'Intake and the crash curve' },
    { href: 'index.html',    key: 'hub',      label: 'Hub',           blurb: 'Every page as a tile' },
    { href: 'guide.html',    key: 'guide',    label: 'How this works', blurb: 'What each page is for and how the pieces connect' },
  ];

  // -------- CSS --------
  const css = `
.topbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px;
  padding: max(10px, env(safe-area-inset-top)) 16px 10px;
  background: var(--lab-wood, #2B2219);
  border-bottom: 1px solid var(--lab-wood-edge, #1A140E);
  box-shadow: 0 1px 0 rgba(233, 226, 208, 0.08) inset;
  font-family: var(--lab-type, 'American Typewriter', 'Courier New', monospace);
}
.topbar-brand {
  display: inline-flex; align-items: baseline; gap: 10px;
  min-width: 0;
  color: var(--lab-chalk, #E9E2D0);
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}
.topbar-brand-name {
  font-family: var(--lab-display, Futura, 'Trebuchet MS', sans-serif);
  font-size: 13px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  white-space: nowrap;
}
.topbar-brand-page {
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--lab-chalk-dim, rgba(233,226,208,0.62));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.topbar-menu-btn {
  display: inline-flex; align-items: center; gap: 10px;
  min-height: 40px; padding: 8px 12px;
  border: 1px solid rgba(233, 226, 208, 0.35);
  border-radius: 2px;
  background: transparent;
  color: var(--lab-chalk, #E9E2D0);
  font-family: inherit; font-size: 10.5px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.topbar-menu-btn:hover { border-color: var(--lab-chalk, #E9E2D0); }
.topbar-menu-lines { display: inline-flex; flex-direction: column; gap: 4px; width: 18px; }
.topbar-menu-lines i { display: block; height: 2px; background: currentColor; }

/* The drawer: a chalkboard slid over the desk. */
.nav-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(20, 14, 6, 0.55);
  opacity: 0; pointer-events: none;
  transition: opacity 0.2s;
}
.nav-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 61;
  width: min(360px, 100%);
  display: flex; flex-direction: column;
  padding: max(14px, env(safe-area-inset-top)) 0 max(18px, env(safe-area-inset-bottom));
  background: var(--lab-board, #1E2822);
  border-left: 1px solid rgba(233, 226, 208, 0.12);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.45);
  font-family: var(--lab-type, 'American Typewriter', 'Courier New', monospace);
  color: var(--lab-chalk, #E9E2D0);
  transform: translateX(100%);
  transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  overflow-y: auto;
  overscroll-behavior: contain;
}
body.nav-open .nav-backdrop { opacity: 1; pointer-events: auto; }
body.nav-open .nav-drawer { transform: translateX(0); }
body.nav-open { overflow: hidden; }
.nav-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 18px 14px 22px;
  border-bottom: 1px solid rgba(233, 226, 208, 0.16);
}
.nav-title {
  font-family: var(--lab-display, Futura, 'Trebuchet MS', sans-serif);
  font-size: 12px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--lab-chalk-dim, rgba(233,226,208,0.62));
}
.nav-close {
  min-width: 40px; min-height: 40px;
  border: 1px solid rgba(233, 226, 208, 0.35); border-radius: 2px;
  background: transparent; color: var(--lab-chalk, #E9E2D0);
  font-family: inherit; font-size: 16px; line-height: 1; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.nav-list { list-style: none; margin: 0; padding: 8px 0; }
.nav-item a {
  display: block;
  padding: 13px 22px 12px;
  text-decoration: none;
  color: var(--lab-chalk, #E9E2D0);
  border-left: 3px solid transparent;
  -webkit-tap-highlight-color: transparent;
}
.nav-item a:hover { background: rgba(233, 226, 208, 0.06); }
.nav-item a:focus { outline: none; }
.nav-item a:focus-visible { outline: 1px solid var(--lab-chalk, #E9E2D0); outline-offset: -4px; }
.topbar-menu-btn:focus, .nav-close:focus { outline: none; }
.topbar-menu-btn:focus-visible, .nav-close:focus-visible { outline: 1px solid var(--lab-chalk, #E9E2D0); outline-offset: 2px; }
.nav-item.active a { border-left-color: var(--lab-chalk, #E9E2D0); background: rgba(233, 226, 208, 0.08); }
.nav-item-label {
  display: block;
  font-family: var(--lab-display, Futura, 'Trebuchet MS', sans-serif);
  font-size: 15px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase;
}
.nav-item-blurb {
  display: block; margin-top: 3px;
  font-size: 12px; line-height: 1.4;
  color: var(--lab-chalk-dim, rgba(233,226,208,0.62));
}
.nav-item.guide { margin-top: 8px; border-top: 1px solid rgba(233, 226, 208, 0.16); padding-top: 8px; }

/* Room for the fixed top bar: reserve exactly its measured height (set by
   reserveTop as --topbar-h), so no page has to know the bar exists. */
body.has-topbar { padding-top: var(--topbar-h, 75px) !important; }

@media (max-width: 480px) {
  .topbar { padding-left: 12px; padding-right: 12px; }
  .topbar-brand-page { display: none; }
}

/* === Global mobile lockdown === */
html, body { -webkit-text-size-adjust: 100%; }
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer { overscroll-behavior: contain; }
body.topbar-modal-open { overflow: hidden; touch-action: none; }
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 100vh !important;
    height: 100vh !important;
    border-radius: 0 !important;
    outline: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
  }
}
`;

  // -------- page identity --------
  function pathName() { return (window.location.pathname || '').toLowerCase(); }
  function currentPage() {
    const p = pathName();
    for (const page of PAGES) {
      if (p.endsWith('/' + page.href) || p.endsWith(page.href)) return page;
    }
    return PAGES.find(x => x.key === 'hub');   // "/" and anything unknown
  }

  // -------- HTML --------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function topbarHtml(page) {
    return `
<header class="topbar" id="topbar" role="banner">
  <a href="index.html" class="topbar-brand" aria-label="Hub">
    <span class="topbar-brand-name">Dashboard</span>
    <span class="topbar-brand-page">${escapeHtml(page.label)}</span>
  </a>
  <button type="button" class="topbar-menu-btn" id="topbarMenu" aria-controls="navDrawer" aria-expanded="false">
    <span class="topbar-menu-lines" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>Menu</span>
  </button>
</header>`;
  }

  function drawerHtml(page) {
    const items = PAGES.map(p => `
    <li class="nav-item${p.key === page.key ? ' active' : ''}${p.key === 'guide' ? ' guide' : ''}">
      <a href="${p.href}"${p.key === page.key ? ' aria-current="page"' : ''}>
        <span class="nav-item-label">${escapeHtml(p.label)}</span>
        <span class="nav-item-blurb">${escapeHtml(p.blurb)}</span>
      </a>
    </li>`).join('');
    return `
<div class="nav-backdrop" id="navBackdrop"></div>
<nav class="nav-drawer" id="navDrawer" aria-label="Pages" aria-hidden="true">
  <div class="nav-head">
    <span class="nav-title">Pages</span>
    <button type="button" class="nav-close" id="navClose" aria-label="Close menu">&times;</button>
  </div>
  <ul class="nav-list">${items}
  </ul>
</nav>`;
  }


  // -------- drawer behaviour --------
  function setOpen(open) {
    document.body.classList.toggle('nav-open', open);
    const btn = document.getElementById('topbarMenu');
    const drawer = document.getElementById('navDrawer');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (drawer) drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      const first = drawer && drawer.querySelector('.nav-item a');
      if (first) first.focus({ preventScroll: true });
    } else if (btn) {
      btn.focus({ preventScroll: true });
    }
  }
  function wireDrawer() {
    const btn = document.getElementById('topbarMenu');
    const close = document.getElementById('navClose');
    const backdrop = document.getElementById('navBackdrop');
    if (btn) btn.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    if (close) close.addEventListener('click', () => setOpen(false));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setOpen(false);
    });
  }

  function injectStyleAndHTML() {
    if (document.getElementById('topbar')) return;

    const page = currentPage();

    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = css;
    document.head.appendChild(style);

    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml(page).trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);

    const drawerWrap = document.createElement('div');
    drawerWrap.innerHTML = drawerHtml(page).trim();
    while (drawerWrap.firstChild) document.body.appendChild(drawerWrap.firstChild);


    wireDrawer();
    reserveTop();
    window.addEventListener('resize', reserveTop);
  }

  // Measure the bar and push the page down by exactly that much, plus a
  // little air, so no page has to know the bar's height.
  function reserveTop() {
    const bar = document.getElementById('topbar');
    if (!bar) return;
    document.documentElement.style.setProperty('--topbar-h', (bar.offsetHeight + 14) + 'px');
    document.body.classList.add('has-topbar');
    // The bottom tab bar used to reserve this space. Without it a page can end
    // flush with the screen edge, so keep a little air (and the home-indicator
    // inset) on pages that do not already leave some.
    if (parseFloat(getComputedStyle(document.body).paddingBottom) < 24) {
      document.body.style.paddingBottom = 'calc(28px + env(safe-area-inset-bottom))';
    }
  }

  // -------- Mobile lockdown helpers --------
  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }

  // Lock body scroll while any known modal overlay is open.
  function startModalLock() {
    const MODAL_SELECTORS = ['.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam'];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) return true;
        }
      }
      return false;
    }
    function sync() { document.body.classList.toggle('topbar-modal-open', anyOpen()); }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    sync();
  }

  // -------- Boot --------
  function boot() {
    injectStyleAndHTML();
    lockGestures();
    startModalLock();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
