/* formats.js — Kindle (MOBI / AZW / AZW3), Word (DOCX), FictionBook (FB2), RTF, OpenDocument (ODT) and comics (CBZ, CBR) in the browser, ported from the phone app's parsers. */
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
    return assemble(title, blocks, headings, resources);
  };

  // ---------- shared assembly for Word-like documents (DOCX, ODT) ----------
  var DOC_CSS = '<style>p{margin:0 0 .6em}h1,h2,h3{margin:1em 0 .4em}table{border-collapse:collapse}td,th{border:1px solid #999;padding:2px 6px}img{max-width:100%}ul{margin:0 0 .6em}</style>';
  function assemble(title, blocks, headings, resources) {
    var cuts = headings.filter(function (h) { return h.level <= 2 && h.block > 0; }).map(function (h) { return h.block; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var pages = [];
    if (!cuts.length) {
      paginate(blocks, 60000).forEach(function (pg, i) { pages.push({ label: 'Part ' + (i + 1), html: DOC_CSS + pg }); });
      headings.forEach(function (h) { for (var i = 0; i < pages.length; i++) if (pages[i].html.indexOf(blocks[h.block]) >= 0) { if (pages[i].label.indexOf('Part') === 0) pages[i].label = h.label; break; } });
    } else {
      var starts = [0].concat(cuts);
      starts.forEach(function (start, i) {
        var end = i + 1 < starts.length ? starts[i + 1] : blocks.length;
        var h = headings.filter(function (x) { return x.block >= start && x.block < end; })[0];
        pages.push({ label: h ? h.label : 'Part ' + (i + 1), html: DOC_CSS + blocks.slice(start, end).join('\n'), depth: h ? Math.min(3, h.level - 1) : 0 });
      });
    }
    return new MemoryBook(title, [], pages, resources, null);
  }
  function mimeForImage(name) {
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[(name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
  }
  function isImageName(name) { return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name || ''); }
  function naturalCompare(a, b) {
    var ax = a.toLowerCase().split(/(\d+)/), bx = b.toLowerCase().split(/(\d+)/);
    for (var i = 0; i < Math.max(ax.length, bx.length); i++) {
      var x = ax[i] || '', y = bx[i] || '';
      if (x === y) continue;
      var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) { var d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; continue; }
      return x < y ? -1 : 1;
    }
    return 0;
  }
  function xmlText(bytes) {
    // honour the encoding named in the XML declaration (FB2 files are often windows-1251)
    var head = latin(bytes, 0, Math.min(bytes.length, 200));
    var m = /encoding=["']([\w.-]+)["']/i.exec(head);
    var enc = m ? m[1].toLowerCase() : 'utf-8';
    if (bytes.length > 1 && bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
    else if (bytes.length > 1 && bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
    var text;
    try { text = new TextDecoder(enc).decode(bytes); } catch (e) { text = new TextDecoder('utf-8').decode(bytes); }
    return text.replace(/^﻿/, '').replace(/^(\s*<\?xml[^>]*?)\sencoding=["'][^"']*["']/i, '$1');
  }
  function parseXml(text, what) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var err = doc.getElementsByTagName('parsererror')[0];
    if (err || !doc.documentElement) throw new Error('Could not read ' + what + ': ' + (err ? err.textContent.replace(/\s+/g, ' ').substring(0, 120) : 'empty document'));
    return doc;
  }
  function firstLocal(el, name) { var all = el.getElementsByTagName('*'); for (var i = 0; i < all.length; i++) if (all[i].localName === name) return all[i]; return null; }

  // ---------- FictionBook 2 ----------
  var FB2_CSS = '<style>p{text-indent:1.2em;margin:0 0 .4em}.poem p{text-indent:0;margin:0}.stanza{margin:.6em 0}.epigraph{margin-left:2em;font-style:italic}.text-author{text-align:right;font-style:italic}blockquote{margin:.6em 1.5em}h2,h3,h4{text-align:center}.subtitle{text-align:center;font-weight:bold}img{max-width:100%}.image{text-align:center}</style>';
  function b64bytes(s) {
    var bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  B.Fb2 = function (buffer, name) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B) { // .fb2.zip
      var files = fflate.unzipSync(bytes), inner = Object.keys(files).filter(function (k) { return /\.fb2$/i.test(k); })[0] || Object.keys(files)[0];
      if (!inner) throw new Error('The zip holds no FB2 file');
      bytes = files[inner];
    }
    var doc = parseXml(xmlText(bytes), 'FB2');
    var root = doc.documentElement;
    var description = firstLocal(root, 'description');
    var titleInfo = description && firstLocal(description, 'title-info');
    var bt = titleInfo && firstLocal(titleInfo, 'book-title');
    var title = (bt && bt.textContent.trim()) || (name || 'Book').replace(/\.fb2(\.zip)?$|\.[^.]+$/i, '');
    var authors = [];
    if (titleInfo) childNamed(titleInfo, 'author').forEach(function (a) {
      var parts = ['first-name', 'middle-name', 'last-name'].map(function (n) { var e = childNamed(a, n)[0]; return e ? e.textContent.trim() : ''; }).filter(Boolean);
      var s = parts.join(' ') || (childNamed(a, 'nickname')[0] ? childNamed(a, 'nickname')[0].textContent.trim() : '');
      if (s) authors.push(s);
    });
    var resources = {};
    childNamed(root, 'binary').forEach(function (bin) {
      var id = bin.getAttribute('id'); if (!id) return;
      try { resources[id] = { mime: bin.getAttribute('content-type') || mimeForImage(id), bytes: b64bytes(bin.textContent) }; } catch (e) {}
    });
    var cover = null;
    var cp = titleInfo && firstLocal(titleInfo, 'coverpage');
    if (cp) { var ci = firstLocal(cp, 'image'); if (ci) cover = localAttr(ci, 'href').replace(/^#/, ''); }
    if (cover && !resources[cover]) cover = null;

    var idToPage = {};
    function inlineText(el) { return el.textContent.replace(/\s+/g, ' ').trim(); }
    function image(n) {
      var id = localAttr(n, 'href').replace(/^#/, '');
      return resources[id] ? '<div class="image"><img src="r/' + esc(id) + '" alt=""/></div>\n' : '';
    }
    function inline(el) {
      var sb = '';
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 || n.nodeType === 4) sb += esc(n.nodeValue);
        else if (n.nodeType === 1) {
          var tag = { emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code' }[n.localName];
          if (tag) sb += '<' + tag + '>' + inline(n) + '</' + tag + '>';
          else if (n.localName === 'a') sb += '<a href="' + esc(localAttr(n, 'href')) + '">' + inline(n) + '</a>';
          else if (n.localName === 'image') sb += image(n);
          else sb += inline(n);
        }
      }
      return sb;
    }
    function block(el, depth, pageIndex) {
      var sb = '';
      if (el.getAttribute('id')) idToPage[el.getAttribute('id')] = pageIndex;
      childEls(el).forEach(function (n) {
        var id = n.getAttribute('id') || '';
        if (id) idToPage[id] = pageIndex;
        var idAttr = id ? ' id="' + esc(id) + '"' : '';
        switch (n.localName) {
          case 'title': {
            var h = 'h' + Math.min(depth + 1, 4), ps = childNamed(n, 'p');
            sb += '<' + h + idAttr + '>';
            if (ps.length) ps.forEach(function (p) { sb += inline(p) + '<br/>'; }); else sb += esc(inlineText(n));
            sb += '</' + h + '>\n'; break;
          }
          case 'subtitle': sb += '<p class="subtitle"' + idAttr + '>' + inline(n) + '</p>\n'; break;
          case 'p': case 'v': sb += '<p' + idAttr + '>' + inline(n) + '</p>\n'; break;
          case 'text-author': sb += '<p class="text-author"' + idAttr + '>' + inline(n) + '</p>\n'; break;
          case 'empty-line': sb += '<br/>\n'; break;
          case 'section': sb += '<div class="section"' + idAttr + '>' + block(n, depth + 1, pageIndex) + '</div>\n'; break;
          case 'epigraph': sb += '<div class="epigraph"' + idAttr + '>' + block(n, depth, pageIndex) + '</div>\n'; break;
          case 'cite': sb += '<blockquote' + idAttr + '>' + block(n, depth, pageIndex) + '</blockquote>\n'; break;
          case 'poem': sb += '<div class="poem"' + idAttr + '>' + block(n, depth, pageIndex) + '</div>\n'; break;
          case 'stanza': sb += '<div class="stanza">' + block(n, depth, pageIndex) + '</div>\n'; break;
          case 'annotation': sb += '<div class="annotation"' + idAttr + '>' + block(n, depth, pageIndex) + '</div>\n'; break;
          case 'image': sb += image(n); break;
          case 'table':
            sb += '<table' + idAttr + '>';
            childNamed(n, 'tr').forEach(function (tr) {
              sb += '<tr>';
              childEls(tr).forEach(function (c) { var t = c.localName === 'th' ? 'th' : 'td'; sb += '<' + t + '>' + inline(c) + '</' + t + '>'; });
              sb += '</tr>';
            });
            sb += '</table>\n'; break;
          case 'date': sb += '<p class="date">' + esc(inlineText(n)) + '</p>\n'; break;
          default: sb += block(n, depth, pageIndex);
        }
      });
      return sb;
    }
    var pages = [];
    childNamed(root, 'body').forEach(function (body) {
      var bname = body.getAttribute('name') || '';
      var isNotes = bname === 'notes' || bname === 'comments' || bname === 'footnotes';
      var bt2 = childNamed(body, 'title')[0], bodyTitle = bt2 ? inlineText(bt2) : null;
      var sections = childNamed(body, 'section');
      if (!sections.length || isNotes) {
        var label = bodyTitle || (isNotes ? 'Notes' : title);
        pages.push({ label: label, html: FB2_CSS + block(body, 1, pages.length), depth: 0 });
      } else {
        sections.forEach(function (sec) {
          var pageIndex = pages.length, st = childNamed(sec, 'title')[0];
          var label = st ? inlineText(st) : 'Chapter ' + (pageIndex + 1);
          pages.push({ label: label, html: FB2_CSS + block(sec, 1, pageIndex), depth: bodyTitle ? 1 : 0 });
        });
      }
    });
    if (!pages.length) throw new Error('The FB2 file has no text');
    pages.forEach(function (p, i) {
      p.html = p.html.replace(/href="#([^"]+)"/g, function (m, id) { var t = idToPage[id]; return (t == null || t === i) ? m : 'href="#"'; });
    });
    return new MemoryBook(title, authors, pages, resources, cover);
  };

  // ---------- Rich Text Format ----------
  var RTF_SKIP = {};
  'fonttbl colortbl stylesheet info pict object header footer headerl headerr footerl footerr footnote xe tc field fldinst listtable listoverridetable revtbl rsidtbl generator themedata colorschememapping latentstyles datastore xmlnstbl mmathPr pntext'.split(' ').forEach(function (w) { RTF_SKIP[w] = true; });
  function rtfBlocks(bytes) {
    var decoder = new TextDecoder('windows-1252');
    var blocks = [], para = '', stack = [], pending = [];
    var st = { bold: false, italic: false, underline: false, skip: false, uc: 1 };
    var openB = false, openI = false, openU = false;
    var i = 0, n = bytes.length;
    function flushBytes() { if (pending.length) { para += esc(decoder.decode(new Uint8Array(pending))); pending = []; } }
    function syncFormat() {
      flushBytes();
      if (openU && !st.underline) { para += '</u>'; openU = false; }
      if (openI && !st.italic) { para += '</i>'; openI = false; }
      if (openB && !st.bold) { para += '</b>'; openB = false; }
      if (!openB && st.bold) { para += '<b>'; openB = true; }
      if (!openI && st.italic) { para += '<i>'; openI = true; }
      if (!openU && st.underline) { para += '<u>'; openU = true; }
    }
    function closeFormat() { flushBytes(); if (openU) { para += '</u>'; openU = false; } if (openI) { para += '</i>'; openI = false; } if (openB) { para += '</b>'; openB = false; } }
    function endParagraph() { closeFormat(); var t = para.trim(); if (t) blocks.push('<p>' + t + '</p>'); para = ''; }
    function text(s) { if (st.skip) return; syncFormat(); para += esc(s); }
    function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
    function isDigit(c) { return c >= 48 && c <= 57; }
    while (i < n) {
      var c = bytes[i];
      if (c === 123) { stack.push(st); st = { bold: st.bold, italic: st.italic, underline: st.underline, skip: st.skip, uc: st.uc }; i++; }
      else if (c === 125) { flushBytes(); st = stack.pop() || { bold: false, italic: false, underline: false, skip: false, uc: 1 }; if (!st.skip) syncFormat(); i++; }
      else if (c === 92) {
        i++; if (i >= n) break;
        var d = bytes[i];
        if (d === 39) { // \'hh
          if (i + 2 < n) { var v = parseInt(latin(bytes, i + 1, 2), 16); if (!isNaN(v) && !st.skip) { syncFormat(); pending.push(v); } i += 3; } else i = n;
        }
        else if (d === 42) { st.skip = true; i++; }
        else if (d === 126) { text(' '); i++; }
        else if (d === 45 || d === 95) { i++; }
        else if (d === 123 || d === 125 || d === 92) { text(String.fromCharCode(d)); i++; }
        else if (d === 10 || d === 13) { endParagraph(); i++; }
        else if (isLetter(d)) {
          var start = i;
          while (i < n && isLetter(bytes[i])) i++;
          var word = latin(bytes, start, i - start), numStr = '';
          if (i < n && (bytes[i] === 45 || isDigit(bytes[i]))) { var ns = i; i++; while (i < n && isDigit(bytes[i])) i++; numStr = latin(bytes, ns, i - ns); }
          if (i < n && bytes[i] === 32) i++;
          var num = numStr === '' ? null : parseInt(numStr, 10);
          switch (word) {
            case 'par': case 'sect': case 'page': case 'row': if (!st.skip) endParagraph(); break;
            case 'line': if (!st.skip) { syncFormat(); para += '<br/>'; } break;
            case 'tab': case 'cell': text('\t'); break;
            case 'b': st.bold = num !== 0; if (!st.skip) syncFormat(); break;
            case 'i': st.italic = num !== 0; if (!st.skip) syncFormat(); break;
            case 'ul': st.underline = num !== 0; if (!st.skip) syncFormat(); break;
            case 'ulnone': st.underline = false; if (!st.skip) syncFormat(); break;
            case 'plain': case 'pard': st.bold = st.italic = st.underline = false; if (!st.skip) syncFormat(); break;
            case 'uc': st.uc = num == null ? 1 : num; break;
            case 'u': {
              if (num != null && !st.skip) text(String.fromCodePoint(num < 0 ? num + 65536 : num));
              var skip = st.uc;
              while (skip > 0 && i < n) { if (bytes[i] === 92 && i + 1 < n && bytes[i + 1] === 39) i += 4; else i++; skip--; }
              break;
            }
            case 'ansicpg': if (num != null) { try { decoder = new TextDecoder('windows-' + num); } catch (e) {} } break;
            case 'emdash': text('—'); break;
            case 'endash': text('–'); break;
            case 'lquote': text('‘'); break;
            case 'rquote': text('’'); break;
            case 'ldblquote': text('“'); break;
            case 'rdblquote': text('”'); break;
            case 'bullet': text('•'); break;
            default: if (RTF_SKIP[word]) st.skip = true;
          }
        }
        else i++;
      }
      else if (c === 13 || c === 10) i++;
      else { if (!st.skip) { syncFormat(); pending.push(c); } i++; }
    }
    endParagraph();
    if (!blocks.length) throw new Error('The RTF file has no readable text');
    return blocks;
  }
  B.Rtf = function (buffer, name) {
    var blocks = rtfBlocks(new Uint8Array(buffer));
    var title = (name || 'Document').replace(/\.[^.]+$/, '');
    var pages = paginate(blocks, 60000).map(function (pg, i) { return { label: 'Part ' + (i + 1), html: DOC_CSS + pg }; });
    return new MemoryBook(title, [], pages, {}, null);
  };

  // ---------- OpenDocument text ----------
  B.Odt = function (buffer, name) {
    var files = fflate.unzipSync(new Uint8Array(buffer));
    if (!files['content.xml']) throw new Error('Not an OpenDocument file (content.xml missing)');
    var doc = parseXml(xmlText(files['content.xml']), 'ODT');
    var text = firstLocal(doc.documentElement, 'text');
    if (!text) throw new Error('Document has no text body');
    var resources = {}, blocks = [], headings = [];
    function image(el) {
      var href = localAttr(el, 'href'); if (!href || !files[href]) return '';
      var key = 'img' + Object.keys(resources).length + '.' + href.split('.').pop();
      resources[key] = { mime: mimeForImage(href), bytes: files[href] };
      return '<img src="r/' + key + '" alt=""/>';
    }
    function inline(el) {
      var sb = '';
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) sb += esc(n.nodeValue);
        else if (n.nodeType === 1) {
          switch (n.localName) {
            case 's': sb += new Array((parseInt(localAttr(n, 'c'), 10) || 1) + 1).join(' '); break;
            case 'tab': sb += '&#160;&#160;&#160;&#160;'; break;
            case 'line-break': sb += '<br/>'; break;
            case 'image': sb += image(n); break;
            case 'a': sb += '<a href="' + esc(localAttr(n, 'href')) + '">' + inline(n) + '</a>'; break;
            case 'note': sb += '<sup>' + inline(firstLocal(n, 'note-body') || n) + '</sup>'; break;
            default: sb += inline(n);
          }
        }
      }
      return sb;
    }
    function walk(el) {
      childEls(el).forEach(function (n) {
        switch (n.localName) {
          case 'h': {
            var level = Math.min(6, Math.max(1, parseInt(localAttr(n, 'outline-level'), 10) || 1)), content = inline(n), hl = Math.min(level, 4);
            headings.push({ label: content.replace(/<[^>]+>/g, '').trim(), block: blocks.length, level: level });
            blocks.push('<h' + hl + '>' + content + '</h' + hl + '>'); break;
          }
          case 'p': blocks.push('<p>' + inline(n) + '</p>'); break;
          case 'list': {
            var sb = '<ul>';
            childEls(n).forEach(function (item) { sb += '<li>'; childEls(item).forEach(function (c) { if (c.localName === 'p' || c.localName === 'h') sb += inline(c) + ' '; }); sb += '</li>'; });
            blocks.push(sb + '</ul>'); break;
          }
          case 'table': {
            var tb = '<table>';
            byLocal(n, 'table-row').forEach(function (row) {
              tb += '<tr>';
              childEls(row).forEach(function (cell) { tb += '<td>'; childEls(cell).forEach(function (p) { tb += inline(p) + '<br/>'; }); tb += '</td>'; });
              tb += '</tr>';
            });
            blocks.push(tb + '</table>'); break;
          }
          case 'sequence-decls': case 'soft-page-break': break;
          default: walk(n);
        }
      });
    }
    walk(text);
    var title = null;
    if (files['meta.xml']) { try { var t = firstLocal(parseXml(xmlText(files['meta.xml']), 'meta').documentElement, 'title'); if (t && t.textContent.trim()) title = t.textContent.trim(); } catch (e) {} }
    return assemble(title || (name || 'Document').replace(/\.[^.]+$/, ''), blocks, headings, resources);
  };

  // ---------- Comics (CBZ, CBR) ----------
  var COMIC_CSS = '<style>html,body{margin:0;padding:0;background:#000}.pg{text-align:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style>';
  function comicBook(name, entries) { // entries: [{name, bytes}]
    var list = entries.filter(function (e) { return isImageName(e.name) && e.name.split('/').pop().charAt(0) !== '.'; })
      .sort(function (a, b) { return naturalCompare(a.name, b.name); });
    if (!list.length) throw new Error('No images found in the comic archive');
    var title = (name || 'Comic').replace(/\.[^.]+$/, ''), resources = {}, pages = [];
    list.forEach(function (e, i) {
      var key = 'img' + i + '.' + e.name.split('.').pop().toLowerCase();
      resources[key] = { mime: mimeForImage(e.name), bytes: e.bytes };
      pages.push({ label: 'Page ' + (i + 1), html: COMIC_CSS + '<div class="pg"><img src="r/' + key + '" alt="page ' + (i + 1) + '"/></div>' });
    });
    return new MemoryBook(title, [], pages, resources, 'img0.' + list[0].name.split('.').pop().toLowerCase());
  }
  B.Cbz = function (buffer, name) {
    var files = fflate.unzipSync(new Uint8Array(buffer), { filter: function (f) { return isImageName(f.name); } });
    return comicBook(name, Object.keys(files).map(function (k) { return { name: k, bytes: files[k] }; }));
  };
  var unrarLoading = null;
  function loadUnrar() {
    if (window.Unrar) return Promise.resolve(window.Unrar);
    if (!unrarLoading) unrarLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'unrar.js';
      s.onload = function () { resolve(window.Unrar); };
      s.onerror = function () { unrarLoading = null; reject(new Error('Could not load the RAR unpacker (unrar.js)')); };
      document.head.appendChild(s);
    });
    return unrarLoading;
  }
  B.Cbr = async function (buffer, name) {
    var Unrar = await loadUnrar();
    var extractor = await Unrar.createExtractorFromData({ data: buffer });
    var entries = [];
    try {
      var res = extractor.extract({ files: function (h) { return !h.flags.directory && isImageName(h.name); } });
      for (var f of res.files) if (f.extraction) entries.push({ name: f.fileHeader.name, bytes: f.extraction });
    } catch (e) {
      if (e.reason === 'ERAR_MISSING_PASSWORD' || e.reason === 'ERAR_BAD_PASSWORD') throw new Error('The archive is password protected');
      throw new Error('Could not open RAR: ' + (e.message || e));
    }
    return comicBook(name, entries);
  };

  // ---------- dispatch ----------
  var openEpubOrTxt = B.open;
  B.open = function (buffer, name) {
    var lower = (name || '').toLowerCase(), ext = lower.split('.').pop();
    if (ext === 'mobi' || ext === 'azw' || ext === 'azw3' || ext === 'prc') return new B.Mobi(buffer, name);
    if (ext === 'docx') return new B.Docx(buffer, name);
    if (ext === 'fb2' || /\.fb2\.zip$/.test(lower)) return new B.Fb2(buffer, name);
    if (ext === 'rtf') return new B.Rtf(buffer, name);
    if (ext === 'odt') return new B.Odt(buffer, name);
    if (ext === 'cbz') return new B.Cbz(buffer, name);
    if (ext === 'cbr' || ext === 'rar') return B.Cbr(buffer, name); // a Promise
    return openEpubOrTxt(buffer, name);
  };
  B.canOpen = function (name) { return /\.(epub|txt|pdf|mobi|azw|azw3|prc|docx|fb2|fb2\.zip|rtf|odt|cbz|cbr)$/i.test(name || ''); };
})();
