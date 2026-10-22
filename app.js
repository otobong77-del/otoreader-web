/* app.js — OtoReader on the web: the library and the reader, synced through the phone's Google Drive folder. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var STATUS = { NONE: 0, READING: 1, TO_READ: 2, FINISHED: 3 };

  // ---------- state ----------
  var lib = { fileId: null, folderId: null, booksId: null, entries: {}, files: {}, loadedAt: 0 };
  var books = [];            // merged rows
  var dirty = {};            // fingerprints changed here and not yet written
  var APP_VERSION = 'web 39';
  /** Throws away every saved copy of the app and loads it fresh from the server. */
  async function getLatest() {
    setStatus('Getting the latest version…', 0);
    try { if (window.caches) { var keys = await caches.keys(); for (var i = 0; i < keys.length; i++) await caches.delete(keys[i]); } } catch (e) {}
    try { if (navigator.serviceWorker) { var regs = await navigator.serviceWorker.getRegistrations(); for (var j = 0; j < regs.length; j++) await regs[j].unregister(); } } catch (e) {}
    location.replace(location.pathname + '?fresh=' + Date.now());
  }
  /** Asks the server which version is current; when it is newer than this page, refreshes to it. */
  function checkVersion() {
    if (!navigator.onLine) return;
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      if (v && v.version && v.version !== APP_VERSION) {
        var last = 0; try { last = +localStorage.getItem('oto.lastAutoUpdate') || 0; } catch (e) {}
        if (Date.now() - last < 5 * 60 * 1000) return; // never loop
        try { localStorage.setItem('oto.lastAutoUpdate', String(Date.now())); } catch (e) {}
        getLatest();
      }
    }).catch(function () {});
  }
  var filter = { shelf: 'reading', value: null };
  try { var sf = JSON.parse(localStorage.getItem('oto.filter') || 'null'); if (sf && sf.shelf) filter = sf; } catch (e) {}
  function rememberFilter() { try { localStorage.setItem('oto.filter', JSON.stringify(filter)); } catch (e) {} }
  var search = '', sort = 'recent', shown = 0;
  var local = null;          // a book opened from this computer (no Drive)


  // the phone's icons, as inline SVG paths
  var ICON = {
    reading: 'M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z',
    all: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z',
    star: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
    starOn: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    doneAll: 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    series: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
    collections: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM10 9h8v2h-8zm0 3h4v2h-4zm0-6h8v2h-8z',
    layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24"><path d="' + ICON[name] + '"/></svg>'; }
  function fingerprint(name, size) { return name.toLowerCase() + ':' + size; }
  function formatOf(name) { var e = name.toLowerCase().split('.').pop(); return { epub: 'EPUB', pdf: 'PDF', txt: 'TXT', fb2: 'FB2', mobi: 'MOBI', azw: 'AZW', azw3: 'AZW3', docx: 'DOCX', rtf: 'RTF', odt: 'ODT', cbz: 'CBZ', cbr: 'CBR' }[e] || e.toUpperCase(); }
  function sizeText(n) { n = +n || 0; if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB'; if (n >= 1024) return Math.round(n / 1024) + ' kB'; return n + ' B'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function stem(name) { return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '); }

  function rebuild() {
    books = [];
    var fps = {};
    for (var fp in lib.entries) fps[fp] = 1;
    for (var fp2 in lib.files) fps[fp2] = 1;
    for (var k in fps) {
      var e = lib.entries[k] || null, f = lib.files[k] || null;
      var name = f ? f.name : k.substring(0, k.lastIndexOf(':'));
      books.push({
        fp: k, entry: e, file: f, name: name,
        title: (e && e.title) || stem(name), author: (e && e.author) || '',
        format: formatOf(name), size: f ? +f.size : +k.substring(k.lastIndexOf(':') + 1),
        modified: f ? Date.parse(f.modifiedTime) || 0 : 0,
      });
    }
  }

  function entryOf(b) {
    if (!b.entry) { b.entry = { title: b.title, author: b.author, progress: 0, position: null, status: 0, favorite: false, lastOpened: 0, updated: 0, trashed: false, collections: [], bookmarks: [] }; lib.entries[b.fp] = b.entry; }
    return b.entry;
  }
  function saveDirty() { try { localStorage.setItem('oto.dirty', JSON.stringify(Object.keys(dirty))); } catch (e) {} }
  try { JSON.parse(localStorage.getItem('oto.dirty') || '[]').forEach(function (fp) { dirty[fp] = 1; }); } catch (e) {}
  function touch(b) { var e = entryOf(b); e.updated = Date.now(); dirty[b.fp] = 1; saveDirty(); scheduleSave(); saveCache(); }

  // ---------- persistence ----------
  function saveCache() { try { var t = JSON.stringify(lib); if (t.length < 4000000) localStorage.setItem('oto.lib', t); else localStorage.removeItem('oto.lib'); } catch (e) {} }
  function loadCache() { try { var c = JSON.parse(localStorage.getItem('oto.lib') || 'null'); if (c && c.entries) lib = c; } catch (e) {} }

  var saveTimer = null;
  function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(flush, 4000); }
  async function flush() {
    saveTimer = null;
    var fps = Object.keys(dirty);
    if (!fps.length || !lib.fileId || !Drive.signedIn()) return;
    try {
      var remoteText;
      try { remoteText = await Drive.text(lib.fileId); }
      catch (e) { var again = await Drive.findLibrary(); if (!again) throw e; lib.fileId = again.fileId; lib.folderId = again.folderId; lib.booksId = again.booksId; remoteText = await Drive.text(lib.fileId); }
      var remote = parseLibrary(remoteText);
      for (var fp in remote.entries) if (!dirty[fp]) lib.entries[fp] = mergeEntry(lib.entries[fp], remote.entries[fp]);
      fps.forEach(function (f) { var mine = lib.entries[f], theirs = remote.entries[f]; if (theirs && theirs.updated > mine.updated) lib.entries[f] = mergeEntry(mine, theirs); });
      var text = serializeLibrary(lib.entries);
      await Drive.writeText(lib.fileId, text);
      fps.forEach(function (f) { delete dirty[f]; });
      saveDirty();
      try { lib.remoteModified = await Drive.modified(lib.fileId); } catch (e) {}
      setStatus('Saved to Google Drive', 2500);
    } catch (e) {
      // offline: the changes stay marked and go up the moment the connection is back (and after a reload)
      setStatus(navigator.onLine ? 'Could not save: ' + e.message + ' (will retry)' : 'Offline: your changes are kept and sync when the connection is back', 6000);
      if (navigator.onLine) scheduleSave();
    }
    saveCache();
  }
  function mergeEntry(a, b) {
    if (!a) return b; if (!b) return a;
    var w = b.updated > a.updated ? b : a, l = w === a ? b : a;
    var out = {}; for (var k in w) out[k] = w[k];
    out.collections = (w.collections || []).concat((l.collections || []).filter(function (c) { return (w.collections || []).indexOf(c) < 0; }));
    var have = {}; (w.bookmarks || []).forEach(function (m) { have[m.position] = 1; });
    out.bookmarks = (w.bookmarks || []).concat((l.bookmarks || []).filter(function (m) { return !have[m.position]; }));
    out.lastOpened = Math.max(a.lastOpened || 0, b.lastOpened || 0);
    return out;
  }
  function parseLibrary(text) {
    var root = JSON.parse(text || '{}'), out = { entries: {} };
    var bs = root.books || {};
    for (var fp in bs) {
      var o = bs[fp];
      out.entries[fp] = { title: o.title || '', author: o.author || '', series: o.series || '', progress: +o.progress || 0, position: o.position == null ? null : String(o.position), status: +o.status || 0, favorite: !!o.favorite, lastOpened: +o.lastOpened || 0, updated: +o.updated || 0, trashed: !!o.trashed, collections: o.collections || [], bookmarks: o.bookmarks || [] };
    }
    return out;
  }
  function serializeLibrary(entries) {
    var bs = {};
    for (var fp in entries) {
      var e = entries[fp];
      bs[fp] = { title: e.title, author: e.author, series: e.series || '', progress: e.progress, position: e.position, status: e.status, favorite: e.favorite, lastOpened: e.lastOpened, updated: e.updated, trashed: e.trashed, collections: e.collections || [], bookmarks: e.bookmarks || [] };
    }
    return JSON.stringify({ version: 1, written: Date.now(), books: bs }, null, 2);
  }
  window.addEventListener('pagehide', function () { if (Object.keys(dirty).length) flush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && Object.keys(dirty).length) flush(); });

  // ---------- keeping up with the phone ----------
  // Every few minutes while the page is visible, and whenever it comes back into view, the
  // library file's modified time is checked; when the phone (or another browser) wrote it,
  // the library is read again and redrawn. Local unsaved edits are merged, never lost.
  var lastCheck = 0, checking = false;
  async function checkForUpdates(force) {
    if (checking || !lib.fileId || !Drive.signedIn() || document.hidden) return;
    var now = Date.now();
    if (!force && now - lastCheck < 30000) return;
    lastCheck = now; checking = true;
    try {
      var m;
      try { m = await Drive.modified(lib.fileId); }
      catch (e) { var again = await Drive.findLibrary(); if (again && again.fileId !== lib.fileId) { lib.fileId = again.fileId; lib.folderId = again.folderId; lib.booksId = again.booksId; m = again.modified || 'new'; } }
      if (m && m !== lib.remoteModified) {
        if (Object.keys(dirty).length) await flush(); // our edits go in first; flush merges the phone's copy
        await loadFromDrive(true, true);
        setStatus('Updated with the changes from your phone', 4000);
      }
    } catch (e) {
    } finally { checking = false; }
  }
  setInterval(function () { checkForUpdates(false); }, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkForUpdates(false); });
  window.addEventListener('focus', function () { checkForUpdates(false); });

  // ---------- Drive loading ----------
  async function loadFromDrive(force, quiet) {
    try {
      await Drive.signIn(false);
    } catch (e) {
      $('accountBtn').classList.remove('hidden');
      if (!books.length) showNotice('Press <b>Sign in</b> at the top right to open your Google Drive library.');
      else setStatus('Google Drive: ' + e.message, 8000);
      return;
    }
    $('accountBtn').classList.add('hidden');
    setStatus('Looking for the OtoReader folder in Google Drive…');
    try {
      var found = await Drive.findLibrary();
      if (!found) { found = await Drive.ensureLibrary(); showNotice('No library file in Google Drive yet. Press <b>Sync</b> on the phone; this page picks it up by itself. You can also add books here with ⋮ → <b>Add books from this computer</b>.'); }
      lib.fileId = found.fileId; lib.folderId = found.folderId; lib.booksId = found.booksId; lib.remoteModified = found.modified || '';
      setStatus('Reading the library file (this can take a minute for a big library)…');
      var remote = parseLibrary(await Drive.text(found.fileId));
      setStatus('Sorting ' + Object.keys(remote.entries).length + ' books…');
      for (var fp in remote.entries) lib.entries[fp] = dirty[fp] ? mergeEntry(lib.entries[fp], remote.entries[fp]) : remote.entries[fp];
      if (found.booksId) {
        setStatus('Listing book files…');
        var files = await Drive.listBooks(found.booksId);
        lib.files = {};
        files.forEach(function (f) { lib.files[fingerprint(f.name, +f.size || 0)] = { id: f.id, name: f.name, size: +f.size || 0, modifiedTime: f.modifiedTime }; });
        try { lib.covers = await Drive.listCovers(found.folderId); } catch (e) { lib.covers = lib.covers || {}; }
      }
      lib.loadedAt = Date.now();
      saveCache(); rebuild(); buildDrawer(); render();
      hideNotice();
      if (!quiet) setStatus(books.length + ' books in the synced library', 4000);
    } catch (e) {
      setStatus('', 0);
      showNotice('Could not read Google Drive: ' + esc(e.message));
    }
  }

  // ---------- UI: status, notice, dialog ----------
  var statusTimer = null;
  // ---------- five-second cancel for removals ----------
  var undoTimer = null, undoRevert = null;
  function offerUndo(message, revert) {
    if (undoTimer) clearInterval(undoTimer);
    undoRevert = revert;
    var until = Date.now() + 5000, st = $('status');
    function draw() {
      var left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (left <= 0) { clearInterval(undoTimer); undoTimer = null; undoRevert = null; st.classList.add('hidden'); st.innerHTML = ''; return; }
      st.innerHTML = '<span>' + esc(message) + '</span> <button class="textBtn" id="undoBtn" style="margin-left:12px">Cancel (' + left + ')</button>';
      $('undoBtn').onclick = function () { var r = undoRevert; clearInterval(undoTimer); undoTimer = null; undoRevert = null; st.classList.add('hidden'); st.innerHTML = ''; if (r) r(); };
    }
    st.classList.remove('hidden'); draw();
    undoTimer = setInterval(draw, 250);
  }
  function snapshot(b) { var e = entryOf(b); return JSON.parse(JSON.stringify(e)); }
  function restore(b, snap, el) { var e = entryOf(b); for (var k in snap) e[k] = snap[k]; touch(b); if (el && document.body.contains(el)) refreshRow(b, el); render(); buildDrawer(); }

  function setStatus(text, ms) {
    var s = $('status');
    if (statusTimer) clearTimeout(statusTimer);
    if (!text) { s.classList.add('hidden'); return; }
    s.textContent = text; s.classList.remove('hidden');
    if (ms) statusTimer = setTimeout(function () { s.classList.add('hidden'); }, ms);
  }
  function showNotice(html) { $('notice').innerHTML = html; $('notice').classList.remove('hidden'); }
  function hideNotice() { $('notice').classList.add('hidden'); }
  function dialog(html, onOk, okLabel) {
    $('dialogBody').innerHTML = html;
    $('dialogOk').textContent = okLabel || 'Save';
    $('dialog').classList.remove('hidden');
    $('dialogOk').onclick = function () { if (onOk && onOk() === false) return; $('dialog').classList.add('hidden'); };
    $('dialogCancel').onclick = function () { $('dialog').classList.add('hidden'); };
  }

  // ---------- drawer ----------
  function collections() {
    var m = {};
    books.forEach(function (b) { if (b.entry && !b.entry.trashed) (b.entry.collections || []).forEach(function (c) { m[c] = (m[c] || 0) + 1; }); });
    return Object.keys(m).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }).map(function (k) { return { name: k, count: m[k] }; });
  }
  function count(shelf) { return books.filter(function (b) { return inShelf(b, shelf, null); }).length; }
  function inShelf(b, shelf, value) {
    var e = b.entry || {};
    if (shelf !== 'trash' && e.trashed) return false;
    switch (shelf) {
      case 'reading': return e.status === STATUS.READING;
      case 'all': return true;
      case 'favorites': return !!e.favorite;
      case 'toread': return e.status === STATUS.TO_READ;
      case 'finished': return e.status === STATUS.FINISHED;
      case 'collection': return value ? (e.collections || []).indexOf(value) >= 0 : (e.collections || []).length > 0;
      case 'author': return value ? b.author === value : true;
      case 'series': return value ? (e.series || '') === value : !!(e.series || '');
      case 'format': return value ? b.format === value : true;
      case 'trash': return !!e.trashed;
    }
    return true;
  }
  var titles = { reading: 'Reading Now', all: 'Books & documents', favorites: 'Favorites', toread: 'To Read', finished: 'Have Read', collection: 'Collections', author: 'Authors', series: 'Series', format: 'Formats', trash: 'Trash' };
  function buildDrawer() {
    var d = $('drawerItems'); d.innerHTML = '';
    function item(label, icon, shelf, value, sub) {
      var el = document.createElement('div');
      el.className = 'drawerItem' + (sub ? ' sub' : '') + (filter.shelf === shelf && filter.value === value ? ' selected' : '');
      el.innerHTML = (ICON[icon] ? svg(icon) : '<span>' + icon + '</span>') + '<span>' + esc(label) + '</span><span class="count">' + count2(shelf, value) + '</span>';
      el.onclick = function () { filter = { shelf: shelf, value: value }; rememberFilter(); closeDrawer(); render(); buildDrawer(); };
      d.appendChild(el);
    }
    function count2(shelf, value) { return books.filter(function (b) { return inShelf(b, shelf, value); }).length; }
    function sep() { var s = document.createElement('div'); s.className = 'drawerSep'; d.appendChild(s); }
    item('Reading Now', 'reading', 'reading', null);
    item('Books & documents', 'all', 'all', null);
    item('Favorites', 'star', 'favorites', null);
    item('To Read', 'clock', 'toread', null);
    item('Have Read', 'doneAll', 'finished', null);
    item('Authors', 'person', 'author', null);
    item('Series', 'series', 'series', null);
    item('Collections', 'collections', 'collection', null);
    collections().forEach(function (c) { item(c.name, '', 'collection', c.name, true); });
    item('Formats', 'layers', 'format', null);
    item('Trash', 'trash', 'trash', null);
    sep();
    var s = document.createElement('div'); s.className = 'drawerItem'; s.innerHTML = svg('settings') + '<span>Settings</span>';
    s.onclick = function () { closeDrawer(); settings(); }; d.appendChild(s);
  }
  function openDrawer() { $('drawer').classList.remove('hidden'); $('scrim').classList.remove('hidden'); }
  function closeDrawer() { $('drawer').classList.add('hidden'); $('scrim').classList.add('hidden'); }

  // ---------- list ----------
  function visible() {
    var q = search.trim().toLowerCase();
    var rows = books.filter(function (b) { return inShelf(b, filter.shelf, filter.value) && (!q || (b.title + ' ' + b.author + ' ' + b.name).toLowerCase().indexOf(q) >= 0); });
    var key = {
      recent: function (a, b) { var ao = (a.entry && a.entry.lastOpened) || 0, bo = (b.entry && b.entry.lastOpened) || 0; if (ao !== bo) return bo - ao; return b.modified - a.modified; },
      newest: function (a, b) { return b.modified - a.modified || a.title.localeCompare(b.title); },
      title: function (a, b) { return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }); },
      author: function (a, b) { return (a.author || '￿').localeCompare(b.author || '￿', undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title); },
    }[sort];
    return rows.sort(key);
  }
  function render() {
    $('shelfTitle').textContent = filter.value ? filter.value : titles[filter.shelf];
    var list = $('list'); list.innerHTML = ''; shown = 0;
    if ((filter.shelf === 'author' || filter.shelf === 'format' || filter.shelf === 'series') && !filter.value) {
      var groups = {};
      books.forEach(function (b) { if (!b.entry || !b.entry.trashed) { var k = filter.shelf === 'author' ? (b.author || 'Unknown author') : filter.shelf === 'series' ? ((b.entry && b.entry.series) || '') : b.format; if (k) groups[k] = (groups[k] || 0) + 1; } });
      Object.keys(groups).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }).forEach(function (g) {
        var el = document.createElement('div'); el.className = 'book'; el.style.padding = '14px 16px';
        el.innerHTML = '<div class="info"><div class="title">' + esc(g) + '</div><div class="meta">' + groups[g] + ' books</div></div>';
        el.onclick = function () { filter = { shelf: filter.shelf, value: g === 'Unknown author' ? '' : g }; rememberFilter(); render(); };
        list.appendChild(el);
      });
      return;
    }
    renderMore();
  }
  var rowsCache = null;
  function renderMore() {
    if (shown === 0) rowsCache = visible();
    var rows = rowsCache, list = $('list');
    if (shown === 0 && !rows.length) { list.innerHTML = '<p class="muted" style="text-align:center;padding:40px">Nothing here yet.</p>'; return; }
    var end = Math.min(rows.length, shown + 80);
    for (var i = shown; i < end; i++) list.appendChild(row(rows[i]));
    shown = end;
  }
  new IntersectionObserver(function (es) { if (es[0].isIntersecting && rowsCache && shown < rowsCache.length) renderMore(); }, { root: $('main') }).observe($('sentinel'));

  function row(b) {
    var e = b.entry || {};
    var el = document.createElement('div');
    el.className = 'book' + (b.file ? '' : ' missing');
    var pct = Math.round((e.progress || 0) * 100);
    el.innerHTML =
      '<div class="cover" title="Open">' + esc(b.title) + '</div>' +
      '<div class="info"><div class="title">' + esc(b.title) + '</div>' +
      '<div class="author">' + esc(b.author || 'Unknown author') + '</div>' +
      '<div class="meta">' + b.format + ', ' + sizeText(b.size) + (b.file ? '' : ' · not uploaded from the phone yet') + (e.trashed ? ' · in the trash' : '') + '</div>' +
      '<div class="pbar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="actions">' +
      '<button class="fav' + (e.favorite ? ' on' : '') + '" title="Favorite">' + svg(e.favorite ? 'starOn' : 'star') + '</button>' +
      '<button class="toread' + (e.status === STATUS.TO_READ ? ' on' : '') + '" title="To Read">' + svg('clock') + '</button>' +
      '<button class="done' + (e.status === STATUS.FINISHED ? ' on' : '') + '" title="Have Read">' + svg('doneAll') + '</button>' +
      '<button class="coll' + ((e.collections || []).length ? ' on' : '') + '" title="Collections">' + svg('collections') + ((e.collections || []).length ? '<sup>' + e.collections.length + '</sup>' : '') + '</button>' +
      '<button class="more" title="More">' + svg('more') + '</button></div></div>';
    loadCover(b, el.querySelector('.cover'));
    el.querySelector('.cover').onclick = function () { openBook(b); };
    el.querySelector('.title').onclick = function () { openBook(b); };
    el.querySelector('.fav').onclick = function () { var x = entryOf(b), snap = snapshot(b); x.favorite = !x.favorite; touch(b); refreshRow(b, el); if (!x.favorite) offerUndo('Removed from Favorites', function () { restore(b, snap); }); };
    el.querySelector('.toread').onclick = function () { var x = entryOf(b), snap = snapshot(b); var off = x.status === STATUS.TO_READ; x.status = off ? STATUS.NONE : STATUS.TO_READ; touch(b); refreshRow(b, el); if (off) offerUndo('Removed from To Read', function () { restore(b, snap); }); };
    el.querySelector('.done').onclick = function () { var x = entryOf(b), snap = snapshot(b); var off = x.status === STATUS.FINISHED; if (off) x.status = STATUS.NONE; else { x.status = STATUS.FINISHED; x.progress = 1; } touch(b); refreshRow(b, el); if (off) offerUndo('Removed from Have Read', function () { restore(b, snap); }); };
    el.querySelector('.coll').onclick = function () { chooseCollections(b, el); };
    el.querySelector('.more').onclick = function () { moreMenu(b, el); };
    return el;
  }
  function refreshRow(b, el) { var n = row(b); el.parentNode.replaceChild(n, el); buildDrawer(); }

  function chooseCollections(b, el) {
    var all = collections().map(function (c) { return c.name; }), mine = (b.entry && b.entry.collections) || [];
    var html = '<h3 style="margin-top:0">Collections</h3>' + all.map(function (c, i) { return '<label><input type="checkbox" data-i="' + i + '"' + (mine.indexOf(c) >= 0 ? ' checked' : '') + '> ' + esc(c) + '</label>'; }).join('') +
      '<label>New collection: <input type="text" id="newColl" placeholder="e.g. Eros\\smut\\short"></label>';
    dialog(html, function () {
      var chosen = [];
      document.querySelectorAll('#dialogBody input[type=checkbox]').forEach(function (cb) { if (cb.checked) chosen.push(all[+cb.dataset.i]); });
      var n = $('newColl').value.trim(); if (n) chosen.push(n);
      entryOf(b).collections = chosen; touch(b); refreshRow(b, el);
    });
  }
  function moreMenu(b, el) {
    var e = entryOf(b);
    var html = '<h3 style="margin-top:0">' + esc(b.title) + '</h3><div class="muted">' + esc(b.author) + '<br>' + b.format + ', ' + sizeText(b.size) + '<br>' + esc(b.name) + '</div>' +
      '<label>Title <input type="text" id="edTitle" value="' + esc(b.title) + '"></label><label>Author <input type="text" id="edAuthor" value="' + esc(b.author) + '"></label>' +
      '<div class="row">' + (b.file ? '<a class="textBtn" target="_blank" rel="noopener" href="https://drive.google.com/file/d/' + b.file.id + '/view">Open in Drive</a>' : '') +
      '<button class="textBtn" id="edTrash">' + (e.trashed ? 'Restore from trash' : 'Move to Trash') + '</button>' +
      '<button class="textBtn" id="edRemove">' + (e.status === STATUS.READING ? 'Remove from Reading Now' : '') + '</button>' +
      (b.file ? '<button class="textBtn" id="edKeep">Keep on this device (read offline)</button>' : '') + '</div>';
    dialog(html, function () {
      e.title = $('edTitle').value.trim() || b.title; e.author = $('edAuthor').value.trim(); b.title = e.title; b.author = e.author; touch(b); refreshRow(b, el);
    });
    $('edTrash').onclick = function () { var snap = snapshot(b); e.trashed = !e.trashed; touch(b); $('dialog').classList.add('hidden'); refreshRow(b, el); render(); if (e.trashed) offerUndo('Moved to Trash', function () { restore(b, snap); }); };
    $('edRemove').onclick = function () { var snap = snapshot(b); e.status = STATUS.NONE; touch(b); $('dialog').classList.add('hidden'); refreshRow(b, el); render(); offerUndo('Removed from Reading Now', function () { restore(b, snap); }); };
    var keepBtn = $('edKeep');
    if (keepBtn) keepBtn.onclick = function () {
      keepBtn.textContent = 'Downloading…';
      idbGet('files', b.file.id).then(function (have) {
        if (have) { keepBtn.textContent = 'Kept on this device'; return; }
        return Drive.bytes(b.file.id, function (got, total) { keepBtn.textContent = 'Downloading… ' + Math.round(got / 1048576) + ' MB'; }).then(function (buf) {
          return idbPut('files', b.file.id, buf).then(function () { keepBtn.textContent = 'Kept on this device'; });
        });
      }).catch(function (e) { keepBtn.textContent = 'Could not download: ' + e.message; });
    };
  }

  // ---------- covers (cached once a book has been opened) ----------
  var coverDb = null;
  function idb() {
    if (coverDb) return Promise.resolve(coverDb);
    return new Promise(function (res, rej) {
      var r = indexedDB.open('otoreader', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('covers'); r.result.createObjectStore('files'); };
      r.onsuccess = function () { coverDb = r.result; res(coverDb); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(store, key) { return idb().then(function (db) { return new Promise(function (res) { var t = db.transaction(store).objectStore(store).get(key); t.onsuccess = function () { res(t.result); }; t.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function idbPut(store, key, val) { return idb().then(function (db) { return new Promise(function (res) { var t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = res; t.onerror = res; }); }).catch(function () {}); }
  var coverQueue = [], coverBusy = 0;
  function showCover(el, blob) { var img = document.createElement('img'); img.src = URL.createObjectURL(blob); img.alt = ''; el.textContent = ''; el.appendChild(img); }
  function loadCover(b, el) {
    idbGet('covers', b.fp).then(function (blob) {
      if (blob) { showCover(el, blob); return; }
      var id = lib.covers && (lib.covers[(b.name + '.jpg').toLowerCase()] || lib.covers[b.name + '.jpg']);
      if (!id || !Drive.signedIn()) return;
      coverQueue.push({ b: b, el: el, id: id }); pumpCovers();
    });
  }
  function pumpCovers() { // a few downloads at a time, only for rows that are on screen
    while (coverBusy < 4 && coverQueue.length) {
      var job = coverQueue.shift();
      if (!document.body.contains(job.el)) continue;
      coverBusy++;
      (function (job) {
        Drive.bytes(job.id).then(function (buf) {
          var blob = new Blob([buf], { type: 'image/jpeg' });
          idbPut('covers', job.b.fp, blob); if (document.body.contains(job.el)) showCover(job.el, blob);
        }).catch(function () {}).then(function () { coverBusy--; pumpCovers(); });
      })(job);
    }
  }

  // ---------- settings ----------
  function settings() {
    var html = '<h3 style="margin-top:0">Settings</h3><p class="muted">OtoReader ' + APP_VERSION + (navigator.onLine ? '' : ' · offline, showing the saved copy') + '. Signed in: ' + (Drive.signedIn() ? 'yes' : 'no') + '. Library loaded ' + (lib.loadedAt ? new Date(lib.loadedAt).toLocaleString() : 'never') + '.</p>' +
      '<div class="row"><button class="textBtn" id="stReload">Reload from Google Drive</button><button class="textBtn" id="stUpdate">Get the latest version</button><button class="textBtn" id="stSignOut">Sign out</button></div>' +
      '<div class="row"><button class="textBtn" id="stClientId">Change client ID</button><button class="textBtn" id="stLocal">Open a file from this computer</button></div>';
    dialog(html, null, 'Close');
    $('stReload').onclick = function () { $('dialog').classList.add('hidden'); loadFromDrive(true); };
    $('stUpdate').onclick = function () { $('dialog').classList.add('hidden'); getLatest(); };
    $('stSignOut').onclick = function () { Drive.signOut(); $('accountBtn').textContent = 'Sign in'; $('dialog').classList.add('hidden'); };
    $('stClientId').onclick = function () { $('dialog').classList.add('hidden'); $('setup').classList.remove('hidden'); $('clientIdInput').value = Drive.clientId(); };
    $('stLocal').onclick = function () { $('dialog').classList.add('hidden'); $('fileInput').click(); };
  }

  // ---------- reader ----------
  var R = { book: null, doc: null, section: 0, urls: [], row: null, pages: 0, page: 0, pendingFraction: 0, pendingAnchor: '', ready: false };
  var opts = loadOpts();
  function loadOpts() { try { return Object.assign({ theme: 0, size: 100, font: 0, line: 15, margin: 24, paged: true, justify: false, ttsRate: 1, ttsVoice: '' }, JSON.parse(localStorage.getItem('oto.opts') || '{}')); } catch (e) { return { theme: 0, size: 100, font: 0, line: 15, margin: 24, paged: true, justify: false, ttsRate: 1, ttsVoice: '' }; } }
  function saveOpts() { try { localStorage.setItem('oto.opts', JSON.stringify(opts)); } catch (e) {} }

  async function openBook(b) {
    if (!b.file) { setStatus('This book has not been uploaded from the phone yet. On the phone, Settings → Sync now (with "copy book files" on).', 6000); return; }
    var ext = b.name.toLowerCase().split('.').pop();
    if (!Books.canOpen(b.name)) { setStatus(b.format + ' books can be read on the phone for now; here: EPUB, Kindle (MOBI, AZW, AZW3), Word (DOCX), FB2, RTF, ODT, comics (CBZ, CBR), TXT and PDF.', 6000); return; }
    showReader(); $('loading').classList.remove('hidden'); $('loading').textContent = 'Downloading…';
    try {
      var buf = await idbGet('files', b.file.id);
      if (!buf) {
        buf = await Drive.bytes(b.file.id, function (got, total) { $('loading').textContent = 'Downloading… ' + sizeText(got) + (total ? ' of ' + sizeText(total) : ''); });
        if (buf.byteLength < 40 * 1048576) idbPut('files', b.file.id, buf);
      }
      if (ext === 'pdf') { showPdf(b, buf); return; }
      await startDocument(b, await Books.open(buf, b.name));
    } catch (e) {
      $('loading').classList.add('hidden');
      alert('Could not open the book: ' + e.message);
      hideReader();
    }
  }
  /** Uploads files to the Books folder in Drive and lists them, so the phone (and ReadEra, through the phone) gets them at the next sync. */
  async function addBooks(files) {
    files = files.filter(function (f) { return Books.canOpen(f.name); });
    if (!files.length) { setStatus('No book files among those.', 4000); return; }
    try {
      await Drive.signIn(false);
      if (!lib.booksId) { var found = await Drive.ensureLibrary(); lib.fileId = found.fileId; lib.folderId = found.folderId; lib.booksId = found.booksId; }
      var done = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i], fp = fingerprint(f.name, f.size);
        if (lib.files[fp]) { done++; continue; }
        setStatus('Uploading ' + f.name + ' (' + (i + 1) + ' of ' + files.length + ')…', 0);
        var up = await Drive.upload(lib.booksId, f, function (sent, total) { setStatus('Uploading ' + f.name + ': ' + Math.round(100 * sent / total) + '% (' + (i + 1) + ' of ' + files.length + ')', 0); });
        lib.files[fp] = { id: up.id, name: f.name, size: f.size, modifiedTime: up.modifiedTime || new Date().toISOString() };
        var e = lib.entries[fp] || { title: stem(f.name), author: '', progress: 0, position: null, status: 0, favorite: false, lastOpened: 0, updated: 0, trashed: false, collections: [], bookmarks: [] };
        lib.entries[fp] = e; e.updated = Date.now(); dirty[fp] = 1;
        done++;
        rebuild(); buildDrawer(); render();
      }
      await flush();
      setStatus(done + ' book' + (done === 1 ? '' : 's') + ' added. The phone picks them up at its next sync.', 6000);
    } catch (e) {
      setStatus('Could not add: ' + e.message, 8000);
    }
  }

  function openLocalFile(file) {
    var ext = file.name.toLowerCase().split('.').pop();
    showReader(); $('loading').classList.remove('hidden'); $('loading').textContent = 'Opening…';
    file.arrayBuffer().then(function (buf) {
      var b = { fp: fingerprint(file.name, file.size), name: file.name, title: stem(file.name), author: '', format: formatOf(file.name), size: file.size, file: null, entry: null, local: true };
      local = b;
      if (ext === 'pdf') { showPdf(b, buf); return; }
      return Promise.resolve(Books.open(buf, file.name)).then(function (d) { return startDocument(b, d); });
    }).catch(function (e) { $('loading').classList.add('hidden'); alert('Could not open the file: ' + e.message); hideReader(); });
  }
  function showPdf(b, buf) {
    var url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    R.book = b; R.doc = null; R.urls = [url];
    $('rTitle').textContent = b.title; $('rChapter').textContent = 'PDF';
    $('frame').removeAttribute('srcdoc'); $('frame').src = url;
    $('loading').classList.add('hidden');
    markOpened(b);
  }
  async function startDocument(b, doc) {
    R.book = b; R.doc = doc;
    if (doc.title && !b.author && doc.authors.length) { b.author = doc.authors.join(', '); }
    $('rTitle').textContent = b.title;
    var cu = doc.coverUrl();
    if (cu && !b.local) fetch(cu).then(function (r) { return r.blob(); }).then(function (blob) { idbPut('covers', b.fp, blob); }).catch(function () {});
    buildToc();
    markOpened(b);
    var pos = (b.entry && b.entry.position) || null, s = 0, f = 0;
    if (pos && pos.indexOf('ratio:') === 0) {
      var target = Math.max(0, Math.min(1, +pos.substring(6) || 0)) * doc.total;
      while (s < doc.spine.length - 1 && doc.cum[s + 1] <= target) s++;
      f = Math.max(0, Math.min(1, (target - doc.cum[s]) / doc.sizes[s]));
    } else if (pos) { var p = pos.split(':'); s = +p[0] || 0; f = +p[1] || 0; }
    loadSection(Math.min(s, doc.spine.length - 1), f, '');
  }
  function markOpened(b) {
    if (b.local) return;
    var e = entryOf(b);
    e.lastOpened = Date.now();
    if (e.status === STATUS.NONE || e.status === STATUS.TO_READ) e.status = STATUS.READING;
    touch(b);
  }

  function readerCss() {
    var t = [['#FFFFFF', '#1C1C1C', '#1A5FA8'], ['#F6ECD9', '#4A3B2A', '#7A4E1E'], ['#1E2228', '#D6DAE0', '#8FBCE8'], ['#000000', '#C8C8C8', '#7FA7D0']][opts.theme] || ['#FFFFFF', '#1C1C1C', '#1A5FA8'];
    var font = opts.font == 1 ? "body, body * { font-family: Georgia, 'Times New Roman', serif !important; }" : opts.font == 2 ? "body, body * { font-family: Roboto, 'Helvetica Neue', Arial, sans-serif !important; }" : '';
    var lh = 1 + opts.line / 10;
    var hl = opts.theme >= 2 ? 'rgba(242,177,52,0.35)' : '#F2E3A8';
    return '::highlight(tts) { background-color: ' + hl + '; } span.tts-hl { background-color: ' + hl + '; }' +
      'html { background: ' + t[0] + ' !important; font-size: ' + opts.size + '% !important; }' +
      'body { color: ' + t[1] + ' !important; background: ' + t[0] + ' !important; line-height: ' + lh + ' !important; word-wrap: break-word; }' +
      'body * { color: ' + t[1] + ' !important; background-color: transparent !important; background-image: none !important; }' +
      'body p, body div, body li, body td { line-height: inherit !important; }' +
      'a, a * { color: ' + t[2] + ' !important; }' +
      'img, svg, video, canvas, image { max-width: 100% !important; max-height: calc(100vh - ' + (2 * opts.margin + 40) + 'px) !important; height: auto; object-fit: contain; break-inside: avoid; }' +
      'table { max-width: 100% !important; } pre { white-space: pre-wrap !important; } p { orphans: 2; widows: 2; } h1,h2,h3,h4 { break-after: avoid; }' +
      'body > #__root > *:first-child { margin-top: 0; }' + font + (opts.justify ? ' body p { text-align: justify !important; }' : '');
  }
  function readerConfig() { return { paged: !!opts.paged, marginX: opts.margin, marginTop: opts.margin + 8, marginBottom: opts.margin + 12, lineHeight: 1 + opts.line / 10, justify: !!opts.justify, font: opts.font }; }

  function loadSection(i, fraction, anchor, toEnd) {
    var doc = R.doc; if (!doc) return;
    R.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    R.section = Math.max(0, Math.min(doc.spine.length - 1, i));
    R.pendingFraction = toEnd ? 1 : (fraction || 0); R.pendingAnchor = anchor || ''; R.ready = false;
    var sec = doc.section(R.section);
    R.urls = sec.urls;
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>' + sec.css + '</style><style>' + readerCss() + '</style></head><body>' + sec.html +
      '<script>window.__readerConfig=' + JSON.stringify(readerConfig()) + ';window.Reader={onReady:function(n){parent.__readerEvent("ready",n)},onPage:function(p,n){parent.__readerEvent("page",p,n)},onLink:function(h){parent.__readerEvent("link",h)}};' +
      'document.addEventListener("click",function(e){if(e.target.closest&&e.target.closest("a[href]"))return;parent.__readerEvent("tap",e.clientX/window.innerWidth)});' +
      'document.addEventListener("keydown",function(e){parent.__readerEvent("key",e.key)});<\/script>' +
      '<script>' + window.READER_JS + '<\/script></body></html>';
    $('loading').classList.remove('hidden'); $('loading').textContent = 'Loading…';
    $('frame').removeAttribute('src');
    $('frame').srcdoc = html;
    $('rChapter').textContent = chapterLabel();
    highlightToc();
  }
  function chapterLabel() {
    var best = '', bs = -1;
    (R.doc.toc || []).forEach(function (t) { if (t.section <= R.section && t.section > bs) { bs = t.section; best = t.label; } });
    return best;
  }
  window.__readerEvent = function (kind, a, b) {
    var fw = $('frame').contentWindow, rd = fw && fw.__reader;
    if (kind === 'ready') {
      R.ready = true; $('loading').classList.add('hidden');
      if (R.pendingAnchor) rd.goToAnchor(R.pendingAnchor); else rd.goToFraction(R.pendingFraction);
      if (ttsContinue) { ttsContinue = false; startTts(0); }
    } else if (kind === 'page') {
      R.page = a; R.pages = b; updatePosition();
    } else if (kind === 'link') {
      var m = /^oto:(\d+)#?(.*)$/.exec(a || '');
      if (m) loadSection(+m[1], 0, m[2]); else if (/^#/.test(a)) rd.goToAnchor(a.substring(1)); else if (/^https?:/.test(a)) window.open(a, '_blank');
    } else if (kind === 'tap') {
      if (a < 0.22) prev(); else if (a > 0.78) next(); else toggleBars();
    } else if (kind === 'key') { key(a); }
  };
  function updatePosition() {
    var doc = R.doc; if (!doc) return;
    var fw = $('frame').contentWindow, rd = fw && fw.__reader; if (!rd) return;
    var f = rd.fraction();
    var progress = Math.min(1, (doc.cum[R.section] + f * doc.sizes[R.section]) / doc.total);
    $('progress').value = Math.round(progress * 1000);
    $('pageInfo').textContent = (R.page + 1) + ' / ' + R.pages + ' · ' + Math.round(progress * 100) + '%';
    if (!R.book || R.book.local) return;
    var e = entryOf(R.book);
    e.position = R.section + ':' + f.toFixed(4); e.progress = progress;
    if (e.status === STATUS.FINISHED && progress < 0.03) e.status = STATUS.READING; // read again from the start
    if (R.section === doc.spine.length - 1 && R.page >= R.pages - 1 && progress > 0.97) e.status = STATUS.FINISHED;
    if (posTimer) clearTimeout(posTimer);
    posTimer = setTimeout(function () { touch(R.book); }, 1500);
  }
  var posTimer = null;
  function next() { var rd = $('frame').contentWindow.__reader; if (!rd || !R.doc) return; if (!rd.next()) { if (R.section < R.doc.spine.length - 1) loadSection(R.section + 1, 0, ''); } }
  function prev() { var rd = $('frame').contentWindow.__reader; if (!rd || !R.doc) return; if (!rd.prev()) { if (R.section > 0) loadSection(R.section - 1, 0, '', true); } }
  function key(k) {
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') next();
    else if (k === 'ArrowLeft' || k === 'PageUp') prev();
    else if (k === 'Escape') hideReader();
  }
  document.addEventListener('keydown', function (e) { if ($('reader').classList.contains('hidden')) return; if (e.key !== 'Escape' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return; key(e.key); });
  function toggleBars() { $('readerTop').classList.toggle('off'); $('readerBottom').classList.toggle('off'); }

  function buildToc() {
    var t = $('tocItems'); t.innerHTML = '';
    (R.doc.toc || []).forEach(function (e, i) {
      var el = document.createElement('div'); el.className = 'tocItem d' + Math.min(2, e.depth); el.textContent = e.label || ('Section ' + (e.section + 1)); el.dataset.i = i;
      el.onclick = function () { loadSection(e.section, 0, e.fragment); $('toc').classList.add('hidden'); };
      t.appendChild(el);
    });
  }
  function highlightToc() {
    var items = $('tocItems').children, cur = -1;
    var bs = -1;
    (R.doc.toc || []).forEach(function (e, i) { if (e.section <= R.section && e.section > bs) { bs = e.section; cur = i; } });
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('current', i === cur);
  }

  function showReader() { $('reader').classList.remove('hidden'); $('readerTop').classList.remove('off'); $('readerBottom').classList.remove('off'); }
  function hideReader() {
    Tts.stop();
    if (posTimer) { clearTimeout(posTimer); posTimer = null; if (R.book && !R.book.local) touch(R.book); }
    $('reader').classList.add('hidden');
    $('frame').removeAttribute('srcdoc'); $('frame').removeAttribute('src');
    R.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    R.book = null; R.doc = null; local = null;
    ['toc', 'display', 'ttsPanel'].forEach(function (id) { $(id).classList.add('hidden'); });
    render(); buildDrawer();
  }

  // display options
  function bindOpts() {
    $('optTheme').value = opts.theme; $('optSize').value = opts.size; $('optSizeV').textContent = opts.size; $('optFont').value = opts.font;
    $('optLine').value = opts.line; $('optMargin').value = opts.margin; $('optPaged').checked = !!opts.paged; $('optJustify').checked = !!opts.justify;
    function apply() {
      opts.theme = +$('optTheme').value; opts.size = +$('optSize').value; $('optSizeV').textContent = opts.size; opts.font = +$('optFont').value;
      opts.line = +$('optLine').value; opts.margin = +$('optMargin').value; opts.paged = $('optPaged').checked; opts.justify = $('optJustify').checked;
      saveOpts();
      if (R.doc) { var rd = $('frame').contentWindow.__reader; var f = rd ? rd.fraction() : 0; loadSection(R.section, f, ''); }
    }
    ['optTheme', 'optSize', 'optFont', 'optLine', 'optMargin', 'optPaged', 'optJustify'].forEach(function (id) { $(id).onchange = apply; });
  }

  // read aloud
  var ttsContinue = false;
  function fillVoices() {
    var sel = $('ttsVoice'), vs = Tts.voices();
    sel.innerHTML = '';
    vs.forEach(function (v) { var o = document.createElement('option'); o.value = v.name; o.textContent = v.name + ' (' + v.lang + ')'; sel.appendChild(o); });
    if (!opts.ttsVoice || !vs.some(function (v) { return v.name === opts.ttsVoice; })) opts.ttsVoice = Tts.defaultVoice();
    sel.value = opts.ttsVoice;
  }
  function startTts(fromCurrentPage) {
    var fw = $('frame').contentWindow, rd = fw && fw.__reader; if (!rd || !R.doc) return;
    var doc = fw.document, root = doc.getElementById('__root') || doc.body;
    var blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, td, div');
    var items = [], startIdx = 0, startEl = null;
    if (fromCurrentPage !== 0) {
      var cfg = fw.__readerConfig || {};
      for (var y = 0; y < 8 && !startEl; y++) { var el = doc.elementFromPoint((cfg.marginX || 16) + 10, (cfg.marginTop || 24) + 10 + y * 30); if (el && el !== root && el !== doc.body) startEl = el; }
    }
    var n = 0;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.querySelector('p, h1, h2, h3, h4, li, blockquote, div')) continue; // container, children carry the text
      var text = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!b.id) b.id = '__tts' + (n++);
      if (startEl && (b === startEl || b.contains(startEl) || startEl.contains(b)) && !startIdx) startIdx = items.length;
      Tts.split(text).forEach(function (s) { items.push({ text: s, id: b.id }); });
    }
    if (!items.length) { if (R.section < R.doc.spine.length - 1) { ttsContinue = true; loadSection(R.section + 1, 0, ''); } return; }
    Tts.setRate(opts.ttsRate); Tts.setVoice(opts.ttsVoice);
    Tts.play(items, startIdx, function (id, text) { try { if (!rd.highlight(text, true)) rd.goToAnchor(id); } catch (e) {} }, function () {
      if (R.section < R.doc.spine.length - 1) { ttsContinue = true; loadSection(R.section + 1, 0, ''); }
      else $('ttsPlay').textContent = 'Play';
    });
    $('ttsPlay').textContent = 'Pause';
  }

  // ---------- wiring ----------
  function boot() {
    $('originBox').textContent = location.origin.indexOf('http') === 0 ? location.origin : '(open this page over https for Google sign-in to work)';
    $('copyOrigin').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(location.origin); };
    $('saveClientId').onclick = function () { var v = $('clientIdInput').value.trim(); if (!v) return; Drive.setClientId(v); $('setup').classList.add('hidden'); Drive.signIn(true).then(function () { loadFromDrive(true); }).catch(function (e) { showNotice('Sign-in failed: ' + esc(e.message)); }); };
    $('openLocal').onclick = function () { $('fileInput').click(); };
    $('fileInput').onchange = function () { if (this.files[0]) openLocalFile(this.files[0]); this.value = ''; };
    $('menuBtn').onclick = openDrawer; $('scrim').onclick = closeDrawer;
    $('search').oninput = function () { search = this.value; render(); };
    $('searchBtn').onclick = function () { var s = $('search'); s.classList.toggle('hidden'); if (!s.classList.contains('hidden')) s.focus(); else { s.value = ''; search = ''; render(); } };
    try { sort = localStorage.getItem('oto.sort') || 'recent'; } catch (e) {}
    function markSort() { document.querySelectorAll('.sortItem').forEach(function (i) { i.classList.toggle('on', i.dataset.sort === sort); }); }
    markSort();
    $('moreBtn').onclick = function (ev) { ev.stopPropagation(); $('moreMenu').classList.toggle('hidden'); };
    document.addEventListener('click', function (ev) { if (!$('moreMenu').contains(ev.target)) $('moreMenu').classList.add('hidden'); });
    document.querySelectorAll('.sortItem').forEach(function (i) { i.onclick = function () { sort = i.dataset.sort; try { localStorage.setItem('oto.sort', sort); } catch (e) {} markSort(); $('moreMenu').classList.add('hidden'); render(); }; });
    document.querySelectorAll('#moreMenu [data-act]').forEach(function (i) {
      i.onclick = function () {
        $('moreMenu').classList.add('hidden');
        if (i.dataset.act === 'add') $('addInput').click();
        else if (i.dataset.act === 'open') $('fileInput').click();
        else if (i.dataset.act === 'settings') settings();
        else if (i.dataset.act === 'update') getLatest();
      };
    });
    $('addInput').onchange = function () { addBooks(Array.prototype.slice.call(this.files)); this.value = ''; };
    var dragDepth = 0;
    document.addEventListener('dragenter', function (ev) { if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') >= 0 && $('reader').classList.contains('hidden')) { dragDepth++; $('dropHint').classList.remove('hidden'); } });
    document.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) { ev.preventDefault(); dragDepth = 0; $('dropHint').classList.add('hidden'); if (ev.dataTransfer && ev.dataTransfer.files.length && $('reader').classList.contains('hidden')) addBooks(Array.prototype.slice.call(ev.dataTransfer.files)); });
    $('syncBtn').onclick = function () { if (Object.keys(dirty).length) flush().then(function () { loadFromDrive(true); }); else loadFromDrive(true); };
    $('refreshBtn').onclick = function () { rebuild(); buildDrawer(); render(); checkForUpdates(true); };
    $('accountBtn').onclick = function () {
      if (!Drive.clientId()) { $('setup').classList.remove('hidden'); return; }
      Drive.signIn(true).then(function () { loadFromDrive(true); }).catch(function (e) { showNotice('Sign-in failed: ' + esc(e.message)); });
    };
    // staying signed in (quiet renewal before the token runs out) lives in drive.js
    $('backBtn').onclick = hideReader;
    $('prevBtn').onclick = prev; $('nextBtn').onclick = next;
    $('tapLeft').onclick = prev; $('tapRight').onclick = next;
    $('progress').oninput = function () {
      var doc = R.doc; if (!doc) return;
      var target = (this.value / 1000) * doc.total, s = 0;
      while (s < doc.spine.length - 1 && doc.cum[s + 1] <= target) s++;
      var f = (target - doc.cum[s]) / doc.sizes[s];
      if (s === R.section) { var rd = $('frame').contentWindow.__reader; if (rd) rd.goToFraction(f); } else loadSection(s, f, '');
    };
    $('tocBtn').onclick = function () { $('toc').classList.toggle('hidden'); $('display').classList.add('hidden'); $('ttsPanel').classList.add('hidden'); };
    $('displayBtn').onclick = function () { $('display').classList.toggle('hidden'); $('toc').classList.add('hidden'); $('ttsPanel').classList.add('hidden'); };
    $('ttsBtn').onclick = function () { $('ttsPanel').classList.toggle('hidden'); $('toc').classList.add('hidden'); $('display').classList.add('hidden'); fillVoices(); };
    document.querySelectorAll('.closeSide').forEach(function (b) { b.onclick = function () { b.closest('.side').classList.add('hidden'); }; });
    bindOpts();
    $('ttsRate').value = opts.ttsRate; $('ttsRateV').textContent = opts.ttsRate;
    $('ttsRate').oninput = function () { opts.ttsRate = +this.value; $('ttsRateV').textContent = opts.ttsRate; saveOpts(); Tts.setRate(opts.ttsRate); if (Tts.playing()) { Tts.pause(); Tts.resume(); } };
    $('ttsVoice').onchange = function () { opts.ttsVoice = this.value; saveOpts(); Tts.setVoice(opts.ttsVoice); if (Tts.playing()) { Tts.pause(); Tts.resume(); } };
    $('ttsPlay').onclick = function () { if (Tts.playing()) { Tts.pause(); this.textContent = 'Play'; } else { startTts(1); } };
    $('ttsStop').onclick = function () { Tts.stop(); $('ttsPlay').textContent = 'Play'; try { $('frame').contentWindow.__reader.clearHighlight(); } catch (e) {} };
    if (window.speechSynthesis) speechSynthesis.onvoiceschanged = function () { if (!$('ttsPanel').classList.contains('hidden')) fillVoices(); };

    loadCache(); rebuild(); buildDrawer(); render();
    document.title = 'OtoReader';
    function offlineNote() { if (!navigator.onLine) setStatus('No internet connection: this is the saved copy of your library. It refreshes when the connection is back.', 0); }
    window.addEventListener('offline', offlineNote);
    window.addEventListener('online', function () { setStatus('Back online: syncing…', 2000); flush().then(function () { loadFromDrive(true); }); });
    offlineNote();
    checkVersion(); setInterval(checkVersion, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkVersion(); });
    if (!Drive.clientId()) { $('setup').classList.remove('hidden'); return; }
    var tries = 0;
    (function waitGoogle() { if (window.google && google.accounts) loadFromDrive(false); else if (tries++ < 50) setTimeout(waitGoogle, 200); else showNotice('Google sign-in did not load. Check the connection and reload.'); })();
  }
  // "Install": Chrome and Edge offer to put the page on the desktop / start menu as its own window
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; $('installBtn').classList.remove('hidden'); });
  window.addEventListener('appinstalled', function () { $('installBtn').classList.add('hidden'); installPrompt = null; });
  document.addEventListener('DOMContentLoaded', function () {
    $('installBtn').onclick = function () { if (installPrompt) { installPrompt.prompt(); } };
  });

  document.addEventListener('DOMContentLoaded', boot);
})();
