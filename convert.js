/* convert.js — the CONVERTER for the web and desktop versions: any book the page can open becomes an
   EPUB or a Word file, made right here in the browser; a PDF comes from the browser's print dialog
   (Save as PDF). Works on a Books document (epub.js / formats.js): spine, section(i) → {html, css, urls}. */
(function () {
  'use strict';
  var C = window.Convert = {};

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function extOf(mime) { return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'text/css': 'css' }[mime] || 'bin'; }
  async function fetchBytes(url) { var r = await fetch(url); return { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0] }; }

  /** Pulls every blob: URL out of a section's html and css into named files; returns the rewritten html/css. */
  async function gather(sec, files, counter, prefix) {
    var map = {};
    async function take(url) {
      if (map[url]) return map[url];
      try {
        var got = await fetchBytes(url);
        var name = prefix + 'img' + (++counter.n) + '.' + extOf(got.mime);
        files[name] = got.bytes;
        map[url] = { name: name, mime: got.mime };
      } catch (e) { map[url] = null; }
      return map[url];
    }
    var html = sec.html, css = sec.css || '';
    var urls = [];
    html.replace(/blob:[^"')\s]+/g, function (u) { urls.push(u); return u; });
    css.replace(/blob:[^"')\s]+/g, function (u) { urls.push(u); return u; });
    for (var i = 0; i < urls.length; i++) await take(urls[i]);
    html = html.replace(/blob:[^"')\s]+/g, function (u) { return map[u] ? map[u].name : u; });
    css = css.replace(/blob:[^"')\s]+/g, function (u) { return map[u] ? map[u].name : u; });
    return { html: html, css: css, images: map };
  }

  // ---------- EPUB ----------

  C.toEpub = async function (doc, title, author, onProgress) {
    var files = {};
    var counter = { n: 0 };
    var manifest = [], spine = [];
    var sectionNames = [];
    for (var i = 0; i < doc.spine.length; i++) {
      if (onProgress) onProgress(i, doc.spine.length);
      var sec = doc.section(i);
      var g = await gather(sec, files, counter, '');
      (sec.urls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      var name = 's' + (i + 1) + '.xhtml';
      var html = g.html.replace(/href="oto:(\d+)#?([^"]*)"/g, function (m, idx, frag) { return 'href="s' + (+idx + 1) + '.xhtml' + (frag ? '#' + frag : '') + '"'; });
      var page = '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + esc(title) + '</title>' + (g.css ? '<style>' + g.css.replace(/<\/style/gi, '') + '</style>' : '') + '</head><body>\n' + html + '\n</body></html>';
      files[name] = new TextEncoder().encode(page);
      manifest.push({ id: 'sec' + (i + 1), href: name, type: 'application/xhtml+xml' });
      spine.push('sec' + (i + 1));
      sectionNames.push(name);
    }
    Object.keys(files).forEach(function (n) { if (!/\.xhtml$/.test(n)) manifest.push({ id: 'r' + manifest.length, href: n, type: { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', css: 'text/css' }[n.split('.').pop()] || 'application/octet-stream' }); });
    var coverId = null;
    var cu = doc.coverUrl && doc.coverUrl();
    if (cu) { try { var cb = await fetchBytes(cu); files['cover.' + extOf(cb.mime)] = cb.bytes; coverId = 'cover'; manifest.push({ id: 'cover', href: 'cover.' + extOf(cb.mime), type: cb.mime, cover: true }); } catch (e) {} finally { try { URL.revokeObjectURL(cu); } catch (e) {} } }
    var toc = (doc.toc || []).filter(function (t) { return t.section >= 0 && t.section < sectionNames.length; });
    if (!toc.length) toc = [{ label: title, section: 0, fragment: '' }];
    var nav = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>' +
      toc.map(function (t) { return '<li><a href="' + sectionNames[t.section] + (t.fragment ? '#' + t.fragment : '') + '">' + esc(t.label || 'Part ' + (t.section + 1)) + '</a></li>'; }).join('') + '</ol></nav></body></html>';
    var ncx = '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="otoreader"/></head><docTitle><text>' + esc(title) + '</text></docTitle><navMap>' +
      toc.map(function (t, k) { return '<navPoint id="np' + (k + 1) + '" playOrder="' + (k + 1) + '"><navLabel><text>' + esc(t.label || 'Part ' + (t.section + 1)) + '</text></navLabel><content src="' + sectionNames[t.section] + (t.fragment ? '#' + t.fragment : '') + '"/></navPoint>'; }).join('') + '</navMap></ncx>';
    var opf = '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:identifier id="uid">urn:otoreader:' + Date.now() + '</dc:identifier><dc:title>' + esc(title) + '</dc:title>' + (author ? '<dc:creator>' + esc(author) + '</dc:creator>' : '') +
      '<dc:language>en</dc:language><meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>' + (coverId ? '<meta name="cover" content="cover"/>' : '') + '</metadata><manifest>' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      manifest.map(function (m) { return '<item id="' + m.id + '" href="' + esc(m.href) + '" media-type="' + m.type + '"' + (m.cover ? ' properties="cover-image"' : '') + '/>'; }).join('') +
      '</manifest><spine toc="ncx">' + spine.map(function (id) { return '<itemref idref="' + id + '"/>'; }).join('') + '</spine></package>';
    var zip = {};
    zip['mimetype'] = [new TextEncoder().encode('application/epub+zip'), { level: 0 }];
    zip['META-INF/container.xml'] = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip['OEBPS/content.opf'] = new TextEncoder().encode(opf);
    zip['OEBPS/nav.xhtml'] = new TextEncoder().encode(nav);
    zip['OEBPS/toc.ncx'] = new TextEncoder().encode(ncx);
    Object.keys(files).forEach(function (n) { zip['OEBPS/' + n] = files[n]; });
    return fflate.zipSync(zip, { level: 6 });
  };

  // ---------- Word ----------

  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="' + W + '">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="2400" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>' +
    [40, 34, 30, 27, 25, 24].map(function (sz, i) { return '<w:style w:type="paragraph" w:styleId="Heading' + (i + 1) + '"><w:name w:val="heading ' + (i + 1) + '"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="' + (i < 3 ? 480 - i * 100 : 200) + '" w:after="160"/><w:outlineLvl w:val="' + i + '"/></w:pPr><w:rPr><w:b/>' + (i === 5 ? '<w:i/>' : '') + '<w:sz w:val="' + sz + '"/></w:rPr></w:style>'; }).join('') +
    '</w:styles>';
  var BLOCKS = { p: 1, div: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, li: 1, blockquote: 1, pre: 1, tr: 1, section: 1, article: 1, header: 1, footer: 1, figure: 1, figcaption: 1, dd: 1, dt: 1, hr: 1, table: 1, ul: 1, ol: 1 };

  C.toDocx = async function (doc, title, author, onProgress) {
    var body = [], media = [], imgNo = 0;
    body.push('<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">' + esc(title) + '</w:t></w:r></w:p>');
    if (author) body.push('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">' + esc(author) + '</w:t></w:r></w:p>');
    for (var i = 0; i < doc.spine.length; i++) {
      if (onProgress) onProgress(i, doc.spine.length);
      var sec = doc.section(i);
      var dom = new DOMParser().parseFromString('<div id="root">' + sec.html + '</div>', 'text/html');
      var root = dom.getElementById('root');
      if (!root) continue;
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      var para = null; // { style, runs: [] }
      var fmt = { b: 0, i: 0, u: 0 };
      function open(style) { if (!para) para = { style: style || null, runs: [] }; else if (style && !para.style && !para.runs.length) para.style = style; }
      function close() { if (para && para.runs.length) body.push('<w:p>' + (para.style ? '<w:pPr><w:pStyle w:val="' + para.style + '"/></w:pPr>' : '') + para.runs.join('') + '</w:p>'); para = null; }
      function text(t) {
        if (!t) return;
        open(null);
        var rpr = (fmt.b ? '<w:b/>' : '') + (fmt.i ? '<w:i/>' : '') + (fmt.u ? '<w:u w:val="single"/>' : '');
        para.runs.push('<w:r>' + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + esc(t) + '</w:t></w:r>');
      }
      async function image(src) {
        if (!src || !/^blob:/.test(src)) return;
        try {
          var got = await fetchBytes(src);
          var bmp = await createImageBitmap(new Blob([got.bytes], { type: got.mime }));
          var n = ++imgNo, ext = extOf(got.mime) === 'bin' ? 'png' : extOf(got.mime);
          var name = 'image' + n + '.' + ext, rid = 'rIdImg' + n;
          media.push({ rid: rid, name: name, bytes: got.bytes });
          var cx = bmp.width * 9525, cy = bmp.height * 9525, MAX = 5900000;
          if (cx > MAX) { cy = Math.round(cy * MAX / cx); cx = MAX; }
          bmp.close && bmp.close();
          open(null);
          para.runs.push('<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + n + '" name="Picture ' + n + '"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="' + n + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>');
        } catch (e) {}
      }
      async function walk(node) {
        for (var c = node.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) { text(c.nodeValue.replace(/\s+/g, ' ')); continue; }
          if (c.nodeType !== 1) continue;
          var tag = c.localName;
          if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'title') continue;
          if (tag === 'br') { text(''); if (para) para.runs.push('<w:r><w:br/></w:r>'); continue; }
          if (tag === 'img') { await image(c.getAttribute('src')); continue; }
          if (tag === 'svg') { var im = c.querySelector('image'); if (im) await image(im.getAttribute('href') || im.getAttribute('xlink:href')); continue; }
          var block = BLOCKS[tag] === 1;
          var heading = /^h[1-6]$/.test(tag) ? 'Heading' + tag.charAt(1) : null;
          if (block) { close(); open(heading); }
          var pushed = null;
          if (tag === 'b' || tag === 'strong') pushed = 'b'; else if (tag === 'i' || tag === 'em') pushed = 'i'; else if (tag === 'u') pushed = 'u';
          if (pushed) fmt[pushed]++;
          if (tag === 'li') text('• ');
          await walk(c);
          if (pushed) fmt[pushed]--;
          if (block) close();
        }
      }
      await walk(root);
      close();
      (sec.urls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    }
    body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>');
    var enc = function (s) { return new TextEncoder().encode(s); };
    var zip = {};
    zip['[Content_Types].xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
    zip['_rels/.rels'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
    zip['docProps/core.xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + esc(title) + '</dc:title><dc:creator>' + esc(author || '') + '</dc:creator></cp:coreProperties>');
    zip['word/_rels/document.xml.rels'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      media.map(function (m) { return '<Relationship Id="' + m.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + m.name + '"/>'; }).join('') + '</Relationships>');
    media.forEach(function (m) { zip['word/media/' + m.name] = [m.bytes, { level: 0 }]; });
    zip['word/styles.xml'] = enc(STYLES);
    zip['word/document.xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + W + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body.join('') + '</w:body></w:document>');
    return fflate.zipSync(zip, { level: 6 });
  };

  // ---------- PDF: the whole book in a hidden frame, then the browser's print dialog (Save as PDF) ----------

  C.print = function (doc, title) {
    var parts = [], css = '';
    var urls = [];
    for (var i = 0; i < doc.spine.length; i++) {
      var sec = doc.section(i);
      urls = urls.concat(sec.urls || []);
      css += '\n' + (sec.css || '');
      parts.push('<section class="oto-section">' + sec.html.replace(/href="oto:[^"]*"/g, 'href="#"') + '</section>');
    }
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + css.replace(/<\/style/gi, '') +
      '\n@page{margin:2cm}body{font-family:Georgia,serif;font-size:12pt;line-height:1.45;max-width:none}img{max-width:100%;height:auto}.oto-section{page-break-before:always}.oto-section:first-of-type{page-break-before:auto}h1,h2,h3{page-break-after:avoid}</style></head><body>' +
      '<h1 style="text-align:center;margin-top:30vh">' + esc(title) + '</h1>' + parts.join('\n') + '</body></html>';
    var frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0';
    document.body.appendChild(frame);
    frame.onload = function () {
      var w = frame.contentWindow;
      var done = function () { setTimeout(function () { try { document.body.removeChild(frame); } catch (e) {} urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); }, 2000); };
      try { w.onafterprint = done; w.focus(); w.print(); } catch (e) { done(); throw e; }
    };
    frame.srcdoc = html;
  };
})();
