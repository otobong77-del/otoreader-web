/* sw.js — lets the page be installed as a desktop app. The page itself is always fetched fresh;
   only the app's own files are kept for offline start-up. */
var CACHE = 'otoreader-v17';
var FILES = ['./', './index.html', './style.css', './app.js', './drive.js', './epub.js', './formats.js', './tts.js', './reader.bundle.js', './fflate.min.js', './unrar.js', './unrar.wasm', './config.js', './icon.svg', './icon-192.png', './icon-512.png', './version.json'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/\.apk$|apk\.json$/.test(url.pathname)) return; // the Android app download: always straight from the site, never cached
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (r) { if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); } return r; }).catch(function () { return caches.match(e.request).then(function (c) { return c || caches.match('./index.html'); }); }));
});
