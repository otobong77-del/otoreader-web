/* Chapter marks inside audiobooks and films, read from the file bytes in the browser: MP4/M4B chapter text
   tracks and Nero chpl atoms, ID3v2 CHAP frames in MP3, Matroska Chapters. Mirrors the phone's MediaChapters. */
(function () {
  'use strict';
  var utf8 = new TextDecoder('utf-8'), be = new TextDecoder('utf-16be'), le = new TextDecoder('utf-16le');

  function text(u8, from, len) {
    if (len >= 2 && u8[from] === 0xFE && u8[from + 1] === 0xFF) return be.decode(u8.subarray(from + 2, from + len));
    if (len >= 2 && u8[from] === 0xFF && u8[from + 1] === 0xFE) return le.decode(u8.subarray(from + 2, from + len));
    return utf8.decode(u8.subarray(from, from + len)).replace(/\0+$/, '');
  }
  function fourcc(u8, at) { return String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]); }

  // ---- MP4 ----
  function boxes(d, u8, from, to) {
    var out = [], at = from;
    while (at + 8 <= to) {
      var size = d.getUint32(at), type = fourcc(u8, at + 4), hdr = 8;
      if (size === 1) { if (at + 16 > to) break; size = d.getUint32(at + 8) * 4294967296 + d.getUint32(at + 12); hdr = 16; }
      if (size === 0) size = to - at;
      if (size < hdr || at + size > to) break;
      out.push({ type: type, s: at + hdr, e: at + size });
      at += size;
    }
    return out;
  }
  function mp4(d, u8) {
    var top = boxes(d, u8, 0, u8.length), moov = null;
    top.forEach(function (b) { if (b.type === 'moov') moov = b; });
    if (!moov) return [];
    var traks = [], chpl = [];
    boxes(d, u8, moov.s, moov.e).forEach(function (b) {
      if (b.type === 'trak') traks.push(trak(d, u8, b.s, b.e));
      else if (b.type === 'udta') boxes(d, u8, b.s, b.e).forEach(function (c) { if (c.type === 'chpl') chpl = nero(d, u8, c.s, c.e); });
    });
    var refs = {};
    traks.forEach(function (t) { t.chap.forEach(function (id) { refs[id] = true; }); });
    var tt = traks.filter(function (t) { return refs[t.id] && (t.handler === 'text' || t.handler === 'sbtl' || t.handler === 'subt' || t.sampleType === 'text' || t.sampleType === 'tx3g'); })[0]
      || traks.filter(function (t) { return refs[t.id]; })[0];
    if (tt) { var fromTrack = samples(d, u8, tt); if (fromTrack.length >= 2) return fromTrack; }
    return chpl;
  }
  function trak(d, u8, from, to) {
    var t = { id: 0, timescale: 1, handler: '', sampleType: '', chap: [], stts: [], stsc: [], sizes: null, fixed: 0, count: 0, chunks: [] };
    boxes(d, u8, from, to).forEach(function (b) {
      if (b.type === 'tkhd') t.id = u8[b.s] === 1 ? d.getUint32(b.s + 20) : d.getUint32(b.s + 12);
      else if (b.type === 'tref') boxes(d, u8, b.s, b.e).forEach(function (c) { if (c.type === 'chap') for (var i = c.s; i + 4 <= c.e; i += 4) t.chap.push(d.getUint32(i)); });
      else if (b.type === 'mdia') boxes(d, u8, b.s, b.e).forEach(function (c) {
        if (c.type === 'mdhd') t.timescale = u8[c.s] === 1 ? d.getUint32(c.s + 20) : d.getUint32(c.s + 12);
        else if (c.type === 'hdlr') t.handler = fourcc(u8, c.s + 8);
        else if (c.type === 'minf') boxes(d, u8, c.s, c.e).forEach(function (m) { if (m.type === 'stbl') stbl(d, u8, m.s, m.e, t); });
      });
    });
    return t;
  }
  function stbl(d, u8, from, to, t) {
    boxes(d, u8, from, to).forEach(function (b) {
      var n, i;
      if (b.type === 'stsd' && b.e - b.s >= 16) t.sampleType = fourcc(u8, b.s + 12);
      else if (b.type === 'stts') { n = d.getUint32(b.s + 4); if (n <= (b.e - b.s - 8) / 8) for (i = 0; i < n; i++) t.stts.push([d.getUint32(b.s + 8 + i * 8), d.getUint32(b.s + 12 + i * 8)]); }
      else if (b.type === 'stsc') { n = d.getUint32(b.s + 4); if (n <= (b.e - b.s - 8) / 12) for (i = 0; i < n; i++) t.stsc.push([d.getUint32(b.s + 8 + i * 12), d.getUint32(b.s + 12 + i * 12)]); }
      else if (b.type === 'stsz') { t.fixed = d.getUint32(b.s + 4); n = d.getUint32(b.s + 8); t.count = n; if (!t.fixed && n <= (b.e - b.s - 12) / 4) { t.sizes = []; for (i = 0; i < n; i++) t.sizes.push(d.getUint32(b.s + 12 + i * 4)); } }
      else if (b.type === 'stco') { n = d.getUint32(b.s + 4); if (n <= (b.e - b.s - 8) / 4) for (i = 0; i < n; i++) t.chunks.push(d.getUint32(b.s + 8 + i * 4)); }
      else if (b.type === 'co64') { n = d.getUint32(b.s + 4); if (n <= (b.e - b.s - 8) / 8) for (i = 0; i < n; i++) t.chunks.push(d.getUint32(b.s + 8 + i * 8) * 4294967296 + d.getUint32(b.s + 12 + i * 8)); }
    });
  }
  function samples(d, u8, t) {
    if (!t.chunks.length || !t.stsc.length || t.count <= 0 || t.count > 20000) return [];
    var n = t.count, offsets = new Array(n), sample = 0, k, c, i;
    for (k = 0; k < t.stsc.length; k++) {
      var first = t.stsc[k][0] - 1, last = k + 1 < t.stsc.length ? t.stsc[k + 1][0] - 1 : t.chunks.length, per = t.stsc[k][1];
      for (c = first; c < last && c < t.chunks.length; c++) {
        var off = t.chunks[c];
        for (i = 0; i < per && sample < n; i++) { offsets[sample] = off; off += t.fixed || (t.sizes ? t.sizes[sample] : 0) || 0; sample++; }
      }
    }
    var starts = new Array(n), dts = 0, s = 0;
    t.stts.forEach(function (e) { for (var j = 0; j < e[0] && s < n; j++) { starts[s++] = dts; dts += e[1]; } });
    var out = [];
    for (s = 0; s < n; s++) {
      var size = t.fixed || (t.sizes ? t.sizes[s] : 0) || 0;
      if (size < 2 || size > 4096 || !offsets[s] || offsets[s] + size > u8.length) continue;
      var tl = Math.min(d.getUint16(offsets[s]), size - 2);
      out.push({ title: text(u8, offsets[s] + 2, tl), start: Math.round(starts[s] * 1000 / Math.max(1, t.timescale)) });
    }
    return out;
  }
  function nero(d, u8, from, to) {
    var at = from, version = u8[at]; at += 4; if (version === 1) at += 4;
    if (at >= to) return [];
    var n = u8[at++], out = [];
    for (var i = 0; i < n && at + 9 <= to; i++) {
      var start = (d.getUint32(at) * 4294967296 + d.getUint32(at + 4)) / 10000, tl = u8[at + 8]; at += 9;
      if (at + tl > to) break;
      out.push({ title: utf8.decode(u8.subarray(at, at + tl)), start: Math.round(start) }); at += tl;
    }
    return out;
  }

  // ---- ID3v2 ----
  function synchsafe(u8, at) { return ((u8[at] & 0x7F) << 21) | ((u8[at + 1] & 0x7F) << 14) | ((u8[at + 2] & 0x7F) << 7) | (u8[at + 3] & 0x7F); }
  function deunsync(u8) {
    var out = new Uint8Array(u8.length), n = 0;
    for (var i = 0; i < u8.length; i++) { out[n++] = u8[i]; if (u8[i] === 0xFF && i + 1 < u8.length && u8[i + 1] === 0) i++; }
    return out.subarray(0, n);
  }
  function id3(u8) {
    if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return [];
    var major = u8[3], flags = u8[5], size = synchsafe(u8, 6);
    if (major < 3 || size <= 0 || size > u8.length - 10) return [];
    var tag = u8.subarray(10, 10 + size), tagUnsync = !!(flags & 0x80);
    if (tagUnsync) tag = deunsync(tag);
    var d = new DataView(tag.buffer, tag.byteOffset, tag.byteLength), at = 0, out = [];
    if (flags & 0x40) at += major === 4 ? synchsafe(tag, 0) : d.getUint32(0) + 4;
    while (at + 10 <= tag.length) {
      if (tag[at] === 0) break;
      var id = fourcc(tag, at), fsize = major === 4 ? synchsafe(tag, at + 4) : d.getUint32(at + 4), fflags = d.getUint16(at + 8);
      at += 10;
      if (fsize < 0 || at + fsize > tag.length) break;
      if (id === 'CHAP') {
        var body = tag.subarray(at, at + fsize);
        if (major === 4 && !tagUnsync && (fflags & 0x0002)) body = deunsync(body);
        var skip = (major === 4 && (fflags & 0x0001) ? 4 : 0) + (major === 3 && (fflags & 0x0080) ? 4 : 0) + (major === 3 && (fflags & 0x0040) ? 1 : 0) + (major === 4 && (fflags & 0x0004) ? 1 : 0);
        if (skip) body = body.subarray(Math.min(skip, body.length));
        var c = chap(body, major); if (c) out.push(c);
      }
      at += fsize;
    }
    return out;
  }
  function chap(b, major) {
    var d = new DataView(b.buffer, b.byteOffset, b.byteLength), at = 0;
    while (at < b.length && b[at] !== 0) at++;
    at++;
    if (at + 16 > b.length) return null;
    var start = d.getUint32(at); at += 16;
    var title = '';
    while (at + 10 <= b.length) {
      var id = fourcc(b, at), fsize = major === 4 ? synchsafe(b, at + 4) : d.getUint32(at + 4);
      at += 10;
      if (fsize <= 0 || at + fsize > b.length) break;
      if (id === 'TIT2' && !title) {
        var enc = b[at];
        title = enc === 1 ? text(b, at + 1, fsize - 1) : enc === 2 ? be.decode(b.subarray(at + 1, at + fsize)) : enc === 3 ? utf8.decode(b.subarray(at + 1, at + fsize)) : String.fromCharCode.apply(null, b.subarray(at + 1, at + fsize));
        title = title.replace(/\0+$/, '');
      }
      at += fsize;
    }
    return { title: title, start: start };
  }

  // ---- Matroska ----
  function mkv(u8) {
    var p = 0;
    function vint(keep) {
      if (p >= u8.length) return -1;
      var first = u8[p], m = 0x80, len = 1;
      while (len <= 8 && !(first & m)) { m >>= 1; len++; }
      if (len > 8) return -1;
      var v = keep ? first : (first & (0xFF >> len));
      for (var i = 1; i < len; i++) v = v * 256 + u8[p + i];
      p += len;
      if (!keep && v === Math.pow(2, 7 * len) - 1) return -1;
      return v;
    }
    function uint(size) { var v = 0; for (var i = 0; i < size; i++) v = v * 256 + u8[p + i]; p += size; return v; }
    if (vint(true) !== 0x1A45DFA3) return [];
    var hs = vint(false); if (hs < 0) return []; p += hs;
    if (vint(true) !== 0x18538067) return [];
    var segSize = vint(false), segStart = p, segEnd = segSize < 0 ? u8.length : Math.min(u8.length, segStart + segSize);
    var chapters = [], seekChapters = -1, scanned = 0;
    function atoms(from, to) {
      p = from;
      while (p < to) {
        var id = vint(true), size = vint(false); if (id < 0 || size < 0) return;
        var body = p;
        if (id === 0x45B9) atoms(body, body + size);
        else if (id === 0xB6) {
          var start = -1, title = '', hidden = false;
          p = body;
          while (p < body + size) {
            var i2 = vint(true), s2 = vint(false); if (i2 < 0 || s2 < 0) break;
            var b2 = p;
            if (i2 === 0x91) start = uint(s2);
            else if (i2 === 0x98) hidden = uint(s2) === 1;
            else if (i2 === 0x80) { while (p < b2 + s2) { var i3 = vint(true), s3 = vint(false); if (i3 < 0 || s3 < 0) break; if (i3 === 0x85 && !title) title = utf8.decode(u8.subarray(p, p + s3)); p += s3; } }
            p = b2 + s2;
          }
          if (start >= 0 && !hidden) chapters.push({ title: title, start: Math.round(start / 1000000) });
        }
        p = body + size;
      }
    }
    function seekHead(from, to) {
      p = from;
      while (p < to) {
        var id = vint(true), size = vint(false); if (id < 0 || size < 0) return -1;
        var end = p + size;
        if (id === 0x4DBB) {
          var sid = -1, pos = -1;
          while (p < end) { var i2 = vint(true), s2 = vint(false); if (i2 < 0 || s2 < 0) break; if (i2 === 0x53AB) sid = uint(s2); else if (i2 === 0x53AC) pos = uint(s2); else p += s2; }
          if (sid === 0x1043A770 && pos >= 0) return segStart + pos;
        }
        p = end;
      }
      return -1;
    }
    var at = segStart;
    while (at < segEnd && scanned < 64) {
      p = at;
      var id = vint(true), size = vint(false); if (id < 0 || size < 0) break;
      var body = p;
      if (id === 0x1043A770) atoms(body, body + size);
      else if (id === 0x114D9B74) seekChapters = seekHead(body, body + size);
      else if (id === 0x1F43B675) { if (chapters.length) return chapters; if (seekChapters > 0) { at = seekChapters; seekChapters = -1; scanned++; continue; } }
      if (chapters.length) return chapters;
      at = body + size; scanned++;
    }
    return chapters;
  }

  function read(buf, name) {
    try {
      var ext = String(name || '').toLowerCase().split('.').pop(), u8 = new Uint8Array(buf), d = new DataView(buf), out;
      if (/^(mp4|m4v|m4a|m4b|mov|3gp|aac)$/.test(ext)) out = mp4(d, u8);
      else if (ext === 'mp3') out = id3(u8);
      else if (ext === 'mkv' || ext === 'webm') out = mkv(u8);
      else return [];
      out.sort(function (a, b) { return a.start - b.start; });
      var clean = [];
      out.forEach(function (c, i) {
        if (clean.length && c.start - clean[clean.length - 1].start < 500) return;
        clean.push({ title: (String(c.title || '').trim() || ('Chapter ' + (i + 1))).slice(0, 120), start: Math.max(0, c.start) });
      });
      return clean.length >= 2 ? clean : [];
    } catch (e) { return []; }
  }

  var api = { read: read };
  if (typeof window !== 'undefined') window.MediaChapters = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
