/* formats.js — Kindle (MOBI / AZW / AZW3) and Word (DOCX) in the browser, ported from the phone app's parsers. */
(function () {
  'use strict';
  var B = window.Books;

  // ---------- shared: an in-memory book of HTML pages plus named resources ----------
  function MemoryBook(title, authors, pages, resources, coverKey) {
    this.title = title; this.authors = authors || [];
    this.pages = pages;            // [{label, html}]
    this.resources = resources;    // key -> {mime, bytes}
    this.coverKey = coverKey || null;
    this.spine = pages.map(function (p, i) { return { path: 'p' + (i + 1) }; });
    this.sizes = pages.map(function (p) { return Math.max(1, p.html.length); });
    this.cum = [0]; for (var i = 0; i < this.sizes.length; i++) this.cum.push(this.cum[i] + this.sizes[i]);
    this.total = this.cum[this.cum.length - 1];
    this.toc = pages.map(function (p, i) { return { label: p.label, section: i, fragment: '', depth: p.depth || 0 }; });
    this.coverPath = coverKey;
  }
  MemoryBook.prototype.section = function (i) {
    var self = this, urls = [];
    var html = this.pages[i].html;
    var blobs = {};
    function url(key) {
      if (blobs[key]) return blobs[key];
      var r = self.resources[key]; if (!r) return null;
      var u = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
      urls.push(u); blobs[key] = u; return u;
    }
    html = html.replace(/(src|href|xlink:href)=(["'])r\/([^"']+)\2/gi, function (m, attr, q, key) { var u = url(key); return u ? attr + '=' + q + u + q : m; });
    // strip the page's own wrapper: the reader supplies html/head/body
    var css = '';
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (m, c) { css += '\n' + c; return ''; });
    var bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (bodyM) html = bodyM[1];
    html = html.replace(/<\/?(html|head|body)[^>]*>/gi, '');
    return { html: html, css: css, urls: urls };
  };
  MemoryBook.prototype.coverUrl = function () {
    var r = this.coverKey && this.resources[this.coverKey];
    return r ? URL.createObjectURL(new Blob([r.bytes], { type: r.mime })) : null;
  };
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function headingOf(html, index) {
    var h = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(html);
    var text = h ? h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    if (text) return text.substring(0, 80);
    var first = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return first.length > 3 ? first.substring(0, 50) : 'Part ' + (index + 1);
  }
  function paginate(blocks, maxChars) {
    var pages = [], cur = '';
    for (var i = 0; i < blocks.length; i++) {
      cur += blocks[i];
      if (cur.length > maxChars) { pages.push(cur); cur = ''; }
    }
    if (cur || !pages.length) pages.push(cur);
    return pages;
  }

  // ---------- Kindle ----------
  function u16(b, p) { return p + 2 > b.length ? 0 : (b[p] << 8) | b[p + 1]; }
  function u32(b, p) { return p + 4 > b.length ? 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
  function s32(b, p) { return u32(b, p) | 0; }
  function latin(b, p, n) { var s = ''; for (var i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]); return s; }

  function Palm(bytes) {
    var type = latin(bytes, 60, 8);
    if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') throw new Error('Not a Kindle/MOBI file');
    this.bytes = bytes;
    this.count = u16(bytes, 76);
    this.offsets = new Array(this.count + 1);
    for (var i = 0; i < this.count; i++) this.offsets[i] = u32(bytes, 78 + i * 8);
    this.offsets[this.count] = bytes.length;
  }
  Palm.prototype.record = function (i) {
    if (i < 0 || i >= this.count) return new Uint8Array(0);
    return this.bytes.subarray(this.offsets[i], Math.max(this.offsets[i], this.offsets[i + 1]));
  };

  function Header(rec0, base) {
    this.rec0 = rec0; this.base = base;
    this.compression = u16(rec0, 0);
    this.textRecords = u16(rec0, 8);
    this.encryption = u16(rec0, 12);
    this.headerLength = u32(rec0, 20);
    this.textEncoding = u32(rec0, 28);
    this.version = u32(rec0, 36);
    this.fullNameOffset = u32(rec0, 84);
    this.fullNameLength = u32(rec0, 88);
    this.firstResource = u32(rec0, 108);
    this.huffRecord = u32(rec0, 112);
    this.huffCount = u32(rec0, 116);
    this.exthFlags = u32(rec0, 128);
    this.fdstIndex = this.headerLength >= 0xE4 ? u32(rec0, 192) : 0;
    this.fdstCount = this.headerLength >= 0xE4 ? u32(rec0, 196) : 0;
    this.extraFlags = (this.headerLength >= 0xE4 && this.version >= 5) ? u16(rec0, 242) : 0;
    this.decoder = new TextDecoder(this.textEncoding === 65001 ? 'utf-8' : 'windows-1252');
    this.exth = {};
    if (this.exthFlags & 0x40) {
      var start = 16 + this.headerLength;
      if (start + 12 <= rec0.length && latin(rec0, start, 4) === 'EXTH') {
        var count = u32(rec0, start + 8), p = start + 12;
        for (var i = 0; i < count; i++) {
          if (p + 8 > rec0.length) break;
          var type = u32(rec0, p), size = u32(rec0, p + 4);
          if (size < 8 || p + size > rec0.length) break;
          (this.exth[type] = this.exth[type] || []).push(rec0.subarray(p + 8, p + size));
          p += size;
        }
      }
    }
  }
  Header.prototype.exthString = function (t) { var v = this.exth[t]; if (!v || !v.length) return null; var s = this.decoder.decode(v[0]).trim(); return s || null; };
  Header.prototype.exthInt = function (t) { var v = this.exth[t]; return v && v.length && v[0].length === 4 ? u32(v[0], 0) : null; };
  Header.prototype.title = function () {
    var t = this.exthString(503); if (t) return t;
    if (this.fullNameLength > 0 && this.fullNameOffset + this.fullNameLength <= this.rec0.length) return this.decoder.decode(this.rec0.subarray(this.fullNameOffset, this.fullNameOffset + this.fullNameLength)).trim();
    return '';
  };

  function stripTrailers(data, extraFlags) {
    var end = data.length, flags = extraFlags >> 1;
    while (flags) {
      if (flags & 1) {
        var num = 0;
        for (var k = Math.max(0, end - 4); k < end; k++) { var v = data[k]; if (v & 0x80) num = 0; num = (num << 7) | (v & 0x7F); }
        end -= num;
      }
      flags >>= 1;
    }
    if ((extraFlags & 1) && end > 0) end -= (data[end - 1] & 3) + 1;
    return data.subarray(0, Math.max(0, Math.min(end, data.length)));
  }

  function palmDoc(data) {
    var out = new Uint8Array(data.length * 8 + 16), o = 0, i = 0;
    function put(v) { if (o >= out.length) { var n = new Uint8Array(out.length * 2); n.set(out); out = n; } out[o++] = v; }
    while (i < data.length) {
      var c = data[i++];
      if (c >= 1 && c <= 8) { for (var k = 0; k < c && i < data.length; k++) put(data[i++]); }
      else if (c < 128) put(c);
      else if (c >= 192) { put(32); put(c ^ 128); }
      else {
        if (i >= data.length) break;
        var pair = (c << 8) | data[i++];
        var distance = (pair >> 3) & 0x7FF, length = (pair & 7) + 3;
        var start = o - distance;
        for (var m = 0; m < length; m++) { var idx = start + m; put(idx < 0 ? 0 : out[idx]); }
      }
    }
    return out.subarray(0, o);
  }

  function HuffCdic(palm, h) {
    var huff = palm.record(h.huffRecord);
    if (huff.length < 16 || latin(huff, 0, 4) !== 'HUFF') throw new Error('Bad HUFF record');
    var off1 = u32(huff, 8), off2 = u32(huff, 12);
    this.codeLen = new Array(256); this.term = new Array(256); this.maxCode1 = new Array(256);
    this.minCode = new Array(33); this.maxCode = new Array(33);
    var TWO32 = 4294967296n;
    for (var i = 0; i < 256; i++) {
      var v = BigInt(u32(huff, off1 + i * 4));
      var cl = Number(v & 0x1Fn), t = (v & 0x80n) !== 0n, mc = v >> 8n;
      if (cl === 0 || (cl <= 8 && !t)) throw new Error('Bad HUFF table');
      mc = (((mc + 1n) << BigInt(32 - cl)) - 1n) % TWO32;
      this.codeLen[i] = cl; this.term[i] = t; this.maxCode1[i] = Number(mc);
    }
    for (var c2 = 1; c2 <= 32; c2++) {
      var mn = BigInt(u32(huff, off2 + (c2 - 1) * 8)), mx = BigInt(u32(huff, off2 + (c2 - 1) * 8 + 4));
      this.minCode[c2] = Number((mn << BigInt(32 - c2)) % TWO32);
      this.maxCode[c2] = Number((((mx + 1n) << BigInt(32 - c2)) - 1n) % TWO32);
    }
    this.dictionary = [];
    for (var r = 1; r < h.huffCount; r++) {
      var cdic = palm.record(h.huffRecord + r);
      if (cdic.length < 16 || latin(cdic, 0, 4) !== 'CDIC') throw new Error('Bad CDIC record');
      var phrases = u32(cdic, 8), bits = u32(cdic, 12);
      var n = Math.min(1 << bits, phrases - this.dictionary.length);
      for (var k = 0; k < n; k++) {
        var off = u16(cdic, 16 + 2 * k) + 16;
        var blen = u16(cdic, off);
        this.dictionary.push({ bytes: cdic.subarray(off + 2, off + 2 + (blen & 0x7FFF)), done: (blen & 0x8000) !== 0 });
      }
    }
  }
  function window32(b, pos, n) { // bits [n, n+32) of the 64-bit big-endian value at pos, counted from its low end
    var hi = u32(b, pos), lo = u32(b, pos + 4);
    if (n === 32) return hi;
    if (n === 0) return lo;
    return (((hi << (32 - n)) | (lo >>> n)) >>> 0);
  }
  HuffCdic.prototype.unpack = function (data) {
    var parts = [], total = 0;
    var padded = new Uint8Array(data.length + 8); padded.set(data);
    var bitsLeft = data.length * 8, pos = 0, n = 32;
    for (;;) {
      if (n <= 0) { pos += 4; n += 32; }
      var code = window32(padded, pos, n);
      var top = code >>> 24;
      var cl = this.codeLen[top], mc = this.maxCode1[top];
      if (!this.term[top]) { while (code < this.minCode[cl]) cl++; mc = this.maxCode[cl]; }
      n -= cl; bitsLeft -= cl;
      if (bitsLeft < 0) break;
      var r = Math.floor((mc - code) / Math.pow(2, 32 - cl));
      var entry = this.dictionary[r];
      if (!entry) break;
      var slice = entry.bytes;
      if (!entry.done) { this.dictionary[r] = null; slice = this.unpack(slice); this.dictionary[r] = { bytes: slice, done: true }; }
      parts.push(slice); total += slice.length;
    }
    var out = new Uint8Array(total), o = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  };

  function imageMime(r) {
    if (r.length < 8) return null;
    if (r[0] === 0xFF && r[1] === 0xD8) return 'image/jpeg';
    if (r[0] === 0x89 && r[1] === 0x50 && r[2] === 0x4E) return 'image/png';
    if (r[0] === 0x47 && r[1] === 0x49 && r[2] === 0x46) return 'image/gif';
    if (r[0] === 0x42 && r[1] === 0x4D) return 'image/bmp';
    return null;
  }

  B.Mobi = function (buffer, name) {
    var bytes = new Uint8Array(buffer);
    var palm = new Palm(bytes);
    var rec0 = palm.record(0);
    if (rec0.length < 16) throw new Error('Unsupported MOBI file');
    var h = new Header(rec0, 0);
    if (h.encryption !== 0) throw new Error('This Kindle book is protected by DRM and cannot be opened.');
    var kf8 = h.version >= 8;
    var boundary = h.exthInt(121);
    if (!kf8 && boundary && boundary > 0 && boundary < palm.count && h.textRecords === 0) { h = new Header(palm.record(boundary), boundary); kf8 = true; }
    // text
    var huff = h.compression === 17480 ? new HuffCdic(palm, h) : null;
    var chunks = [], total = 0;
    for (var i = 1; i <= h.textRecords; i++) {
      var data = stripTrailers(palm.record(h.base + i), h.extraFlags);
      var text = h.compression === 1 ? data : h.compression === 2 ? palmDoc(data) : h.compression === 17480 ? huff.unpack(data) : null;
      if (!text) throw new Error('Unknown MOBI compression ' + h.compression);
      chunks.push(text); total += text.length;
    }
    var textBytes = new Uint8Array(total), o = 0;
    for (var c = 0; c < chunks.length; c++) { textBytes.set(chunks[c], o); o += chunks[c].length; }
    // images
    var resources = {};
    if (h.firstResource > 0) {
      for (var r = h.firstResource; r < palm.count; r++) {
        var rec = palm.record(r), mime = imageMime(rec);
        if (mime) resources['img' + (r - h.firstResource + 1)] = { mime: mime, bytes: rec };
      }
    }
    var coverIdx = h.exthInt(201);
    var coverKey = coverIdx != null && resources['img' + (coverIdx + 1)] ? 'img' + (coverIdx + 1) : null;
    if (!coverKey) { var keys = Object.keys(resources); if (keys.length) coverKey = keys[0]; }
    var authors = (h.exth[100] || []).map(function (a) { return h.decoder.decode(a).trim(); }).filter(Boolean);
    var title = h.title() || (name || 'Book').replace(/\.[^.]+$/, '');

    var pages = [];
    if (kf8) {
      var flows = [[0, textBytes.length]];
      if (h.fdstIndex > 0 && h.fdstIndex < palm.count) {
        var fdst = palm.record(h.base + h.fdstIndex);
        if (fdst.length >= 12 && latin(fdst, 0, 4) === 'FDST') {
          var fc = u32(fdst, 8), list = [];
          for (var f = 0; f < fc; f++) { var p = 12 + f * 8; if (p + 8 > fdst.length) break; list.push([u32(fdst, p), u32(fdst, p + 4)]); }
          if (list.length) flows = list;
        }
      }
      for (var fi = 1; fi < flows.length; fi++) {
        var fb = textBytes.subarray(Math.min(flows[fi][0], textBytes.length), Math.min(flows[fi][1], textBytes.length));
        var head = latin(fb, 0, Math.min(fb.length, 200));
        resources['flow' + fi] = { mime: head.indexOf('<svg') >= 0 ? 'image/svg+xml' : 'text/css', bytes: fb };
      }
      var html = h.decoder.decode(textBytes.subarray(Math.min(flows[0][0], textBytes.length), Math.min(flows[0][1], textBytes.length)));
      var parts = html.split(/(?=<html\b)/i).filter(function (s) { return s.trim(); });
      parts.forEach(function (raw, idx) {
        var pg = raw.replace(/kindle:embed:([0-9A-V]+)(\?mime=[^"']*)?/gi, function (m, n) { return 'r/img' + parseInt(n, 32); })
          .replace(/kindle:flow:([0-9A-V]+)(\?mime=[^"']*)?/gi, function (m, n) { return 'r/flow' + parseInt(n, 32); })
          .replace(/href="kindle:pos:[^"]*"/gi, 'href="#"');
        pages.push({ label: headingOf(pg, idx), html: pg });
      });
    } else {
      var body = h.decoder.decode(textBytes);
      var bs = /<body[^>]*>/i.exec(body); if (bs) body = body.substring(bs.index + bs[0].length);
      body = body.replace(/<\/body>[\s\S]*/i, '');
      var ps = body.split(/<mbp:pagebreak\s*\/?>/i).filter(function (s) { return s.trim(); });
      if (!ps.length) ps = [body];
      ps.forEach(function (raw, idx) {
        var fixed = raw.replace(/<img([^>]*?)recindex="?0*(\d+)"?([^>]*)>/gi, function (m, a, n, b2) { return '<img' + a + ' src="r/img' + parseInt(n, 10) + '"' + b2 + '>'; })
          .replace(/<a([^>]*?)filepos="?(\d+)"?([^>]*)>/gi, function (m, a, n, b2) { return '<a' + a + ' href="#"' + b2 + '>'; })
          .replace(/<\/?mbp:[^>]*>/gi, '');
        var label = headingOf(fixed, idx);
        if (fixed.length <= 160000) pages.push({ label: label, html: fixed });
        else paginate(fixed.split(/(?=<(?:p|div|h[1-6])\b)/i), 60000).forEach(function (pg, j) { pages.push({ label: j === 0 ? label : label + ' (' + (j + 1) + ')', html: pg }); });
      });
    }
    if (!pages.length) pages.push({ label: 'Text', html: '<p></p>' });
    return new MemoryBook(title, authors, pages, resources, coverKey);
  };

  // ---------- Word DOCX ----------
  function localAttr(el, local) {
    for (var i = 0; i < el.attributes.length; i++) { var a = el.attributes[i]; if (a.localName === local || a.name === local || a.name.slice(-local.length - 1) === ':' + local) return a.value; }
    return '';
  }
  function childEls(el) { var out = []; for (var c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c); return out; }
  function childNamed(el, name) { return childEls(el).filter(function (c) { return c.localName === name; }); }
  function byLocal(el, name) { var out = [], all = el.getElementsByTagName('*'); for (var i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]); return out; }

  B.Docx = function (buffer, name) {
    var files = fflate.unzipSync(new Uint8Array(buffer));
    var docXml = files['word/document.xml'];
    if (!docXml) throw new Error('Not a Word document (word/document.xml missing)');
    var dec = new TextDecoder('utf-8');
    var doc = new DOMParser().parseFromString(dec.decode(docXml), 'application/xml');
    var rels = {};
    if (files['word/_rels/document.xml.rels']) {
      var rd = new DOMParser().parseFromString(dec.decode(files['word/_rels/document.xml.rels']), 'application/xml');
      byLocal(rd.documentElement, 'Relationship').forEach(function (rel) {
        var target = rel.getAttribute('Target') || '';
        rels[rel.getAttribute('Id')] = target.charAt(0) === '/' ? target.substring(1) : 'word/' + target;
      });
    }
    var resources = {}, images = {};
    function imageKey(rId) {
      if (images[rId]) return images[rId];
      var path = rels[rId]; if (!path || !files[path]) return null;
      var ext = path.split('.').pop().toLowerCase();
      var key = 'img' + Object.keys(images).length + '.' + ext;
      resources[key] = { mime: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream', bytes: files[path] };
      images[rId] = key; return key;
    }
    var blocks = [], headings = [];
    function runs(p) {
      var sb = '';
      childEls(p).forEach(function (n) {
        if (n.localName === 'r') {
          var rPr = childNamed(n, 'rPr')[0];
          function on(tag) { var e = rPr && childNamed(rPr, tag)[0]; if (!e) return false; var v = localAttr(e, 'val'); return v !== '0' && v !== 'false'; }
          var bold = on('b'), italic = on('i'), text = '';
          childEls(n).forEach(function (c) {
            if (c.localName === 't') text += esc(c.textContent);
            else if (c.localName === 'tab') text += '&#160;&#160;&#160;&#160;';
            else if (c.localName === 'br') text += '<br/>';
            else if (c.localName === 'drawing' || c.localName === 'pict' || c.localName === 'object') {
              byLocal(c, 'blip').forEach(function (b2) { var k = imageKey(localAttr(b2, 'embed')); if (k) text += '<img src="r/' + k + '" alt=""/>'; });
              byLocal(c, 'imagedata').forEach(function (d) { var k = imageKey(localAttr(d, 'id')); if (k) text += '<img src="r/' + k + '" alt=""/>'; });
            }
          });
          if (bold) text = '<b>' + text + '</b>';
          if (italic) text = '<i>' + text + '</i>';
          sb += text;
        } else if (['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent'].indexOf(n.localName) >= 0) sb += runs(n);
      });
      return sb;
    }
    function paragraph(p) {
      var pPr = childNamed(p, 'pPr')[0];
      var style = pPr && childNamed(pPr, 'pStyle')[0] ? localAttr(childNamed(pPr, 'pStyle')[0], 'val') : '';
      var level = null, m = /heading\s*(\d)|^(\d)$|Title/i.exec(style);
      if (m) level = /^title$/i.test(m[0]) ? 1 : parseInt(m[1] || m[2], 10);
      var content = runs(p);
      if (level && level >= 1 && level <= 6 && content.trim()) {
        headings.push({ label: content.replace(/<[^>]+>/g, '').trim(), block: blocks.length, level: level });
        var hl = Math.min(level, 4);
        blocks.push('<h' + hl + '>' + content + '</h' + hl + '>');
      } else {
        var isList = pPr && childNamed(pPr, 'numPr').length > 0;
        blocks.push(isList ? '<p class="li">• ' + content + '</p>' : '<p>' + content + '</p>');
      }
    }
    function walk(el) {
      childEls(el).forEach(function (n) {
        if (n.localName === 'p') paragraph(n);
        else if (n.localName === 'tbl') {
          var sb = '<table>';
          childNamed(n, 'tr').forEach(function (tr) {
            sb += '<tr>';
            childNamed(tr, 'tc').forEach(function (tc) { sb += '<td>'; childNamed(tc, 'p').forEach(function (p) { sb += runs(p) + '<br/>'; }); sb += '</td>'; });
            sb += '</tr>';
          });
          blocks.push(sb + '</table>');
        } else if (n.localName === 'sdt' || n.localName === 'sdtContent') walk(n);
      });
    }
    var body = byLocal(doc.documentElement, 'body')[0];
    if (!body) throw new Error('Word document has no body');
    walk(body);
    var title = null;
    if (files['docProps/core.xml']) { try { var core = new DOMParser().parseFromString(dec.decode(files['docProps/core.xml']), 'application/xml'); var t = byLocal(core.documentElement, 'title')[0]; if (t && t.textContent.trim()) title = t.textContent.trim(); } catch (e) {} }
    title = title || (name || 'Document').replace(/\.[^.]+$/, '');
    var CSS = '<style>p{margin:0 0 .6em}h1,h2,h3{margin:1em 0 .4em}table{border-collapse:collapse}td,th{border:1px solid #999;padding:2px 6px}img{max-width:100%}</style>';
    var cuts = headings.filter(function (h) { return h.level <= 2 && h.block > 0; }).map(function (h) { return h.block; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var pages = [];
    if (!cuts.length) {
      paginate(blocks, 60000).forEach(function (pg, i) { pages.push({ label: 'Part ' + (i + 1), html: CSS + pg }); });
      headings.forEach(function (h) { for (var i = 0; i < pages.length; i++) if (pages[i].html.indexOf(blocks[h.block]) >= 0) { if (pages[i].label.indexOf('Part') === 0) pages[i].label = h.label; break; } });
    } else {
      var starts = [0].concat(cuts);
      starts.forEach(function (start, i) {
        var end = i + 1 < starts.length ? starts[i + 1] : blocks.length;
        var h = headings.filter(function (x) { return x.block >= start && x.block < end; })[0];
        pages.push({ label: h ? h.label : 'Part ' + (i + 1), html: CSS + blocks.slice(start, end).join('\n'), depth: h ? Math.min(3, h.level - 1) : 0 });
      });
    }
    return new MemoryBook(title, [], pages, resources, null);
  };

  // ---------- dispatch ----------
  var openEpubOrTxt = B.open;
  B.open = function (buffer, name) {
    var ext = (name || '').toLowerCase().split('.').pop();
    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3' || ext === 'prc') return new B.Mobi(buffer, name);
    if (ext === 'docx') return new B.Docx(buffer, name);
    return openEpubOrTxt(buffer, name);
  };
  B.canOpen = function (name) { return /\.(epub|txt|pdf|mobi|azw|azw3|prc|docx)$/i.test(name || ''); };
})();
