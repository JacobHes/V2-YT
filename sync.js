// =============================================================
// Shared cloud sync for the dashboard, v2.
//
//   const h = initCloudSync({ appKey, syncedKeys, syncedPrefixes, excludeKeys,
//                             onApplied(changedKeys), onReady({fallback}),
//                             serialize(key, value), deferApplyWhileEditing });
//   h.ready (Promise), h.pull() (Promise), h.flush(), h.isReady()
//
// Row format in public.app_state: data = { <synced keys>,
//   "__sync:meta": { v: 2, s: { <key>: { <path>: <stamp> } } } }.
// Stamps are hybrid logical clock strings (19 chars) that sort as strings:
// 9 base36 ms + 4 base36 counter + 6 char device id. '' means unstamped
// (rank 0). The page's writes are captured by one hook on
// Storage.prototype, which diffs before/after and stamps only what changed:
//   ""        register (scalars, arrays without ids, key creation, kind change)
//   "~"       key deletion (also a floor: content older than it is gone)
//   "/a/b"    leaf in a plain object (depth <= 3, JSON-pointer escaped)
//   "#id"     id-array member added    "#id~" deleted    "#id/f" item leaf
//   "@"       id-array order
// Merge is per path: the newer stamp wins, absence included; ties between
// two unstamped sides go to the remote side. A legacy "__sync:tomb:<appKey>"
// in the row is passed through untouched and honoured read-only.
//
// Requires (pages load these):
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  var SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://bbillwahmyolgsiumxuf.supabase.co';
  var SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_mgM66JU6rRQxXKBlbnfp1A_tngIl22h';

  var META_KEY = '__sync:meta';
  var SYNC_PREFIX = '__sync:';
  var MAX_DEPTH = 3;
  var PRUNE_MS = 400 * 24 * 60 * 60 * 1000;
  var NONE = { none: true };               // "key absent" marker
  var hasOwn = Object.prototype.hasOwnProperty;

  // ---------------- canonical JSON ----------------
  function canon(v) {
    if (v === NONE) return '#NONE#';
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(v[i] === undefined || typeof v[i] === 'function' ? 'null' : canon(v[i]));
      return '[' + a.join(',') + ']';
    }
    if (v && typeof v === 'object') {
      if (typeof v.toJSON === 'function') return canon(v.toJSON());
      var ks = Object.keys(v).sort(), out = [];
      for (var j = 0; j < ks.length; j++) {
        var x = v[ks[j]];
        if (x === undefined || typeof x === 'function') continue;
        out.push(JSON.stringify(ks[j]) + ':' + canon(x));
      }
      return '{' + out.join(',') + '}';
    }
    if (v === undefined) return 'null';
    if (typeof v === 'number' && !isFinite(v)) return 'null';
    return JSON.stringify(v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  function clone(v) { return v === NONE || v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function decode(raw) {
    if (raw == null) return NONE;
    try { return JSON.parse(raw); } catch (e) { return String(raw); }
  }
  function encode(v) { return JSON.stringify(v); }

  // ---------------- stamps / hybrid logical clock ----------------
  var STAMP_RE = /^[0-9a-z]{19}$/;
  function okStamp(s) { return typeof s === 'string' && STAMP_RE.test(s); }
  function maxS(a, b) { a = a || ''; b = b || ''; return a > b ? a : b; }
  function pad36(n, w) { var s = Math.max(0, Math.floor(n)).toString(36); while (s.length < w) s = '0' + s; return s.slice(-w); }
  function makeStamp(ms, c, dev) { return pad36(ms, 9) + pad36(c, 4) + String(dev).slice(0, 6); }
  function parseStamp(s) {
    if (!okStamp(s)) return null;
    return { ms: parseInt(s.slice(0, 9), 36), c: parseInt(s.slice(9, 13), 36), dev: s.slice(13) };
  }
  // Pure HLC step. state = { ms, c } (last issued or observed).
  function hlcIssue(state, now, dev) {
    var ms = Math.max(now, state.ms || 0), c;
    if (ms === (state.ms || 0)) c = (state.c || 0) + 1; else c = 0;
    if (c > 1679615) { ms += 1; c = 0; }            // 36^4 - 1
    return { state: { ms: ms, c: c }, stamp: makeStamp(ms, c, dev) };
  }
  function hlcObserve(state, stamp) {
    var p = parseStamp(stamp);
    if (!p) return state;
    if (p.ms > (state.ms || 0) || (p.ms === (state.ms || 0) && p.c > (state.c || 0))) return { ms: p.ms, c: p.c };
    return state;
  }
  function legacyStamp(ms) {
    ms = Number(ms);
    if (!isFinite(ms) || ms <= 0) return '';
    return makeStamp(ms, 0, 'legacy');
  }

  // ---------------- value shapes ----------------
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && v !== NONE; }
  function idOf(x) { return (typeof x.id === 'string' || typeof x.id === 'number') ? String(x.id) : null; }
  function isIdArray(a) {
    if (!Array.isArray(a) || !a.length) return false;
    var seen = {};
    for (var i = 0; i < a.length; i++) {
      var x = a[i];
      if (!isObj(x)) return false;
      var id = idOf(x);
      if (id === null || hasOwn.call(seen, id)) return false;
      seen[id] = 1;
    }
    return true;
  }
  // 'obj' | 'ida' | 'empty' ([] fits ida and reg) | 'reg'
  function kindOf(v) {
    if (isObj(v)) return 'obj';
    if (Array.isArray(v)) return v.length === 0 ? 'empty' : (isIdArray(v) ? 'ida' : 'reg');
    return 'reg';
  }
  function esc(s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }
  function unesc(s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); }

  // Leaves of a plain object: { path: value }. Non-empty plain objects are
  // recursed into while the path has fewer than MAX_DEPTH segments; anything
  // else (scalars, arrays, {} and deeper objects) is a leaf.
  function isMarker(v) { return isObj(v) && Object.keys(v).length === 0; }
  function flatten(obj, prefix, out, depth) {
    out = out || {}; depth = depth || 0;
    var ks = Object.keys(obj);
    for (var i = 0; i < ks.length; i++) {
      var v = obj[ks[i]];
      if (v === undefined || typeof v === 'function') continue;
      var p = prefix + '/' + esc(ks[i]);
      if (isObj(v) && depth + 1 < MAX_DEPTH && Object.keys(v).length) flatten(v, p, out, depth + 1);
      else out[p] = v;
    }
    return out;
  }
  // Rebuild an object from [path, value] pairs whose paths start with prefix.
  function unflatten(pairs, prefix) {
    var root = {};
    for (var i = 0; i < pairs.length; i++) {
      var segs = pairs[i][0].slice(prefix.length + 1).split('/').map(unesc);
      var node = root;
      for (var j = 0; j < segs.length - 1; j++) {
        if (!isObj(node[segs[j]])) node[segs[j]] = {};
        node = node[segs[j]];
      }
      node[segs[segs.length - 1]] = clone(pairs[i][1]);
    }
    return root;
  }
  function idMap(arr) {
    var m = {}, order = [];
    if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) {
      var id = idOf(arr[i]); m[id] = arr[i]; order.push(id);
    }
    return { m: m, order: order };
  }

  // ---------------- diff: which paths a local write changed ----------------
  function allPaths(v, out) {
    var k = kindOf(v);
    if (k === 'obj') Object.keys(flatten(v, '')).forEach(function (p) { out.push(p); });
    else if (k === 'ida') v.forEach(function (x) {
      var e = '#' + esc(idOf(x));
      out.push(e);
      Object.keys(flatten(x, e)).forEach(function (p) { out.push(p); });
    });
    return out;
  }
  function diffPaths(oldV, newV) {
    if (oldV === NONE && newV === NONE) return [];
    if (newV === NONE) return ['~'];
    if (oldV === NONE) return allPaths(newV, ['']);
    var ko = kindOf(oldV), kn = kindOf(newV), out = [];
    if (ko === 'obj' && kn === 'obj') {
      var fo = flatten(oldV, ''), fn = flatten(newV, '');
      Object.keys(fo).forEach(function (p) { if (!hasOwn.call(fn, p) || !same(fo[p], fn[p])) out.push(p); });
      Object.keys(fn).forEach(function (p) { if (!hasOwn.call(fo, p)) out.push(p); });
      return out;
    }
    if ((ko === 'ida' || ko === 'empty') && (kn === 'ida' || kn === 'empty')) {
      var mo = idMap(oldV), mn = idMap(newV), kept = [], added = [];
      mo.order.forEach(function (id) {
        if (!hasOwn.call(mn.m, id)) { out.push('#' + esc(id) + '~'); return; }
        kept.push(id);
        var e = '#' + esc(id), a = flatten(mo.m[id], e), b = flatten(mn.m[id], e);
        Object.keys(a).forEach(function (p) { if (!hasOwn.call(b, p) || !same(a[p], b[p])) out.push(p); });
        Object.keys(b).forEach(function (p) { if (!hasOwn.call(a, p)) out.push(p); });
      });
      mn.order.forEach(function (id) {
        if (hasOwn.call(mo.m, id)) return;
        added.push(id);
        var e = '#' + esc(id);
        out.push(e);
        Object.keys(flatten(mn.m[id], e)).forEach(function (p) { out.push(p); });
      });
      if (JSON.stringify(mn.order) !== JSON.stringify(kept.concat(added))) out.push('@');
      return out;
    }
    var regish = function (k) { return k === 'reg' || k === 'empty'; };
    if (regish(ko) && regish(kn)) return same(oldV, newV) ? [] : [''];
    // Kind change (object <-> id-array <-> other): the old content is gone as
    // of this stamp, so it is a key floor plus a fresh creation.
    return allPaths(newV, ['~', '']);
  }

  // ---------------- merge ----------------
  function sget(s, p) { var x = s && s[p]; return okStamp(x) ? x : ''; }
  function maxMap(a, b) {
    var out = {};
    [a, b].forEach(function (m) {
      if (!isObj(m)) return;
      Object.keys(m).forEach(function (p) { var x = sget(m, p); if (x && x > (out[p] || '')) out[p] = x; });
    });
    return out;
  }
  // A present value stamped c against the other side's claim a that it is
  // absent. Newer wins. An equal non-zero stamp is the same edit, so the value
  // stands (the other side only lacks it because serialize or a kind switch
  // dropped it). Unstamped against unstamped goes to the remote side, unless
  // the other side lacks the whole key or item, which never deletes content.
  function presentWins(c, a, presentIsRemote, otherWhole) {
    if (c !== a) return c > a;
    if (c !== '') return true;
    return presentIsRemote || otherWhole;
  }
  function dropBelow(f, s, floor) {
    if (!floor) return f;
    var out = {};
    Object.keys(f).forEach(function (p) { if (sget(s, p) >= floor) out[p] = f[p]; });
    return out;
  }
  function related(a, b) { return a === b || a.indexOf(b + '/') === 0 || b.indexOf(a + '/') === 0; }
  // Per-leaf merge. fl/fr: flattened leaves, sl/sr: stamps, lWhole/rWhole:
  // that side lacks the whole container. Returns [[path, value]] in a stable order.
  function mergeLeaves(fl, sl, fr, sr, floor, lWhole, rWhole) {
    fl = dropBelow(fl, sl, floor); fr = dropBelow(fr, sr, floor);
    var paths = Object.keys(fl), seen = {};
    paths.forEach(function (p) { seen[p] = 1; });
    Object.keys(fr).forEach(function (p) { if (!seen[p]) { seen[p] = 1; paths.push(p); } });
    var win = [];
    paths.forEach(function (p, idx) {
      var inL = hasOwn.call(fl, p), inR = hasOwn.call(fr, p), c;
      if (inL && inR) {
        var cl = sget(sl, p), cr = sget(sr, p);
        win.push(cl > cr ? [p, fl[p], cl, idx] : [p, fr[p], cr, idx]);
      } else if (inL) {
        c = sget(sl, p);
        if (presentWins(c, sget(sr, p), false, rWhole)) win.push([p, fl[p], c, idx]);
      } else {
        c = sget(sr, p);
        if (presentWins(c, sget(sl, p), true, lWhole)) win.push([p, fr[p], c, idx]);
      }
    });
    // A leaf and a leaf below it cannot both stand (5 on one side, {x:1} on
    // the other): the newer representation wins, the older one is dropped.
    var byStamp = win.slice().sort(function (x, y) { return x[2] < y[2] ? 1 : x[2] > y[2] ? -1 : x[3] - y[3]; });
    var kept = [];
    byStamp.forEach(function (w) {
      for (var i = 0; i < kept.length; i++) if (kept[i][0] !== w[0] && related(kept[i][0], w[0])) return;
      kept.push(w);
    });
    kept.sort(function (x, y) { return x[3] - y[3]; });
    return kept.map(function (w) { return [w[0], w[1]]; });
  }
  function mergeObjValue(lv, ls, rv, rs, floor) {
    var fl = lv === NONE ? {} : flatten(lv, ''), fr = rv === NONE ? {} : flatten(rv, '');
    return unflatten(mergeLeaves(fl, ls, fr, rs, floor, lv === NONE, rv === NONE), '');
  }
  function mergeRegValue(lv, ls, rv, rs, floor) {
    var cl = sget(ls, ''), cr = sget(rs, '');
    var okL = lv !== NONE && cl >= floor, okR = rv !== NONE && cr >= floor;
    if (okL && okR) return cl > cr ? lv : rv;
    if (okL) return lv;
    if (okR) return rv;
    return NONE;
  }
  function mergeIdaValue(lv, ls, rv, rs, floor, idDel) {
    var A = idMap(lv === NONE ? [] : lv), B = idMap(rv === NONE ? [] : rv);
    var ids = A.order.slice();
    B.order.forEach(function (id) { if (!hasOwn.call(A.m, id)) ids.push(id); });
    var alive = {}, items = {}, addOf = {};
    ids.forEach(function (id) {
      var e = '#' + esc(id);
      var add = maxS(sget(ls, e), sget(rs, e));
      var del = maxS(maxS(sget(ls, e + '~'), sget(rs, e + '~')), idDel ? idDel(id) : '');
      addOf[id] = add;
      if (del > add || add < floor) return;
      var inA = hasOwn.call(A.m, id), inB = hasOwn.call(B.m, id);
      var pairs = mergeLeaves(inA ? flatten(A.m[id], e) : {}, ls, inB ? flatten(B.m[id], e) : {}, rs,
        maxS(floor, del), !inA, !inB);
      var item = unflatten(pairs, e);
      if (idOf(item) !== id) item.id = (inB ? B.m[id] : A.m[id]).id;
      alive[id] = 1; items[id] = item;
    });
    // Order: the side with the newer "@" (remote on a tie) gives the order of
    // the ids it holds. Ids it lacks were appended elsewhere, so they are
    // merged by add stamp into the tail of that order that is already sorted
    // by add stamp (appends land there). Unstamped ids sort as 0, remote first.
    // Only the relative order of ids added concurrently with a reorder can
    // depend on merge order; the server serialises merges, so devices still
    // converge on one order.
    // Never reordered on either side: appends only, so add-stamp order.
    // Ids (re)added after the newest order stamp were appended, so they are
    // placed by add stamp too, wherever the base side holds them.
    var la = sget(ls, '@'), ra = sget(rs, '@'), W = maxS(la, ra), base = la > ra ? A.order : W ? B.order : [];
    var seq = [], used = {};
    base.forEach(function (id) { if (alive[id] && !used[id] && addOf[id] <= W) { used[id] = 1; seq.push(id); } });
    var cut = seq.length ? seq.length - 1 : 0;
    while (cut > 0 && addOf[seq[cut - 1]] <= addOf[seq[cut]]) cut--;
    var pos = {};
    B.order.forEach(function (id, i) { pos[id] = i; });
    A.order.forEach(function (id, i) { if (!hasOwn.call(pos, id)) pos[id] = B.order.length + i; });
    var extras = ids.filter(function (id) { return alive[id] && !used[id]; });
    extras.sort(function (x, y) { return addOf[x] < addOf[y] ? -1 : addOf[x] > addOf[y] ? 1 : pos[x] - pos[y]; });
    var tail = seq.slice(cut), out = seq.slice(0, cut), i = 0, j = 0;
    while (i < tail.length || j < extras.length) {
      if (j >= extras.length || (i < tail.length && addOf[tail[i]] <= addOf[extras[j]])) out.push(tail[i++]);
      else out.push(extras[j++]);
    }
    return out.map(function (id) { return items[id]; });
  }
  function nsClaim(kind, s) {
    var c = maxS(sget(s, ''), sget(s, '~'));
    Object.keys(s || {}).forEach(function (p) {
      var ch = p.charAt(0);
      if (kind === 'obj' ? ch === '/' : (kind === 'ida' || kind === 'empty') ? (ch === '#' || ch === '@') : false) c = maxS(c, sget(s, p));
    });
    return c;
  }
  // Merge one key. lv/rv: value or NONE; ls/rs: that key's stamps on each side.
  // leg: legacy tomb view or null. Ties go to the remote (r) side.
  function mergeKey(lv, ls, rv, rs, leg, key) {
    ls = isObj(ls) ? ls : {}; rs = isObj(rs) ? rs : {};
    if (lv === undefined) lv = NONE;
    if (rv === undefined) rv = NONE;
    if (lv === NONE && rv === NONE) return NONE;
    var floor = maxS(maxS(sget(ls, '~'), sget(rs, '~')), leg ? leg.keyDel(key) : '');
    var content = '';
    [ls, rs].forEach(function (s) { Object.keys(s).forEach(function (p) { if (p !== '~') content = maxS(content, sget(s, p)); }); });
    if (floor && floor > content) return NONE;
    var kl = lv === NONE ? null : kindOf(lv), kr = rv === NONE ? null : kindOf(rv), kind;
    var cls = function (k) { return k === 'obj' ? 'obj' : k === 'ida' ? 'ida' : k === 'empty' ? 'empty' : 'reg'; };
    if (!kl || !kr) kind = cls(kl || kr);
    else if (kl === 'obj' && kr === 'obj') kind = 'obj';
    else if ((kl === 'ida' || kl === 'empty') && (kr === 'ida' || kr === 'empty')) kind = kl === 'ida' || kr === 'ida' ? 'ida' : 'empty';
    else if ((kl === 'reg' || kl === 'empty') && (kr === 'reg' || kr === 'empty')) kind = 'reg';
    else if (nsClaim(kl, ls) > nsClaim(kr, rs)) { kind = cls(kl); rv = NONE; }
    else { kind = cls(kr); lv = NONE; }
    if (kind === 'obj') return mergeObjValue(lv, ls, rv, rs, floor);
    if (kind === 'ida' || kind === 'empty') {
      if (kind === 'empty') return [];
      return mergeIdaValue(lv, ls, rv, rs, floor, leg ? leg.idDel : null);
    }
    return mergeRegValue(lv, ls, rv, rs, floor);
  }

  // Legacy v1 tomb {k, i, rk, ri} (raw ms), honoured read-only.
  function legacyView(t) {
    if (!isObj(t)) return null;
    var k = isObj(t.k) ? t.k : {}, i = isObj(t.i) ? t.i : {}, rk = isObj(t.rk) ? t.rk : {}, ri = isObj(t.ri) ? t.ri : {};
    function dead(del, rev, x) { return hasOwn.call(del, x) && Number(del[x]) > (Number(rev[x]) || 0) ? legacyStamp(del[x]) : ''; }
    var top = '';
    [k, i, rk, ri].forEach(function (m) { Object.keys(m).forEach(function (x) { top = maxS(top, legacyStamp(m[x])); }); });
    return { keyDel: function (key) { return dead(k, rk, key); }, idDel: function (id) { return dead(i, ri, id); }, top: top };
  }
  function metaOf(data) {
    var m = isObj(data) ? data[META_KEY] : null, out = {};
    if (!isObj(m) || !isObj(m.s)) return out;
    Object.keys(m.s).forEach(function (k) { if (isObj(m.s[k])) out[k] = maxMap(m.s[k], null); });
    return out;
  }
  function pruneStamps(s, now) {
    var cut = now - PRUNE_MS, out = {};
    Object.keys(s || {}).forEach(function (p) { var ps = parseStamp(s[p]); if (ps && ps.ms >= cut) out[p] = s[p]; });
    return out;
  }
  // Merge every owned key. lv/rv: {key: value}, lm/rm: {key: {path: stamp}}.
  function mergeState(lv, lm, rv, rm, owns, leg) {
    var keys = {}, vals = {}, meta = {};
    [lv, lm, rv, rm].forEach(function (o) { Object.keys(o || {}).forEach(function (k) { if (owns(k)) keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      vals[k] = mergeKey(hasOwn.call(lv, k) ? lv[k] : NONE, lm[k], hasOwn.call(rv, k) ? rv[k] : NONE, rm[k], leg, k);
      meta[k] = maxMap(lm[k], rm[k]);
    });
    return { vals: vals, meta: meta };
  }
  // The row to upload: the fetched row with owned keys replaced (or removed)
  // and the merged stamps of owned keys; everything else passes through.
  function buildPayload(remote, merged, owns, serialize, now) {
    var out = {}, rs = metaOf(remote), s = {};
    Object.keys(remote || {}).forEach(function (k) { if (k !== META_KEY) out[k] = remote[k]; });
    Object.keys(rs).forEach(function (k) { if (!owns(k)) s[k] = rs[k]; });
    Object.keys(merged.vals).forEach(function (k) {
      var v = merged.vals[k];
      if (v === NONE) delete out[k];
      else {
        var sv = v;
        if (serialize) { try { sv = serialize(k, clone(v)); } catch (e) { sv = v; } }
        if (sv === undefined) delete out[k]; else out[k] = sv;
      }
      var ps = pruneStamps(merged.meta[k], now);
      if (Object.keys(ps).length) s[k] = ps;
    });
    out[META_KEY] = { v: 2, s: s };
    return out;
  }
  // The fetched row with owned keys' stamps pruned the same way, so a push is
  // never sent only to prune.
  function prunedRemote(remote, owns, now) {
    var out = {}, rs = metaOf(remote), s = {};
    Object.keys(remote || {}).forEach(function (k) { if (k !== META_KEY) out[k] = remote[k]; });
    if (!isObj(remote) || !hasOwn.call(remote, META_KEY)) return out;
    Object.keys(rs).forEach(function (k) {
      var ps = owns(k) ? pruneStamps(rs[k], now) : rs[k];
      if (Object.keys(ps).length) s[k] = ps;
    });
    out[META_KEY] = { v: 2, s: s };
    return out;
  }

  // ---------------- page runtime: one registry and one storage hook ----------------
  var W = typeof window !== 'undefined' ? window : {};
  var REG = W.__dashSync = W.__dashSync || { instances: [], applying: 0, proto: null, client: null };
  function noop() {}
  function store() { return W.localStorage; }
  function rawGet(k) { try { return store().getItem(k); } catch (e) { return null; } }
  function rawSet(k, v) {
    REG.applying++;
    try { (REG.proto ? REG.proto.set : store().setItem).call(store(), k, v); } finally { REG.applying--; }
  }
  function rawRemove(k) {
    REG.applying++;
    try { (REG.proto ? REG.proto.remove : store().removeItem).call(store(), k); } finally { REG.applying--; }
  }
  function randId(n) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', buf = null;
    try { if (W.crypto && W.crypto.getRandomValues) buf = W.crypto.getRandomValues(new Uint8Array(n)); } catch (e) { buf = null; }
    for (var i = 0; i < n; i++) out += abc[(buf ? buf[i] : Math.floor(Math.random() * 256)) % 36];
    return out;
  }
  var memDev = null, memHlc = { ms: 0, c: 0 };
  function deviceId() {
    var d = rawGet('__sync:dev');
    if (typeof d === 'string' && /^[0-9a-z]{6}$/.test(d) && d !== 'legacy') return d;
    if (!memDev) { do { memDev = randId(6); } while (memDev === 'legacy'); }
    try { rawSet('__sync:dev', memDev); } catch (e) {}
    return memDev;
  }
  function readHlc() {
    var st = memHlc;
    try { var p = JSON.parse(rawGet('__sync:hlc') || 'null'); if (p && isFinite(p.ms) && isFinite(p.c)) st = hlcObserve(st, makeStamp(p.ms, p.c, 'aaaaaa')); } catch (e) {}
    return st;
  }
  function writeHlc(st) { memHlc = st; try { rawSet('__sync:hlc', JSON.stringify(st)); } catch (e) {} }
  function issueStamp() { var r = hlcIssue(readHlc(), Date.now(), deviceId()); writeHlc(r.state); return r.stamp; }
  function observeStamp(s) {
    if (!okStamp(s)) return;
    var cur = readHlc(), nx = hlcObserve(cur, s);
    if (nx !== cur) writeHlc(nx);
  }
  function localMetaKey(appKey) { return SYNC_PREFIX + 'meta:' + appKey; }
  function readLocalMeta(appKey) {
    var o = null;
    try { o = JSON.parse(rawGet(localMetaKey(appKey)) || 'null'); } catch (e) { o = null; }
    var tmp = {}; tmp[META_KEY] = o;
    return metaOf(tmp);
  }
  function writeLocalMeta(appKey, s) {
    try { rawSet(localMetaKey(appKey), JSON.stringify({ v: 2, s: s })); } catch (e) {}
  }

  // Which instances own this key, grouped by appKey (instances with the same
  // appKey share one stamp set on this device).
  function routesFor(key) {
    if (typeof key !== 'string' || key.indexOf(SYNC_PREFIX) === 0) return null;
    var groups = null;
    for (var i = 0; i < REG.instances.length; i++) {
      var inst = REG.instances[i];
      if (!inst.owns(key)) continue;
      groups = groups || {};
      var g = groups[inst.appKey] || (groups[inst.appKey] = { stamping: false, insts: [] });
      if (inst.stamping()) g.stamping = true;
      g.insts.push(inst);
    }
    return groups;
  }
  function afterWrite(groups, key, beforeRaw, afterRaw) {
    try {
      if (beforeRaw === afterRaw) return;
      var paths = diffPaths(decode(beforeRaw), decode(afterRaw));
      if (!paths.length) return;
      Object.keys(groups).forEach(function (appKey) {
        var g = groups[appKey];
        if (!g.stamping) return;           // before the first fetch: unstamped, ranks lowest
        var stamp = issueStamp();
        var meta = readLocalMeta(appKey), m = meta[key] || {};
        paths.forEach(function (p) { m[p] = stamp; });
        meta[key] = m;
        writeLocalMeta(appKey, meta);
        g.insts.forEach(function (inst) { inst.noteWrite(key); });
      });
    } catch (e) {}
  }
  function installHook() {
    if (REG.proto || !W.Storage || !W.Storage.prototype) return;
    var P = W.Storage.prototype, origSet = P.setItem, origRemove = P.removeItem;
    REG.proto = { set: origSet, remove: origRemove };
    P.setItem = function (k, v) {
      if (this !== W.localStorage || REG.applying || !REG.instances.length) return origSet.apply(this, arguments);
      var key = String(k), groups = routesFor(key);
      if (!groups) return origSet.apply(this, arguments);
      var before = this.getItem(key);
      var r = origSet.apply(this, arguments);
      afterWrite(groups, key, before, this.getItem(key));
      return r;
    };
    P.removeItem = function (k) {
      if (this !== W.localStorage || REG.applying || !REG.instances.length) return origRemove.apply(this, arguments);
      var key = String(k), groups = routesFor(key);
      if (!groups) return origRemove.apply(this, arguments);
      var before = this.getItem(key);
      var r = origRemove.apply(this, arguments);
      afterWrite(groups, key, before, this.getItem(key));
      return r;
    };
  }
  function utf8Len(s) {
    try { if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length; } catch (e) {}
    return unescape(encodeURIComponent(s)).length;
  }
  function isEditable(el) {
    if (!el) return false;
    var t = String(el.tagName || '').toUpperCase();
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  }
  function isEditing() { try { return isEditable(W.document && W.document.activeElement); } catch (e) { return false; } }
  function inertHandle(onReady) {
    var fired = false;
    if (typeof onReady === 'function') setTimeout(function () { if (fired) return; fired = true; try { onReady({ fallback: true }); } catch (e) {} }, 0);
    return { ready: Promise.resolve(), pull: function () { return Promise.resolve(); }, flush: noop, isReady: function () { return false; } };
  }

  // ---------------- one sync instance ----------------
  W.initCloudSync = function (config) {
    config = config || {};
    var onReady = typeof config.onReady === 'function' ? config.onReady : null;
    var onApplied = typeof config.onApplied === 'function' ? config.onApplied : null;
    var serialize = typeof config.serialize === 'function' ? config.serialize : null;
    var appKey = config.appKey ? String(config.appKey) : '';
    // Pages opened from disk (local previews) never reach a backend.
    if (W.location && W.location.protocol === 'file:') return inertHandle(onReady);
    if (!appKey || !W.supabase || typeof W.supabase.createClient !== 'function') return inertHandle(onReady);
    if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return inertHandle(onReady);

    var syncedKeys = (config.syncedKeys || []).map(String);
    var prefixes = (config.syncedPrefixes || []).map(String);
    var exclude = (config.excludeKeys || []).map(String);
    var defer = !!config.deferApplyWhileEditing;
    function owns(k) {
      if (typeof k !== 'string' || !k || k.indexOf(SYNC_PREFIX) === 0 || k === META_KEY) return false;
      if (exclude.indexOf(k) !== -1) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (var i = 0; i < prefixes.length; i++) if (prefixes[i] && k.indexOf(prefixes[i]) === 0) return true;
      return false;
    }
    var st = {
      enabled: false, ready: false, readyFired: false, fallbackFired: false,
      lastRemote: null, lastRemoteCanon: null, writeGen: 0, syncedGen: 0,
      pushing: false, again: false, remoteDuringPush: false, timer: null, retryTimer: null, backoff: 0,
      pendingApply: false, lastPullAt: 0, chanGen: 0, channel: null, rtBackoff: 0, rtHadError: false, resubTimer: null
    };
    var resolveReady;
    var ready = new Promise(function (res) { resolveReady = res; });
    if (!REG.client) REG.client = W.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    var client = REG.client;

    function collectLocal() {
      var out = {}, s = store(), n = 0;
      try { n = s.length; } catch (e) { n = 0; }
      for (var i = 0; i < n; i++) {
        var k = s.key(i);
        if (owns(k)) { var raw = rawGet(k); if (raw != null) out[k] = decode(raw); }
      }
      return out;
    }
    function remoteVals(data) {
      var out = {};
      Object.keys(data || {}).forEach(function (k) { if (owns(k)) out[k] = data[k]; });
      return out;
    }
    function mergeWith(data) {
      var rm = metaOf(data), leg = legacyView(data ? data[SYNC_PREFIX + 'tomb:' + appKey] : null);
      var top = leg ? leg.top : '';
      Object.keys(rm).forEach(function (k) { Object.keys(rm[k]).forEach(function (p) { top = maxS(top, rm[k][p]); }); });
      observeStamp(top);
      var lvals = collectLocal(), lm = readLocalMeta(appKey), lmOwned = {};
      Object.keys(lm).forEach(function (k) { if (owns(k)) lmOwned[k] = lm[k]; });
      return { merged: mergeState(lvals, lmOwned, remoteVals(data), rm, owns, leg), lvals: lvals };
    }
    // Write merged values and their stamps into localStorage (without stamping).
    function apply(mm, force) {
      if (defer && !force && isEditing()) { st.pendingApply = true; return []; }
      var changed = [], m = mm.merged, now = Date.now();
      Object.keys(m.vals).forEach(function (k) {
        var v = m.vals[k], had = hasOwn.call(mm.lvals, k);
        try {
          if (v === NONE) { if (had) { rawRemove(k); changed.push(k); } }
          else if (!had || !same(mm.lvals[k], v)) { rawSet(k, encode(v)); changed.push(k); }
        } catch (e) {}
      });
      var lm = readLocalMeta(appKey);
      Object.keys(m.meta).forEach(function (k) {
        var ps = pruneStamps(m.meta[k], now);
        if (Object.keys(ps).length) lm[k] = ps; else delete lm[k];
      });
      writeLocalMeta(appKey, lm);
      return changed;
    }
    function notify(changed) {
      if (changed.length && onApplied) { try { onApplied(changed.slice()); } catch (e) { if (W.console) W.console.error('[sync] onApplied', e); } }
    }
    function fireReady(fallback) {
      if (!onReady) return;
      try { onReady({ fallback: fallback }); } catch (e) { if (W.console) W.console.error('[sync] onReady', e); }
    }
    function setRemote(d) { st.lastRemote = d; st.lastRemoteCanon = canon(d); }

    function fetchRow() {
      return Promise.resolve(client.from('app_state').select('data').eq('key', appKey).maybeSingle()).then(function (res) {
        if (!res || res.error) throw new Error('fetch failed: ' + (res && res.error && res.error.message));
        var d = res.data && res.data.data;
        return isObj(d) ? d : {};
      });
    }
    function upsert(payload) {
      return Promise.resolve(client.from('app_state').upsert(
        { key: appKey, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'key' }
      )).then(function (res) { if (res && res.error) throw new Error('upsert failed: ' + res.error.message); });
    }

    // One GET-merge-apply-(upsert) loop in flight; callers join it.
    var waiters = [];
    function cycle() {
      return new Promise(function (res, rej) {
        waiters.push({ res: res, rej: rej });
        if (st.pushing) { st.again = true; return; }
        run();
      });
    }
    function run() {
      st.pushing = true;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      var gen, remote, now;
      function step() {
        st.again = false; st.remoteDuringPush = false;
        gen = st.writeGen;
        return fetchRow().then(function (data) {
          remote = data; now = Date.now();
          var first = !st.ready;
          var mm = mergeWith(remote);
          st.enabled = true; st.ready = true;
          var changed = apply(mm, false);
          setRemote(remote);
          var payload = buildPayload(remote, mm.merged, owns, serialize, now);
          notify(changed);
          if (first) { st.readyFired = true; resolveReady(); fireReady(false); }
          if (canon(payload) === canon(prunedRemote(remote, owns, now))) return null;
          return upsert(payload).then(function () { setRemote(payload); });
        }).then(function () {
          if (st.syncedGen < gen) st.syncedGen = gen;
          if (st.writeGen !== gen || st.remoteDuringPush) st.again = true;
          if (st.again) return step();
        });
      }
      step().then(function () { finish(null); }, function (e) {
        if (!st.ready) st.enabled = true;       // offline: later edits are real edits
        finish(e || new Error('sync failed'));
      });
    }
    function finish(err) {
      st.pushing = false;
      var ws = waiters; waiters = [];
      if (err) { scheduleRetry(); ws.forEach(function (w) { w.rej(err); }); }
      else { st.backoff = 0; ws.forEach(function (w) { w.res(); }); }
    }
    function scheduleRetry() {
      if (st.retryTimer) return;
      st.backoff = st.backoff ? Math.min(60000, st.backoff * 2) : 1000;
      st.retryTimer = setTimeout(function () { st.retryTimer = null; cycle().catch(noop); }, st.backoff);
    }
    function schedulePush() {
      if (st.pushing) { st.again = true; return; }
      if (st.retryTimer) return;                 // the retry picks it up
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(function () { st.timer = null; cycle().catch(noop); }, 300);
    }
    function pullNow(throttleMs) {
      var now = Date.now();
      if (throttleMs && now - st.lastPullAt < throttleMs) return Promise.resolve();
      st.lastPullAt = now;
      if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
      return cycle();
    }

    // ---- realtime: a hint; merge is idempotent, so duplicates are harmless ----
    function onRealtime(payload) {
      var d = payload && payload.new && payload.new.data;
      if (!isObj(d) || !st.ready) return;
      var c = canon(d);
      if (c === st.lastRemoteCanon) return;          // own echo (or already seen)
      if (st.pushing) st.remoteDuringPush = true;
      setRemote(d);
      var now = Date.now(), mm = mergeWith(d);
      notify(apply(mm, false));
      if (canon(buildPayload(d, mm.merged, owns, serialize, now)) !== canon(prunedRemote(d, owns, now))) schedulePush();
    }
    function subscribe() {
      var gen = ++st.chanGen;
      try {
        st.channel = client.channel('app_state_' + appKey + '_' + randId(4))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey },
            function (p) { if (gen === st.chanGen) { try { onRealtime(p); } catch (e) {} } })
          .subscribe(function (status) { if (gen === st.chanGen) onStatus(status); });
      } catch (e) { st.channel = null; resubscribeLater(); }
    }
    function onStatus(s) {
      if (s === 'SUBSCRIBED') {
        st.rtBackoff = 0;
        if (st.rtHadError) { st.rtHadError = false; pullNow(1000).catch(noop); }
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
        st.rtHadError = true;
        pullNow(1000).catch(noop);
        resubscribeLater();
      }
    }
    function resubscribeLater() {
      if (st.resubTimer) return;
      st.rtBackoff = Math.min(60000, st.rtBackoff ? st.rtBackoff * 2 : 1000);
      st.resubTimer = setTimeout(function () {
        st.resubTimer = null;
        var old = st.channel;
        st.chanGen++;                                 // statuses from the old channel are ignored
        try { if (old) client.removeChannel(old); } catch (e) {}
        subscribe();
      }, st.rtBackoff);
    }

    // ---- unload: send what this tab has not uploaded yet ----
    function flushKeepalive() {
      if (!st.enabled || st.writeGen <= st.syncedGen || !st.lastRemote) return;
      if (st.keepaliveGen === st.writeGen) return;   // hidden then pagehide: send once
      try {
        var base = st.lastRemote, mm = mergeWith(base);
        var payload = buildPayload(base, mm.merged, owns, serialize, Date.now());
        var body = JSON.stringify({ key: appKey, data: payload, updated_at: new Date().toISOString() });
        if (utf8Len(body) > 60000) return;
        st.keepaliveGen = st.writeGen;               // not "synced": the next load merges anyway
        W.fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: body,
          keepalive: true
        }).catch(noop);
      } catch (e) {}
    }
    function pushNowIfDirty() {
      if (st.writeGen > st.syncedGen && st.enabled) {
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        cycle().catch(noop);
      }
    }

    // ---- deferred merges while the user is typing ----
    function flushDeferred(force) {
      if (!st.pendingApply || !st.lastRemote) { st.pendingApply = false; return; }
      if (!force && isEditing()) return;
      st.pendingApply = false;
      notify(apply(mergeWith(st.lastRemote), true));
    }
    if (defer && W.document && W.document.addEventListener) {
      W.document.addEventListener('focusout', function (e) {
        if (!st.pendingApply) return;
        var next = e && e.relatedTarget;
        if (next && isEditable(next)) return;         // focus moves to another field: keep holding
        flushDeferred(true);
      }, true);
      setInterval(function () { if (st.pendingApply && !isEditing()) flushDeferred(true); }, 1000);
    }

    // ---- register with the shared hook ----
    installHook();
    REG.instances.push({
      appKey: appKey, owns: owns,
      stamping: function () { return st.enabled; },
      noteWrite: function () { st.writeGen++; schedulePush(); }
    });

    // ---- lifecycle ----
    var doc = W.document;
    function visible() { return !doc || doc.visibilityState !== 'hidden'; }
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () {
        if (visible()) pullNow(1000).catch(noop);
        else { flushKeepalive(); pushNowIfDirty(); }
      });
    }
    if (W.addEventListener) {
      W.addEventListener('pagehide', flushKeepalive);
      W.addEventListener('pageshow', function () { pullNow(1000).catch(noop); });
      W.addEventListener('online', function () { pullNow(0).catch(noop); });
      W.addEventListener('focus', function () { pullNow(3000).catch(noop); });
    }
    setInterval(function () { if (visible()) pullNow(1000).catch(noop); }, 5 * 60 * 1000);
    setTimeout(function () {
      if (st.readyFired || st.fallbackFired) return;
      st.fallbackFired = true;
      fireReady(true);
    }, 4000);

    st.lastPullAt = Date.now();
    cycle().catch(noop);
    subscribe();

    return {
      ready: ready,
      pull: function () { return pullNow(0); },
      flush: function () { flushDeferred(false); pushNowIfDirty(); },
      isReady: function () { return st.ready; }
    };
  };

  W.__dashSyncInternals = {
    canon: canon, same: same, decode: decode, encode: encode, NONE: NONE, META_KEY: META_KEY, PRUNE_MS: PRUNE_MS,
    kindOf: kindOf, isIdArray: isIdArray, flatten: flatten, unflatten: unflatten, diffPaths: diffPaths,
    mergeKey: mergeKey, mergeState: mergeState, maxMap: maxMap, metaOf: metaOf, legacyView: legacyView,
    legacyStamp: legacyStamp, buildPayload: buildPayload, prunedRemote: prunedRemote, pruneStamps: pruneStamps,
    makeStamp: makeStamp, parseStamp: parseStamp, hlcIssue: hlcIssue, hlcObserve: hlcObserve, okStamp: okStamp
  };
})();
