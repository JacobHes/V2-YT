// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://bbillwahmyolgsiumxuf.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_mgM66JU6rRQxXKBlbnfp1A_tngIl22h';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const excludeKeys = (config && config.excludeKeys) || [];
    const onApplied = config && config.onApplied;
    if (!appKey) return;
    if (!window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    let lastSyncedJson = null;
    // Guard: never upload before the first remote fetch+merge has finished, so
    // a sparse local state can't overwrite (wipe) the cloud during page load.
    let initialSyncDone = false;

    // Deletion log ("tombstones"). Mirrored through the same Supabase row so a
    // delete on one device isn't undone by the union-merge in applyRemote().
    const TOMB_KEY = '__sync:tomb:' + appKey;
    const TOMB_TTL = 90 * 24 * 60 * 60 * 1000;

    function matches(k) {
      if (!k) return false;
      if (k === TOMB_KEY) return true;
      if (excludeKeys.indexOf(k) !== -1) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    const origGet = localStorage.getItem.bind(localStorage);

    function parseVal(raw) {
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }
    // The `id`s carried by an array of objects (sessions, goals, …).
    function idsOf(v) {
      if (!Array.isArray(v)) return [];
      return v.filter(function (x) { return x && typeof x === 'object' && x.id != null; })
              .map(function (x) { return String(x.id); });
    }

    // Four timestamp maps, all merged max-wins across devices:
    //   k  key   deleted at        i  item id deleted at
    //   rk key   re-created at     ri item id re-created at
    // Something counts as deleted only while its delete stamp is the newer of
    // the pair. Without the revive stamps, a key that gets deleted and made
    // again — toggl:running on every Start, a day key you re-track — would be
    // killed off by whichever device still remembered the delete.
    function loadTomb() {
      const t = parseVal(origGet(TOMB_KEY)) || {};
      return { k: t.k || {}, i: t.i || {}, rk: t.rk || {}, ri: t.ri || {} };
    }
    function saveTomb(t) {
      try { origSet(TOMB_KEY, JSON.stringify(t)); } catch (e) {}
    }
    function isDead(t, side, token) {
      const rev = side === 'k' ? t.rk : t.ri;
      return has(t[side], token) && t[side][token] > (rev[token] || 0);
    }
    // gone: item ids that disappeared · dead: a key that was removed
    // back: a key written again · alive: item ids present in the new value
    function tombstone(gone, dead, back, alive) {
      const t = loadTomb(); const now = Date.now(); let dirty = false;
      gone.forEach(function (id) { t.i[id] = now; dirty = true; });
      if (dead) { t.k[dead] = now; dirty = true; }
      // Stamped on every write, not only when a delete is known about: a device
      // that missed the delete would otherwise write the key with no revival to
      // show for it, and the next device that did see the delete would win.
      if (back) { t.rk[back] = now; dirty = true; }
      if (alive) {
        alive.forEach(function (id) { if (has(t.i, id)) { t.ri[id] = now; dirty = true; } });
      }
      if (dirty) saveTomb(t);
    }

    localStorage.setItem = function (k, v) {
      const track = !suppressSync && k !== TOMB_KEY && matches(k);
      let gone = [], alive = [];
      if (track) {
        alive = idsOf(parseVal(v));
        const before = idsOf(parseVal(origGet(k)));
        if (before.length) {
          const kept = {};
          alive.forEach(function (id) { kept[id] = 1; });
          gone = before.filter(function (id) { return !has(kept, id); });
        }
      }
      origSet(k, v);
      try {
        if (track) { tombstone(gone, null, k, alive); schedulePush(); }
      } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      const track = !suppressSync && k !== TOMB_KEY && matches(k);
      const gone = track ? idsOf(parseVal(origGet(k))) : [];
      origRemove(k);
      try {
        if (track) { tombstone(gone, k, null, null); schedulePush(); }
      } catch (e) {}
    };

    // Array of objects that all carry a stable `id` (sessions, goals, …).
    function idArray(a) {
      return Array.isArray(a) && a.length > 0 &&
        a.every(function (x) { return x && typeof x === 'object' && x.id != null; });
    }
    // Union two id-arrays: remote order first, then any local-only items.
    function unionById(localArr, remoteArr) {
      const seen = {}; const out = [];
      remoteArr.forEach(function (x) { if (x && x.id != null && !(x.id in seen)) { seen[x.id] = 1; out.push(x); } });
      localArr.forEach(function (x) { if (x && x.id != null && !(x.id in seen)) { seen[x.id] = 1; out.push(x); } });
      return out;
    }
    // Union the remote tombstone log into the local one and drop expired entries.
    function mergeTomb(remoteTomb) {
      const t = loadTomb();
      let dirty = false;
      const SIDES = ['k', 'i', 'rk', 'ri'];
      if (remoteTomb && typeof remoteTomb === 'object') {
        SIDES.forEach(function (side) {
          const src = remoteTomb[side];
          if (!src || typeof src !== 'object') return;
          Object.keys(src).forEach(function (id) {
            const ts = Number(src[id]) || 0;
            if (!has(t[side], id) || t[side][id] < ts) { t[side][id] = ts; dirty = true; }
          });
        });
      }
      const cutoff = Date.now() - TOMB_TTL;
      SIDES.forEach(function (side) {
        Object.keys(t[side]).forEach(function (id) {
          if (t[side][id] < cutoff) { delete t[side][id]; dirty = true; }
        });
      });
      if (dirty) saveTomb(t);
      return t;
    }

    // Merge remote INTO local without ever deleting local data.
    //   - id-arrays (sessions/goals) are unioned, so a just-tracked item that
    //     hasn't uploaded yet survives a refresh instead of being wiped.
    //   - keys that exist only locally are kept (and pushed up).
    //   - everything else: remote wins (unchanged behaviour).
    // Deletions DO propagate: anything listed in the tombstone log is filtered
    // out of the incoming data and then pushed back up so the cloud drops it too.
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      let needsPush = false;
      try {
        const tomb = mergeTomb(remote[TOMB_KEY]);
        for (const k of Object.keys(remote)) {
          if (k === TOMB_KEY || !matches(k)) continue;
          const rv = remote[k];
          const localRaw = localStorage.getItem(k);
          // Key was deleted here and not re-created since — don't bring it back.
          if (localRaw == null && isDead(tomb, 'k', k)) { needsPush = true; continue; }
          let lv = null;
          if (localRaw != null) { try { lv = JSON.parse(localRaw); } catch (e) { lv = null; } }
          let val = rv;
          if (Array.isArray(rv) && idArray(lv) && (rv.length === 0 || idArray(rv))) {
            val = unionById(lv, rv);
            if (val.length !== rv.length) needsPush = true;   // local had extra items
          }
          if (Array.isArray(val) && idArray(val)) {
            const kept = val.filter(function (x) { return !isDead(tomb, 'i', String(x.id)); });
            if (kept.length !== val.length) needsPush = true; // remote had deleted items
            val = kept;
          }
          // Everything in the array was deleted → drop the key, matching the
          // "empty means absent" convention the pages use.
          if (Array.isArray(val) && !val.length && Array.isArray(rv) && rv.length) {
            if (localRaw != null) { try { origRemove(k); changed = true; } catch (e) {} }
            needsPush = true;
            continue;
          }
          const incoming = JSON.stringify(val);
          if (localRaw !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        // A vanished key is absent from `remote`, so the loop above can never see
        // it — without this sweep a Stop on one device would leave every other
        // device still holding a running timer. Our own newer write outranks the
        // delete via rk, so a timer we just started is safe.
        const localKeys = listAllKeys();
        for (let i = 0; i < localKeys.length; i++) {
          const lk = localKeys[i];
          if (!has(remote, lk)) needsPush = true;      // local-only → upload it
          if (lk === TOMB_KEY) continue;
          if (isDead(tomb, 'k', lk)) {
            try { origRemove(lk); changed = true; needsPush = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      if (needsPush) schedulePush();
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      return changed;
    }

    async function pushNow() {
      if (!supa) return;
      if (!initialSyncDone) { schedulePush(); return; }   // wait for the initial pull+merge
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastSyncedJson = json;
      } catch (e) {}
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      if (!initialSyncDone) return;   // don't overwrite the cloud before it's loaded
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      // Remote has now been fetched and merged — uploads are safe from here.
      initialSyncDone = true;
      schedulePush();   // flush anything captured during load (merged/local-only)
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
