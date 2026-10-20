/* epub.js — opens EPUB and TXT files in the browser. Needs fflate (loaded in index.html). */
(function () {
  'use strict';
  var B = window.Books = {};

  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.substring(0, i + 1); }
  function resolve(base, href) {
    if (!href) return '';
    href = href.replace(/^\.\//, '');
    if (/^[a-z]+:/i.test(href) || href.charAt(0) === '#') return href;
    var parts = (base + href).split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') out.pop(); else if (parts[i] !== '.' && parts[i] !== '') out.push(parts[i]);
    }
    return out.join('/');
  }
  function splitFragment(href) { var i = href.indexOf('#'); return i < 0 ? [href, ''] : [href.substring(0, i), href.substring(i + 1)]; }
  function decodeText(bytes) { try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { return ''; } }
  function mimeOf(path) {
    var e = path.toLowerCase().split('.').pop();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', xhtml: 'application/xhtml+xml', html: 'text/html' }[e] || 'application/octet-stream';
  }
  function byLocalName(el, name) {
    var out = [], all = el.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]);
    return out;
  }
  function first(el, name) { var l = byLocalName(el, name); return l.length ? l[0] : null; }

  /** EPUB: zip in memory, package parsed, sections ready to render. */
  B.Epub = function (buffer) {
    var files = fflate.unzipSync(new Uint8Array(buffer));
    var byLower = {};
    for (var k in files) byLower[k.toLowerCase()] = k;
    var self = this;
    this.text = function (path) { var f = files[path] || files[byLower[(path || '').toLowerCase()]]; return f ? decodeText(f) : null; };
    this.bytes = function (path) { return files[path] || files[byLower[(path || '').toLowerCase()]] || null; };
    this.has = function (path) { return !!this.bytes(path); };

    if (this.text('META-INF/encryption.xml') && /AdobeAdept|FairPlay|uri.*ADEPT|KEY_ID/i.test(this.text('META-INF/encryption.xml'))) throw new Error('This EPUB is protected with DRM and cannot be opened.');
    var containerXml = this.text('META-INF/container.xml');
    if (!containerXml) throw new Error('Not an EPUB (no META-INF/container.xml)');
    var container = new DOMParser().parseFromString(containerXml, 'application/xml');
    var rootfile = first(container.documentElement, 'rootfile');
    this.opfPath = rootfile ? rootfile.getAttribute('full-path') : 'content.opf';
    this.opfDir = dirOf(this.opfPath);
    var opfText = this.text(this.opfPath);
    if (!opfText) throw new Error('Package file missing: ' + this.opfPath);
    var opf = new DOMParser().parseFromString(opfText, 'application/xml');
    var pkg = opf.documentElement;
    var metadata = first(pkg, 'metadata') || pkg;
    var t = first(metadata, 'title'); this.title = t ? t.textContent.trim() : '';
    this.authors = byLocalName(metadata, 'creator').map(function (c) { return c.textContent.trim(); }).filter(Boolean);
    var coverMetaId = null;
    byLocalName(metadata, 'meta').forEach(function (m) { if (m.getAttribute('name') === 'cover') coverMetaId = m.getAttribute('content'); });

    this.items = {};
    var manifest = first(pkg, 'manifest');
    var self2 = this;
    byLocalName(manifest, 'item').forEach(function (el) {
      var id = el.getAttribute('id'), href = el.getAttribute('href') || '';
      var props = (el.getAttribute('properties') || '').split(/\s+/).filter(Boolean);
      self2.items[id] = { id: id, href: href, mediaType: el.getAttribute('media-type') || '', properties: props, path: resolve(self2.opfDir, decodeURIComponent(href)) };
    });
    var spineEl = first(pkg, 'spine');
    this.spine = [];
    byLocalName(spineEl, 'itemref').forEach(function (ref) {
      var it = self2.items[ref.getAttribute('idref')];
      if (it && ref.getAttribute('linear') !== 'no' && self2.has(it.path)) self2.spine.push(it);
      else if (it && self2.has(it.path)) self2.spine.push(it);
    });
    if (!this.spine.length) throw new Error('The EPUB has no readable chapters');
    this.pathIndex = {};
    this.spine.forEach(function (it, i) { self2.pathIndex[it.path.toLowerCase()] = i; });
    this.sizes = this.spine.map(function (it) { var b = self2.bytes(it.path); return b ? Math.max(1, b.length) : 1; });
    this.cum = [0]; for (var i = 0; i < this.sizes.length; i++) this.cum.push(this.cum[i] + this.sizes[i]);
    this.total = this.cum[this.cum.length - 1];

    // cover
    this.coverPath = null;
    for (var id in this.items) { if (this.items[id].properties.indexOf('cover-image') >= 0) this.coverPath = this.items[id].path; }
    if (!this.coverPath && coverMetaId && this.items[coverMetaId]) this.coverPath = this.items[coverMetaId].path;
    if (!this.coverPath) for (var id2 in this.items) { var it2 = this.items[id2]; if (/image\//.test(it2.mediaType) && /cover/i.test(it2.href)) { this.coverPath = it2.path; break; } }

    // table of contents: EPUB 3 nav, else NCX
    this.toc = [];
    var navItem = null;
    for (var id3 in this.items) if (this.items[id3].properties.indexOf('nav') >= 0 && this.has(this.items[id3].path)) navItem = this.items[id3];
    var ncxId = spineEl.getAttribute('toc'), ncxItem = this.items[ncxId];
    if (!ncxItem) for (var id4 in this.items) if (this.items[id4].mediaType === 'application/x-dtbncx+xml') ncxItem = this.items[id4];
    var raw = [];
    try { if (navItem) raw = readNav(this, navItem); } catch (e) {}
    try { if (!raw.length && ncxItem && this.has(ncxItem.path)) raw = readNcx(this, ncxItem); } catch (e) {}
    var flat = this.toc;
    (function flatten(list, depth) {
      list.forEach(function (e) {
        var idx = e.path ? self2.pathIndex[e.path.toLowerCase()] : undefined;
        if (idx === undefined && e.path) { var p = e.path.toLowerCase(); for (var k in self2.pathIndex) if (k.length > 0 && (p.endsWith('/' + k) || k.endsWith('/' + p))) { idx = self2.pathIndex[k]; break; } }
        if (idx !== undefined) flat.push({ label: e.label || '', section: idx, fragment: e.fragment || '', depth: depth });
        if (e.children && e.children.length) flatten(e.children, depth + 1);
      });
    })(raw, 0);
    if (!this.toc.length) this.spine.forEach(function (it, i) { flat.push({ label: 'Section ' + (i + 1), section: i, fragment: '', depth: 0 }); });
  };

  function readNav(book, item) {
    var doc = new DOMParser().parseFromString(book.text(item.path), 'text/html');
    var navs = doc.getElementsByTagName('nav'), nav = null;
    for (var i = 0; i < navs.length; i++) { var type = navs[i].getAttribute('epub:type') || navs[i].getAttributeNS('http://www.idpf.org/2007/ops', 'type') || ''; if (/\btoc\b/.test(type)) { nav = navs[i]; break; } }
    if (!nav && navs.length) nav = navs[0];
    if (!nav) return [];
    var ol = nav.getElementsByTagName('ol')[0];
    return ol ? parseOl(ol, dirOf(item.path)) : [];
  }
  function parseOl(ol, base) {
    var out = [];
    for (var li = ol.firstElementChild; li; li = li.nextElementSibling) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      var a = null, sub = null, span = null;
      for (var c = li.firstElementChild; c; c = c.nextElementSibling) {
        var tn = c.tagName.toLowerCase();
        if (tn === 'a' && !a) a = c; else if (tn === 'ol' && !sub) sub = c; else if (tn === 'span' && !span) span = c;
      }
      if (!a) a = li.getElementsByTagName('a')[0];
      var label = (a || span || li).textContent.replace(/\s+/g, ' ').trim();
      var path = null, frag = '';
      if (a && a.getAttribute('href')) { var pf = splitFragment(a.getAttribute('href')); path = resolve(base, decodeURIComponent(pf[0])); frag = pf[1]; }
      out.push({ label: label, path: path, fragment: frag, children: sub ? parseOl(sub, base) : [] });
    }
    return out;
  }
  function readNcx(book, item) {
    var doc = new DOMParser().parseFromString(book.text(item.path), 'application/xml');
    var map = first(doc.documentElement, 'navMap');
    if (!map) return [];
    var base = dirOf(item.path);
    function points(parent) {
      var out = [];
      for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName !== 'navPoint') continue;
        var lab = first(c, 'text'), content = first(c, 'content');
        var path = null, frag = '';
        if (content && content.getAttribute('src')) { var pf = splitFragment(content.getAttribute('src')); path = resolve(base, decodeURIComponent(pf[0])); frag = pf[1]; }
        out.push({ label: lab ? lab.textContent.trim() : '', path: path, fragment: frag, children: points(c) });
      }
      return out;
    }
    return points(map);
  }

  /** Turns spine item i into a self-contained HTML string (resources as blob: URLs). Returns {html, urls} */
  B.Epub.prototype.section = function (i) {
    var it = this.spine[i], base = dirOf(it.path), self = this, urls = [];
    var html = this.text(it.path) || '';
    var doc = new DOMParser().parseFromString(html, 'text/html');
    function blob(path) {
      var b = self.bytes(path);
      if (!b) return null;
      var u = URL.createObjectURL(new Blob([b], { type: mimeOf(path) }));
      urls.push(u);
      return u;
    }
    var cssText = '';
    var links = doc.querySelectorAll('link[rel~="stylesheet"], link[type="text/css"]');
    for (var l = 0; l < links.length; l++) {
      var href = links[l].getAttribute('href');
      if (!href) continue;
      var cssPath = resolve(base, decodeURIComponent(href));
      var css = this.text(cssPath);
      if (css) cssText += '\n' + rewriteCss(css, dirOf(cssPath), blob);
      links[l].parentNode.removeChild(links[l]);
    }
    var styles = doc.getElementsByTagName('style');
    for (var s = 0; s < styles.length; s++) cssText += '\n' + rewriteCss(styles[s].textContent || '', base, blob);
    var scripts = doc.getElementsByTagName('script');
    while (scripts.length) scripts[0].parentNode.removeChild(scripts[0]);
    var imgs = doc.querySelectorAll('img[src], image, video[src], audio[src], source[src]');
    for (var m = 0; m < imgs.length; m++) {
      var el = imgs[m];
      var attr = el.hasAttribute('src') ? 'src' : (el.hasAttribute('xlink:href') ? 'xlink:href' : 'href');
      var v = el.getAttribute(attr) || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!v || /^(data|https?):/i.test(v)) continue;
      var u = blob(resolve(base, decodeURIComponent(v.split('#')[0])));
      if (u) { el.setAttribute('src', u); if (attr !== 'src') { el.setAttribute('href', u); el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); } }
    }
    var anchors = doc.querySelectorAll('a[href]');
    for (var a = 0; a < anchors.length; a++) {
      var h = anchors[a].getAttribute('href');
      if (/^[a-z]+:/i.test(h)) continue;
      var pf = splitFragment(h);
      var target = pf[0] ? resolve(base, decodeURIComponent(pf[0])) : it.path;
      var idx = this.pathIndex[target.toLowerCase()];
      anchors[a].setAttribute('href', idx === undefined ? h : 'oto:' + idx + '#' + pf[1]);
    }
    var body = doc.body ? doc.body.innerHTML : html;
    return { html: body, css: cssText, urls: urls };
  };

  function rewriteCss(css, base, blob) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      if (/^(data|https?):/i.test(u)) return m;
      var b = blob(resolve(base, decodeURIComponent(u)));
      return b ? 'url("' + b + '")' : m;
    });
  }

  B.Epub.prototype.coverUrl = function () {
    if (!this.coverPath) return null;
    var b = this.bytes(this.coverPath);
    return b ? URL.createObjectURL(new Blob([b], { type: mimeOf(this.coverPath) })) : null;
  };

  /** Plain text: paragraphs split on blank lines, chunked into sections of ~60 KB. */
  B.Txt = function (buffer, name) {
    var text = decodeText(new Uint8Array(buffer)).replace(/\r\n?/g, '\n');
    this.title = (name || 'Text').replace(/\.[^.]+$/, '');
    this.authors = [];
    var paras = text.split(/\n\s*\n/), chunks = [], cur = '';
    for (var i = 0; i < paras.length; i++) {
      var p = '<p>' + paras[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>';
      cur += p;
      if (cur.length > 60000) { chunks.push(cur); cur = ''; }
    }
    if (cur || !chunks.length) chunks.push(cur || '<p></p>');
    this.chunks = chunks;
    this.spine = chunks.map(function (c, i) { return { path: 'part' + i }; });
    this.sizes = chunks.map(function (c) { return c.length; });
    this.cum = [0]; for (var j = 0; j < this.sizes.length; j++) this.cum.push(this.cum[j] + this.sizes[j]);
    this.total = this.cum[this.cum.length - 1];
    this.toc = chunks.map(function (c, i) { return { label: 'Part ' + (i + 1), section: i, fragment: '', depth: 0 }; });
    this.coverPath = null;
  };
  B.Txt.prototype.section = function (i) { return { html: this.chunks[i], css: '', urls: [] }; };
  B.Txt.prototype.coverUrl = function () { return null; };

  B.open = function (buffer, name) {
    var ext = (name || '').toLowerCase().split('.').pop();
    if (ext === 'txt') return new B.Txt(buffer, name);
    return new B.Epub(buffer);
  };
})();
