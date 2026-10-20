/* app.js — OtoReader on the web: the library and the reader, synced through the phone's Google Drive folder. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var STATUS = { NONE: 0, READING: 1, TO_READ: 2, FINISHED: 3 };

  // ---------- state ----------
  var lib = { fileId: null, folderId: null, booksId: null, entries: {}, files: {}, loadedAt: 0 };
  var books = [];            // merged rows
  var dirty = {};            // fingerprints changed here and not yet written
  var filter = { shelf: 'reading', value: null };
  var search = '', sort = 'recent', shown = 0;
  var local = null;          // a book opened from this computer (no Drive)

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
  function touch(b) { var e = entryOf(b); e.updated = Date.now(); dirty[b.fp] = 1; scheduleSave(); saveCache(); }

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
      var remote = parseLibrary(await Drive.text(lib.fileId));
      for (var fp in remote.entries) if (!dirty[fp]) lib.entries[fp] = mergeEntry(lib.entries[fp], remote.entries[fp]);
      fps.forEach(function (f) { var mine = lib.entries[f], theirs = remote.entries[f]; if (theirs && theirs.updated > mine.updated) lib.entries[f] = mergeEntry(mine, theirs); });
      var text = serializeLibrary(lib.entries);
      await Drive.writeText(lib.fileId, text);
      fps.forEach(function (f) { delete dirty[f]; });
      setStatus('Saved to Google Drive', 2500);
    } catch (e) {
      setStatus('Could not save: ' + e.message + ' (will retry)', 6000);
      scheduleSave();
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
      out.entries[fp] = { title: o.title || '', author: o.author || '', progress: +o.progress || 0, position: o.position == null ? null : String(o.position), status: +o.status || 0, favorite: !!o.favorite, lastOpened: +o.lastOpened || 0, updated: +o.updated || 0, trashed: !!o.trashed, collections: o.collections || [], bookmarks: o.bookmarks || [] };
    }
    return out;
  }
  function serializeLibrary(entries) {
    var bs = {};
    for (var fp in entries) {
      var e = entries[fp];
      bs[fp] = { title: e.title, author: e.author, progress: e.progress, position: e.position, status: e.status, favorite: e.favorite, lastOpened: e.lastOpened, updated: e.updated, trashed: e.trashed, collections: e.collections || [], bookmarks: e.bookmarks || [] };
    }
    return JSON.stringify({ version: 1, written: Date.now(), books: bs }, null, 2);
  }
  window.addEventListener('pagehide', function () { if (Object.keys(dirty).length) flush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && Object.keys(dirty).length) flush(); });

  // ---------- Drive loading ----------
  async function loadFromDrive(force) {
    try {
      await Drive.signIn(false);
    } catch (e) {
      $('accountBtn').textContent = 'Sign in';
      if (!books.length) showNotice('Press <b>Sign in</b> at the top right to open your Google Drive library.');
      return;
    }
    $('accountBtn').textContent = 'Signed in';
    setStatus('Looking for the OtoReader folder in Google Drive…');
    try {
      var found = await Drive.findLibrary();
      if (!found) { showNotice('No synced library yet. On the phone open OtoReader → Settings → <b>Google Drive sync</b>, choose a folder in the Drive app, and press <b>Sync now</b>. Then press ⟳ here.'); setStatus('', 0); return; }
      lib.fileId = found.fileId; lib.folderId = found.folderId; lib.booksId = found.booksId;
      setStatus('Reading the library file (this can take a minute for a big library)…');
      var remote = parseLibrary(await Drive.text(found.fileId));
      setStatus('Sorting ' + Object.keys(remote.entries).length + ' books…');
      for (var fp in remote.entries) lib.entries[fp] = dirty[fp] ? mergeEntry(lib.entries[fp], remote.entries[fp]) : remote.entries[fp];
      if (found.booksId) {
        setStatus('Listing book files…');
        var files = await Drive.listBooks(found.booksId);
        lib.files = {};
        files.forEach(function (f) { lib.files[fingerprint(f.name, +f.size || 0)] = { id: f.id, name: f.name, size: +f.size || 0, modifiedTime: f.modifiedTime }; });
      }
      lib.loadedAt = Date.now();
      saveCache(); rebuild(); buildDrawer(); render();
      hideNotice();
      setStatus(books.length + ' books in the synced library', 4000);
    } catch (e) {
      setStatus('', 0);
      showNotice('Could not read Google Drive: ' + esc(e.message));
    }
  }

  // ---------- UI: status, notice, dialog ----------
  var statusTimer = null;
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
      case 'format': return value ? b.format === value : true;
      case 'trash': return !!e.trashed;
    }
    return true;
  }
  var titles = { reading: 'Reading Now', all: 'Books & documents', favorites: 'Favorites', toread: 'To Read', finished: 'Have Read', collection: 'Collections', author: 'Authors', format: 'Formats', trash: 'Trash' };
  function buildDrawer() {
    var d = $('drawerItems'); d.innerHTML = '';
    function item(label, icon, shelf, value, sub) {
      var el = document.createElement('div');
      el.className = 'drawerItem' + (sub ? ' sub' : '') + (filter.shelf === shelf && filter.value === value ? ' selected' : '');
      el.innerHTML = '<span>' + icon + '</span><span>' + esc(label) + '</span><span class="count">' + count2(shelf, value) + '</span>';
      el.onclick = function () { filter = { shelf: shelf, value: value }; closeDrawer(); render(); buildDrawer(); };
      d.appendChild(el);
    }
    function count2(shelf, value) { return books.filter(function (b) { return inShelf(b, shelf, value); }).length; }
    function sep() { var s = document.createElement('div'); s.className = 'drawerSep'; d.appendChild(s); }
    item('Reading Now', '&#128214;', 'reading', null);
    item('Books & documents', '&#128218;', 'all', null);
    item('Favorites', '&#9733;', 'favorites', null);
    item('To Read', '&#128337;', 'toread', null);
    item('Have Read', '&#10004;', 'finished', null);
    sep();
    item('Collections', '&#128450;', 'collection', null);
    collections().forEach(function (c) { item(c.name, '', 'collection', c.name, true); });
    sep();
    item('Authors', '&#128100;', 'author', null);
    item('Formats', '&#128196;', 'format', null);
    item('Trash', '&#128465;', 'trash', null);
    sep();
    var s = document.createElement('div'); s.className = 'drawerItem'; s.innerHTML = '<span>&#9881;</span><span>Settings</span>';
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
    if ((filter.shelf === 'author' || filter.shelf === 'format') && !filter.value) {
      var groups = {};
      books.forEach(function (b) { if (!b.entry || !b.entry.trashed) { var k = filter.shelf === 'author' ? (b.author || 'Unknown author') : b.format; groups[k] = (groups[k] || 0) + 1; } });
      Object.keys(groups).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }).forEach(function (g) {
        var el = document.createElement('div'); el.className = 'book'; el.style.padding = '14px 16px';
        el.innerHTML = '<div class="info"><div class="title">' + esc(g) + '</div><div class="meta">' + groups[g] + ' books</div></div>';
        el.onclick = function () { filter = { shelf: filter.shelf, value: g === 'Unknown author' ? '' : g }; render(); };
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
      '<button class="fav' + (e.favorite ? ' on' : '') + '" title="Favorite">' + (e.favorite ? '&#9733;' : '&#9734;') + '</button>' +
      '<button class="toread' + (e.status === STATUS.TO_READ ? ' on' : '') + '" title="To Read">&#128337;</button>' +
      '<button class="done' + (e.status === STATUS.FINISHED ? ' on' : '') + '" title="Have Read">&#10004;&#10004;</button>' +
      '<button class="coll' + ((e.collections || []).length ? ' on' : '') + '" title="Collections">&#128218;' + ((e.collections || []).length ? '<sup>' + e.collections.length + '</sup>' : '') + '</button>' +
      '<button class="more" title="More">&#8942;</button></div></div>';
    loadCover(b, el.querySelector('.cover'));
    el.querySelector('.cover').onclick = function () { openBook(b); };
    el.querySelector('.title').onclick = function () { openBook(b); };
    el.querySelector('.fav').onclick = function () { var x = entryOf(b); x.favorite = !x.favorite; touch(b); refreshRow(b, el); };
    el.querySelector('.toread').onclick = function () { var x = entryOf(b); x.status = x.status === STATUS.TO_READ ? STATUS.NONE : STATUS.TO_READ; touch(b); refreshRow(b, el); };
    el.querySelector('.done').onclick = function () { var x = entryOf(b); if (x.status === STATUS.FINISHED) x.status = STATUS.NONE; else { x.status = STATUS.FINISHED; x.progress = 1; } touch(b); refreshRow(b, el); };
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
      '<button class="textBtn" id="edRemove">' + (e.status === STATUS.READING ? 'Remove from Reading Now' : '') + '</button></div>';
    dialog(html, function () {
      e.title = $('edTitle').value.trim() || b.title; e.author = $('edAuthor').value.trim(); b.title = e.title; b.author = e.author; touch(b); refreshRow(b, el);
    });
    $('edTrash').onclick = function () { e.trashed = !e.trashed; touch(b); $('dialog').classList.add('hidden'); refreshRow(b, el); render(); };
    $('edRemove').onclick = function () { e.status = STATUS.NONE; touch(b); $('dialog').classList.add('hidden'); refreshRow(b, el); render(); };
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
  function loadCover(b, el) {
    idbGet('covers', b.fp).then(function (blob) {
      if (!blob) return;
      var img = document.createElement('img'); img.src = URL.createObjectURL(blob); img.alt = '';
      el.textContent = ''; el.appendChild(img);
    });
  }

  // ---------- settings ----------
  function settings() {
    var html = '<h3 style="margin-top:0">Settings</h3><p class="muted">Signed in: ' + (Drive.signedIn() ? 'yes' : 'no') + '. Library loaded ' + (lib.loadedAt ? new Date(lib.loadedAt).toLocaleString() : 'never') + '.</p>' +
      '<div class="row"><button class="textBtn" id="stReload">Reload from Google Drive</button><button class="textBtn" id="stSignOut">Sign out</button></div>' +
      '<div class="row"><button class="textBtn" id="stClientId">Change client ID</button><button class="textBtn" id="stLocal">Open a file from this computer</button></div>';
    dialog(html, null, 'Close');
    $('stReload').onclick = function () { $('dialog').classList.add('hidden'); loadFromDrive(true); };
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
    return 'html { background: ' + t[0] + ' !important; font-size: ' + opts.size + '% !important; }' +
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
    Tts.play(items, startIdx, function (id) { try { rd.goToAnchor(id); } catch (e) {} }, function () {
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
    $('sort').onchange = function () { sort = this.value; try { localStorage.setItem('oto.sort', sort); } catch (e) {} render(); };
    try { sort = localStorage.getItem('oto.sort') || 'recent'; $('sort').value = sort; } catch (e) {}
    $('refreshBtn').onclick = function () { loadFromDrive(true); };
    $('accountBtn').onclick = function () {
      if (!Drive.clientId()) { $('setup').classList.remove('hidden'); return; }
      Drive.signIn(true).then(function () { loadFromDrive(true); }).catch(function (e) { showNotice('Sign-in failed: ' + esc(e.message)); });
    };
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
    $('ttsStop').onclick = function () { Tts.stop(); $('ttsPlay').textContent = 'Play'; };
    if (window.speechSynthesis) speechSynthesis.onvoiceschanged = function () { if (!$('ttsPanel').classList.contains('hidden')) fillVoices(); };

    loadCache(); rebuild(); buildDrawer(); render();
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
