/* tts.js — reads the open book aloud with the browser's own voices. */
(function () {
  'use strict';
  var T = window.Tts = {};
  var synth = window.speechSynthesis;
  var queue = [], at = 0, playing = false, rate = 1, voiceName = '', onElement = null, onEnd = null;

  T.available = function () { return !!synth; };
  T.voices = function () { return synth ? synth.getVoices() : []; };
  T.setRate = function (r) { rate = Math.max(0.5, Math.min(5, +r || 1)); };
  T.setVoice = function (n) { voiceName = n || ''; };
  T.playing = function () { return playing; };

  /** A sensible default: an English voice, female by name where the browser says so. */
  T.defaultVoice = function () {
    var v = T.voices();
    var score = function (x) {
      var s = 0;
      if (/^en/i.test(x.lang)) s += 4;
      if (/female|woman|zira|samantha|karen|moira|tessa|victoria|fiona|susan|aria|jenny|libby|sonia|natasha|emma/i.test(x.name)) s += 3;
      if (/google/i.test(x.name)) s += 2;
      if (/natural|neural|online/i.test(x.name)) s += 1;
      if (/male\b|david|mark|george|ryan|guy/i.test(x.name) && !/female/i.test(x.name)) s -= 3;
      return s;
    };
    var best = null, bs = -99;
    v.forEach(function (x) { var s = score(x); if (s > bs) { bs = s; best = x; } });
    return best ? best.name : '';
  };

  /** items: [{text, id}] in reading order. onElement(id) fires when a new element starts. */
  T.play = function (items, startIndex, elementCb, endCb) {
    T.stop();
    queue = items; at = startIndex || 0; onElement = elementCb; onEnd = endCb; playing = true;
    speakNext();
  };
  T.pause = function () { if (synth && playing) { playing = false; synth.cancel(); } };
  T.resume = function () { if (!playing && queue.length) { playing = true; speakNext(); } };
  T.stop = function () { playing = false; queue = []; at = 0; if (synth) synth.cancel(); };

  function speakNext() {
    if (!playing) return;
    if (at >= queue.length) { playing = false; if (onEnd) onEnd(); return; }
    var item = queue[at];
    if (onElement) onElement(item.id, item.text); // every sentence, so the page can mark it
    var u = new SpeechSynthesisUtterance(item.text);
    u.rate = rate;
    var v = T.voices().filter(function (x) { return x.name === voiceName; })[0];
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = function () { at++; speakNext(); };
    u.onerror = function (e) { if (e.error === 'interrupted' || e.error === 'canceled') return; at++; speakNext(); };
    synth.speak(u);
  }

  /** Splits long text into sentence-sized pieces the engine handles well. */
  T.split = function (text) {
    var out = [], parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?;:…])\s+(?=[^a-z])/);
    parts.forEach(function (p) {
      while (p.length > 280) { var cut = p.lastIndexOf(' ', 280); if (cut < 100) cut = 280; out.push(p.substring(0, cut)); p = p.substring(cut).trim(); }
      if (p) out.push(p);
    });
    return out;
  };
})();
