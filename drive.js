/* drive.js — Google sign-in and the few Drive calls OtoReader needs. */
(function () {
  'use strict';
  var SCOPE = 'https://www.googleapis.com/auth/drive';
  var API = 'https://www.googleapis.com/drive/v3/';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
  var token = null, expires = 0, tokenClient = null;

  try {
    var saved = JSON.parse(sessionStorage.getItem('oto.token') || 'null');
    if (saved && saved.expires > Date.now() + 60000) { token = saved.token; expires = saved.expires; }
  } catch (e) {}

  var D = window.Drive = {};

  D.clientId = function () {
    try { return localStorage.getItem('oto.clientId') || window.OTOREADER_CLIENT_ID || ''; } catch (e) { return window.OTOREADER_CLIENT_ID || ''; }
  };
  D.setClientId = function (id) { try { localStorage.setItem('oto.clientId', id.trim()); } catch (e) {} };
  D.signedIn = function () { return !!token && expires > Date.now(); };
  D.signOut = function () { token = null; expires = 0; try { sessionStorage.removeItem('oto.token'); } catch (e) {} };

  /** Gets an access token. interactive=false tries silently (works once consent was given). */
  D.signIn = function (interactive) {
    return new Promise(function (resolve, reject) {
      if (D.signedIn()) { resolve(token); return; }
      if (!window.google || !google.accounts || !google.accounts.oauth2) { reject(new Error('Google sign-in script not loaded yet. Check the internet connection and try again.')); return; }
      var id = D.clientId();
      if (!id) { reject(new Error('No client ID')); return; }
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: SCOPE,
        callback: function (r) {
          if (!r || r.error) { reject(new Error((r && (r.error_description || r.error)) || 'Sign-in failed')); return; }
          token = r.access_token;
          expires = Date.now() + (r.expires_in ? r.expires_in * 1000 : 3500000);
          try { sessionStorage.setItem('oto.token', JSON.stringify({ token: token, expires: expires })); } catch (e) {}
          resolve(token);
        },
        error_callback: function (e) { reject(new Error(e && e.message ? e.message : 'Sign-in window closed')); },
      });
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  };

  function headers(extra) {
    var h = { Authorization: 'Bearer ' + token };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function call(url, opts, retry) {
    if (!D.signedIn()) await D.signIn(false);
    opts = opts || {};
    opts.headers = headers(opts.headers);
    var r = await fetch(url, opts);
    if (r.status === 401 && retry !== false) { D.signOut(); await D.signIn(false); return call(url, opts, false); }
    if (!r.ok) {
      var text = '';
      try { text = (await r.json()).error.message; } catch (e) { text = r.statusText; }
      throw new Error('Google Drive: ' + text + ' (' + r.status + ')');
    }
    return r;
  }

  D.json = async function (path) { return (await call(API + path)).json(); };

  /** files.list over every page. */
  D.list = async function (q, fields) {
    var out = [], pageToken = '';
    do {
      var url = API + 'files?pageSize=1000&spaces=drive&q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(' + (fields || 'id,name,size,modifiedTime,mimeType,parents') + ')') + (pageToken ? '&pageToken=' + pageToken : '');
      var r = await D.json(url.replace(API, ''));
      out = out.concat(r.files || []);
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  };

  D.text = async function (id) { return (await call(API + 'files/' + id + '?alt=media')).text(); };
  D.bytes = async function (id, onProgress) {
    var r = await call(API + 'files/' + id + '?alt=media');
    if (!r.body || !onProgress) return r.arrayBuffer();
    var total = +r.headers.get('Content-Length') || 0, got = 0, reader = r.body.getReader(), chunks = [];
    for (;;) {
      var c = await reader.read();
      if (c.done) break;
      chunks.push(c.value); got += c.value.length; onProgress(got, total);
    }
    var buf = new Uint8Array(got), o = 0;
    for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], o); o += chunks[i].length; }
    return buf.buffer;
  };

  D.writeText = async function (id, text) {
    await call(UPLOAD + 'files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
  };

  D.createText = async function (parentId, name, text) {
    var meta = JSON.stringify({ name: name, parents: [parentId] });
    var body = '--oto\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--oto\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--oto--';
    var r = await call(UPLOAD + 'files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=oto' }, body: body });
    return (await r.json()).id;
  };

  /** Finds the OtoReader sync folder: the folder that holds library.json (and a Books folder). */
  D.findLibrary = async function () {
    var hits = await D.list("name = 'library.json' and trashed = false", 'id,name,parents,modifiedTime');
    var best = null;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.parents || !h.parents.length) continue;
      var parent = await D.json('files/' + h.parents[0] + '?fields=id,name');
      if (parent.name === 'OtoReader') { best = { fileId: h.id, folderId: parent.id, modified: h.modifiedTime }; break; }
      if (!best) best = { fileId: h.id, folderId: parent.id, modified: h.modifiedTime };
    }
    if (!best) return null;
    var books = await D.list("'" + best.folderId + "' in parents and name = 'Books' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", 'id,name');
    best.booksId = books.length ? books[0].id : null;
    return best;
  };

  D.listBooks = async function (booksId) {
    return D.list("'" + booksId + "' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'", 'id,name,size,modifiedTime');
  };
})();
