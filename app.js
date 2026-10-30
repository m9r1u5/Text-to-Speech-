(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const CAP = window.Capacitor;
const isNative = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
const VERSION = String(window.APP_VERSION || '').indexOf('__') >= 0 ? '0.0.0' : String(window.APP_VERSION);
const REPO = window.APP_REPO;
const RELEASE_PAGE = 'https://github.com/' + REPO + '/releases/latest';
const SITE_URL = 'https://' + REPO.split('/')[0].toLowerCase() + '.github.io/' + REPO.split('/')[1] + '/';
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const PAGE = 80;          // sentences shown per page (keeps huge books fast)
const AHEAD = 4;          // sentences pre-synthesized ahead of playback

const VOICES = {
  f: { label: 'Female - Natural (Amy)', file: 'models/en_US-amy-medium.onnx', cfg: 'models/en_US-amy-medium.onnx.json' },
  m: { label: 'Male - Natural (Ryan)', file: 'models/en_US-ryan-medium.onnx', cfg: 'models/en_US-ryan-medium.onnx.json' }
};

function plugin(name) {
  try {
    if (CAP && CAP.Plugins && CAP.Plugins[name] && (!CAP.isPluginAvailable || CAP.isPluginAvailable(name))) return CAP.Plugins[name];
  } catch (e) {}
  return null;
}

/* ---------- messages ---------- */
function showError(msg) { const e = $('err'); e.textContent = msg + '  (tap to dismiss)'; e.hidden = false; }
$('err').onclick = () => { $('err').hidden = true; };
let toastT = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3000); }
window.addEventListener('error', (e) => { if (e && e.message && !/ResizeObserver/.test(e.message)) showError('Something went wrong: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => {
  const m = e && e.reason && (e.reason.message || String(e.reason));
  if (m && m !== 'stale') showError('Something went wrong: ' + m);
});
function confirmBox(msg, okLabel) {
  return new Promise((resolve) => {
    $('modalMsg').textContent = msg; $('modalYes').textContent = okLabel || 'OK'; $('modal').hidden = false;
    const done = (v) => { $('modal').hidden = true; resolve(v); };
    $('modalYes').onclick = () => done(true);
    $('modalNo').onclick = () => done(false);
  });
}

/* ---------- storage (IndexedDB) ---------- */
let db = null;
function dbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('offlinereader', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function kvGet(k) { return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
function kvSet(k, v) { return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
function kvDel(k) { return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

/* ---------- state ---------- */
let text = '', starts = new Uint32Array([0]), n = 0, cur = 0, page = 0;
let mode = 'idle';            // idle | playing | paused
let loopActive = false, token = 0, finished = false;
let engine = null;            // 'neural' | 'system' | null
let neuralFailed = false, busyMsg = '';
const settings = { voice: 'f', speed: 1.0, keepAwake: false };
let sysVoices = [];

/* ---------- sentence chunking (fast single pass, handles 1M+ chars) ---------- */
function isWs(c) { return c === 32 || c === 10 || c === 13 || c === 9 || c === 160; }
function chunkText(t) {
  const MAX = 260, MIN = 30, L = t.length, out = [0];
  let s = 0;
  while (s < L) {
    let end = -1;
    const limit = Math.min(L, s + MAX);
    for (let i = s; i < limit; i++) {
      const c = t.charCodeAt(i);
      if (c === 10) { end = i + 1; while (end < L && isWs(t.charCodeAt(end))) end++; break; }
      if (c === 46 || c === 33 || c === 63 || c === 8230 || c === 0x3002) {
        let j = i + 1;
        while (j < L) { const d = t.charCodeAt(j); if (d === 34 || d === 39 || d === 41 || d === 93 || d === 0x201D || d === 0x2019 || d === 46 || d === 33 || d === 63) j++; else break; }
        if (j >= L || isWs(t.charCodeAt(j))) { end = j; while (end < L && isWs(t.charCodeAt(end))) end++; break; }
        i = j - 1;
      }
    }
    if (end < 0) {
      if (limit >= L) end = L;
      else {
        let k = limit;
        while (k > s + MIN) { const c = t.charCodeAt(k - 1); if (c === 32 || c === 44 || c === 59 || c === 58 || c === 10) break; k--; }
        end = k > s + MIN ? k : limit;
      }
    }
    out.push(end); s = end;
  }
  return Uint32Array.from(out);
}
function speakable(i) {
  if (i < 0 || i >= n) return null;
  const raw = text.slice(starts[i], starts[i + 1]);
  if (!HAS_ALNUM.test(raw)) return null;
  return raw.replace(/\s+/g, ' ').trim();
}

/* ---------- reader view ---------- */
const viewer = $('viewer');
function pageOf(i) { return Math.floor(i / PAGE); }
function pageCount() { return Math.max(1, Math.ceil(n / PAGE)); }
function renderPage(p) {
  page = Math.max(0, Math.min(pageCount() - 1, p));
  const frag = document.createDocumentFragment();
  const a = page * PAGE, b = Math.min(n, a + PAGE);
  for (let i = a; i < b; i++) {
    const s = document.createElement('span');
    s.className = 's'; s.dataset.i = i; s.textContent = text.slice(starts[i], starts[i + 1]);
    frag.appendChild(s);
  }
  viewer.replaceChildren(frag);
  viewer.scrollTop = 0;
  $('pgInfo').textContent = 'Page ' + (page + 1) + '/' + pageCount();
}
function markCurrent(scroll) {
  const old = viewer.querySelector('.cur'); if (old) old.classList.remove('cur');
  const el = viewer.querySelector('[data-i="' + cur + '"]');
  if (el) { el.classList.add('cur'); if (scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
let sliderDrag = false;
function showCurrent(scroll) {
  if (pageOf(cur) !== page || !viewer.firstChild) renderPage(pageOf(cur));
  markCurrent(scroll);
  if (!sliderDrag) $('posSlider').value = n > 1 ? Math.round(cur / (n - 1) * 1000) : 0;
  $('posPct').textContent = (n > 1 ? Math.round(cur / (n - 1) * 100) : 0) + '%';
  setUI();
}
function setTab(t) {
  $('tabText').classList.toggle('on', t === 'text'); $('tabPdf').classList.toggle('on', t === 'pdf');
  $('tabText').setAttribute('aria-selected', t === 'text'); $('tabPdf').setAttribute('aria-selected', t === 'pdf');
  $('pdfView').hidden = t !== 'pdf';
  if (t === 'pdf') { $('inputView').hidden = true; $('readerView').hidden = true; }
}
function showInput() { setTab('text'); $('inputView').hidden = false; $('readerView').hidden = true; $('btnCancelInput').hidden = !n; }
function showReader() { setTab('text'); $('inputView').hidden = true; $('readerView').hidden = false; }
function engineLabel() {
  if (busyMsg) return busyMsg;
  if (engine === 'neural') return 'Natural voice (offline)';
  if (engine === 'system') return 'Phone system voice';
  return 'Voice: not started';
}
function setUI() {
  $('engine').textContent = engineLabel();
  $('btnPlay').textContent = mode === 'playing' ? '⏸ Pause' : '▶ Play';
  const st = mode === 'playing' ? 'Reading' : mode === 'paused' ? 'Paused' : 'Stopped';
  $('status').textContent = n ? st + ' • sentence ' + (cur + 1) + ' of ' + n : 'No text loaded';
}

/* ---------- persistence ---------- */
async function savePos() { if (db && n) { try { await kvSet('pos', cur); } catch (e) {} } }
async function saveSettings() { if (db) { try { await kvSet('settings', Object.assign({}, settings)); } catch (e) {} } }
setInterval(() => { if (mode === 'playing') savePos(); }, 3000);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
window.addEventListener('pagehide', savePos);

/* ---------- neural engine (worker) ---------- */
let worker = null, workerReady = false, loadedVoice = null, iidCounter = 0, reqId = 0, gen = 0;
const waiters = new Map(), pending = new Map();
let initP = null, initKey = null;
function failAll(msg) {
  waiters.forEach((w) => w.rej(new Error(msg))); waiters.clear();
  pending.forEach((p) => p.rej(new Error(msg))); pending.clear();
}
function onWorkerMsg(e) {
  const m = e.data;
  if (m.type === 'status') { busyMsg = m.msg; setUI(); }
  else if (m.type === 'ready') { workerReady = true; loadedVoice = m.key; const w = waiters.get(m.iid); if (w) { waiters.delete(m.iid); w.res(); } }
  else if (m.type === 'audio') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.res({ samples: m.samples, sr: m.sr }); } }
  else if (m.type === 'skipped') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.rej(new Error('stale')); } }
  else if (m.type === 'error') {
    if (m.iid != null) { const w = waiters.get(m.iid); if (w) { waiters.delete(m.iid); w.rej(new Error(m.msg)); } }
    else { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.rej(new Error(m.msg)); } }
  }
}
function initNeural(key) {
  if (workerReady && loadedVoice === key) return Promise.resolve();
  if (initP && initKey === key) return initP;
  if (!worker) {
    worker = new Worker('tts-worker.js');
    worker.onmessage = onWorkerMsg;
    worker.onerror = (e) => { failAll('Voice engine crashed: ' + (e.message || 'unknown error')); worker = null; workerReady = false; loadedVoice = null; };
  }
  workerReady = false; initKey = key;
  const v = VOICES[key], iid = ++iidCounter;
  busyMsg = 'Preparing voice…'; setUI();
  const p = new Promise((res, rej) => {
    waiters.set(iid, { res, rej });
    worker.postMessage({ type: 'init', iid, key, file: v.file, cfg: v.cfg });
  });
  initP = p;
  p.then(() => { busyMsg = ''; setUI(); }, () => { busyMsg = ''; setUI(); }).then(() => { if (initP === p) initP = null; });
  return p;
}
function synth(t) {
  return new Promise((res, rej) => {
    if (!worker) { rej(new Error('Voice engine is not running.')); return; }
    const id = ++reqId; pending.set(id, { res, rej });
    worker.postMessage({ type: 'synth', id, gen, text: t, speed: settings.speed });
  });
}
const buf = new Map();
function getAudio(i) {
  let p = buf.get(i);
  if (!p) { const s = speakable(i); p = s ? synth(s) : Promise.resolve(null); buf.set(i, p); }
  return p;
}
function prefetch(from) {
  for (let k = 0; k < AHEAD; k++) { const i = from + k; if (i >= n) break; getAudio(i).catch(() => {}); }
  for (const key of Array.from(buf.keys())) if (key < cur - 1) buf.delete(key);
}
function invalidateBuffers() { gen++; buf.clear(); if (worker) worker.postMessage({ type: 'gen', gen }); }

/* ---------- audio output ---------- */
let ctx = null, dest = null, curSrc = null, curResolve = null;
function silentWavUrl() {
  const n = 8000, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (isIOS) { dest = null; return; }   // iPhone: play straight to the speaker, with a silent looping clip (below) so the silent switch does not mute us
  try { dest = ctx.createMediaStreamDestination(); $('sink').srcObject = dest.stream; } catch (e) { dest = null; }
}
// Must be called straight from a tap (no await before it) or iPhone blocks the sound.
function startSink() {
  ensureAudio();
  const jobs = [];
  try { jobs.push(ctx.state !== 'running' ? ctx.resume() : Promise.resolve()); } catch (e) {}
  const a = $('sink');
  try {
    if (isIOS) { if (!a.src) { a.src = silentWavUrl(); a.loop = true; } }
    jobs.push(Promise.race([a.play(), new Promise((r, j) => setTimeout(() => j(new Error('audio start timed out')), 2500))]).catch(() => {
      if (dest) { dest = null; a.srcObject = null; }
    }));
  } catch (e) { if (dest) { dest = null; a.srcObject = null; } }
  return Promise.all(jobs.map((p) => p.catch(() => {})));
}
// iPhone only lets speech start from a tap: prime it right inside the tap handler.
function primeSpeech() {
  try { if (!isNative && window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } } catch (e) {}
}
function playSamples(a) {
  return new Promise((resolve) => {
    if (!a || !a.samples || !a.samples.length) { resolve(); return; }
    const ab = ctx.createBuffer(1, a.samples.length, a.sr);
    ab.copyToChannel(a.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab; src.connect(dest || ctx.destination);
    curSrc = src; curResolve = resolve;
    src.onended = () => { if (curSrc === src) { curSrc = null; curResolve = null; } resolve(); };
    src.start();
  });
}
function stopCurrent() {
  if (curSrc) { try { curSrc.onended = null; curSrc.stop(); } catch (e) {} curSrc = null; }
  if (curResolve) { const r = curResolve; curResolve = null; r(); }
}

/* ---------- system voice fallback ---------- */
function sysVoiceIndex() {
  if (settings.voice.indexOf('s:') === 0) { const uri = settings.voice.slice(2); const v = sysVoices.find((x) => x.voiceURI === uri); return v ? v.index : null; }
  return sysVoices.length ? sysVoices[0].index : null; // list is sorted: natural/network/enhanced first
}
async function speakSystem(s) {
  const T = plugin('TextToSpeech');
  if (T) {
    const o = { text: s, lang: 'en-US', rate: settings.speed, pitch: 1.0, volume: 1.0, category: 'playback', queueStrategy: 1 };
    const vi = sysVoiceIndex(); if (vi != null) o.voice = vi;
    await T.speak(o);
  } else if (window.speechSynthesis) {
    await new Promise((res, rej) => {
      const u = new SpeechSynthesisUtterance(s); u.rate = settings.speed; u.lang = 'en-US';
      const sv = sysVoices.find((x) => x.obj && (settings.voice.indexOf('s:') === 0 ? x.voiceURI === settings.voice.slice(2) : true));
      if (sv) { u.voice = sv.obj; u.lang = sv.lang || 'en-US'; }
      let started = false;
      const wd = setTimeout(() => { if (!started) { try { window.speechSynthesis.cancel(); } catch (e) {} rej(new Error('The phone did not start speaking. Check the volume and that the silent switch is off, then tap Play again.')); } }, 6000);
      u.onstart = () => { started = true; clearTimeout(wd); };
      u.onend = () => { clearTimeout(wd); res(); };
      u.onerror = (ev) => { clearTimeout(wd); (ev.error === 'canceled' || ev.error === 'interrupted') ? res() : rej(new Error('System voice error: ' + ev.error)); };
      try { window.speechSynthesis.resume(); } catch (e) {}
      window.speechSynthesis.speak(u);
    });
  } else { throw new Error('No voice engine is available on this phone.'); }
}
function stopSystem() {
  try { const T = plugin('TextToSpeech'); if (T) T.stop(); } catch (e) {}
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
}
async function loadSystemVoices() {
  const T = plugin('TextToSpeech');
  if (T) {
    try {
      const r = await T.getSupportedVoices();
      sysVoices = (r.voices || []).map((v, i) => ({ voiceURI: v.voiceURI || v.name, name: v.name || ('Voice ' + i), lang: v.lang || '', index: i,
        pref: /natural|network|enhanced|neural|wavenet/i.test((v.name || '') + (v.voiceURI || '')) ? 0 : 1 }))
        .filter((v) => /^en/i.test(v.lang))
        .sort((a, b) => (a.pref - b.pref) || a.name.localeCompare(b.name));
    } catch (e) { sysVoices = []; }
  } else if (window.speechSynthesis) {
    const grab = () => {
      const list = (window.speechSynthesis.getVoices() || []).filter((v) => /^en/i.test(v.lang));
      sysVoices = list.map((v, i) => ({ voiceURI: v.voiceURI || v.name, name: v.name, lang: v.lang, index: i, obj: v,
        pref: /natural|network|enhanced|premium|neural/i.test(v.name + (v.voiceURI || '')) ? 0 : 1 }))
        .sort((a, b) => (a.pref - b.pref) || a.name.localeCompare(b.name));
    };
    grab();
    if (!sysVoices.length) { try { window.speechSynthesis.addEventListener('voiceschanged', () => { grab(); buildVoiceSelect(); }); } catch (e) {} }
  }
  buildVoiceSelect();
}
function buildVoiceSelect() {
  const sel = $('voice'); sel.innerHTML = '';
  Object.keys(VOICES).forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = VOICES[k].label; sel.appendChild(o); });
  if (sysVoices.length) {
    const g = document.createElement('optgroup'); g.label = isNative ? 'Android system voices (fallback)' : 'Phone system voices (fallback)';
    sysVoices.forEach((v) => { const o = document.createElement('option'); o.value = 's:' + v.voiceURI; o.textContent = 'System - ' + v.name + ' (' + v.lang + ')'; g.appendChild(o); });
    sel.appendChild(g);
  }
  sel.value = settings.voice;
  if (sel.value !== settings.voice) { settings.voice = 'f'; sel.value = 'f'; }
}

/* ---------- locks and media session ---------- */
let wl = null;
async function acquireLocks() {
  try { if (settings.keepAwake && 'wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) {}
  const FG = plugin('ForegroundService');
  if (FG) {
    try { try { await FG.requestPermissions(); } catch (e) {}
      await FG.startForegroundService({ id: 4711, title: 'Offline Reader', body: 'Reading aloud…', smallIcon: 'ic_stat_reader', silent: true }); } catch (e) {}
  }
}
async function releaseLocks() {
  try { if (wl) { await wl.release(); wl = null; } } catch (e) {}
  const FG = plugin('ForegroundService');
  if (FG) { try { await FG.stopForegroundService(); } catch (e) {} }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'playing' && settings.keepAwake) acquireLocks(); });
function updateMedia() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Offline Reader', artist: 'Sentence ' + (cur + 1) + ' of ' + n,
      album: settings.voice.indexOf('s:') === 0 ? 'System voice' : VOICES[settings.voice].label, artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] });
    navigator.mediaSession.playbackState = mode === 'playing' ? 'playing' : mode === 'paused' ? 'paused' : 'none';
  } catch (e) {}
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
  set('play', () => { play(); }); set('pause', () => { pause(); }); set('stop', () => { stop(); });
  set('previoustrack', () => { step(-1); }); set('nexttrack', () => { step(1); });
}

/* ---------- playback engine ---------- */
async function ensureEngine() {
  if (settings.voice.indexOf('s:') === 0) { engine = 'system'; setUI(); return; }
  if (neuralFailed) { engine = 'system'; setUI(); return; }
  try { await initNeural(settings.voice); engine = 'neural'; }
  catch (e) {
    neuralFailed = true; engine = 'system';
    showError('The natural voice could not start (' + e.message + '). Using the phone\'s own voice instead.');
  }
  setUI();
}
function cancelLoop() { token++; loopActive = false; stopCurrent(); stopSystem(); }
let startSinkP = Promise.resolve();
function startLoop() {
  primeSpeech(); startSinkP = startSink();
  const my = ++token; mode = 'playing'; loopActive = true; finished = false; setUI(); acquireLocks();
  runLoop(my).catch((e) => {
    if (my !== token) return;
    showError('Reading stopped: ' + (e && e.message ? e.message : e));
    loopActive = false; mode = 'idle'; releaseLocks(); setUI(); updateMedia();
  });
}
async function runLoop(my) {
  await startSinkP;
  if (my !== token) return;
  await ensureEngine();
  while (my === token && cur < n) {
    const s = speakable(cur);
    if (s === null) { cur++; continue; }
    showCurrent(true); updateMedia();
    if (engine === 'neural') {
      const pa = getAudio(cur); prefetch(cur + 1);
      let a;
      try { a = await pa; }
      catch (e) {
        if (my !== token) return;
        neuralFailed = true; engine = 'system'; invalidateBuffers();
        showError('The natural voice stopped working (' + e.message + '). Switched to the phone\'s own voice.');
        continue;
      }
      if (my !== token) return;
      await playSamples(a);
    } else {
      try { await speakSystem(s); }
      catch (e) { if (my !== token) return; throw e; }
    }
    if (my !== token) return;
    cur++;
    if ((cur & 7) === 0) savePos();
  }
  if (my === token) {
    loopActive = false; mode = 'idle'; finished = true; cur = Math.max(0, n - 1);
    savePos(); releaseLocks(); showCurrent(false); updateMedia(); toast('Finished reading.');
  }
}
function play() {
  if (!n) { toast('Paste some text first.'); return; }
  if (mode === 'paused' && loopActive && engine === 'neural' && ctx) { resumePlayback(); return; }
  if (finished) { cur = 0; finished = false; }
  cancelLoop(); startLoop();
}
async function resumePlayback() {
  mode = 'playing'; setUI(); acquireLocks();
  try { await ctx.resume(); if (dest) { try { await $('sink').play(); } catch (e) {} } } catch (e) { showError('Could not resume audio: ' + e.message); }
  updateMedia();
}
async function pause() {
  if (mode !== 'playing') return;
  mode = 'paused'; savePos();
  if (engine === 'neural' && ctx) { try { await ctx.suspend(); $('sink').pause(); } catch (e) {} }
  else { cancelLoop(); }
  releaseLocks(); setUI(); updateMedia();
}
function stop() {
  cancelLoop(); mode = 'idle'; savePos(); releaseLocks(); setUI(); updateMedia();
}
function jumpTo(i) {
  if (!n) return;
  const was = mode;
  cancelLoop();
  cur = Math.max(0, Math.min(n - 1, i)); finished = false;
  showCurrent(true); savePos(); updateMedia();
  if (was === 'playing') startLoop();
}
function step(d) { jumpTo(cur + d); }
function applyChange() {
  invalidateBuffers();
  if (mode === 'playing') { cancelLoop(); startLoop(); }
  else if (mode === 'paused') { cancelLoop(); }
}

/* ---------- text loading / clearing ---------- */
async function loadText() {
  const t = $('paste').value;
  if (!t || !HAS_ALNUM.test(t)) { showError('Please paste some text first.'); return; }
  if (n && !(await confirmBox('Replace the current text and position with this new text?', 'Replace'))) return;
  $('btnLoad').disabled = true; toast('Preparing text…');
  await new Promise((r) => setTimeout(r, 50));
  await applyNewText(t);
  $('paste').value = '';
  $('btnLoad').disabled = false;
}
// Replaces the loaded text (from the paste box or a PDF), saves it and shows the reader.
async function applyNewText(t) {
  cancelLoop(); mode = 'idle'; releaseLocks(); invalidateBuffers();
  text = t; starts = chunkText(t); n = starts.length - 1; cur = 0; page = 0; finished = false; viewer.replaceChildren();
  try { await kvSet('text', text); await kvSet('pos', 0); }
  catch (e) { showError('Could not save the text on this phone (storage may be full): ' + e.message); }
  showReader(); showCurrent(false); updateMedia();
}

/* ---------- PDF tab: pull the text out of a PDF on the phone (pdf.js is bundled, no internet needed) ---------- */
let pdfjsP = null, pdfBusy = false, pdfCancelled = false, pdfTask = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsP) return pdfjsP;
  pdfjsP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'lib/pdf.min.js';
    s.onload = () => {
      if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; res(window.pdfjsLib); }
      else { pdfjsP = null; rej(new Error('The PDF reader did not start.')); }
    };
    s.onerror = () => { pdfjsP = null; rej(new Error('The PDF reader files are not on this phone yet. On the web version, go to Tools, tap "Save voices for offline use" while online, then try again.')); };
    document.head.appendChild(s);
  });
  return pdfjsP;
}
// Turns one page's text pieces into clean reading text: joins wrapped lines, keeps paragraph breaks.
function pageToText(items) {
  const lines = []; let line = '', ly = 0;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform ? it.transform[5] : 0;
    if (line && Math.abs(y - ly) > 3) { lines.push({ t: line, y: ly }); line = ''; }
    if (!line) ly = y;
    line += it.str;
    if (it.hasEOL) { lines.push({ t: line, y: ly }); line = ''; }
  }
  if (line) lines.push({ t: line, y: ly });
  const L = lines.map((l) => ({ t: l.t.replace(/\s+/g, ' ').trim(), y: l.y })).filter((l) => l.t);
  if (!L.length) return '';
  const gaps = [];
  for (let i = 1; i < L.length; i++) { const g = Math.abs(L[i - 1].y - L[i].y); if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  let out = L[0].t;
  for (let i = 1; i < L.length; i++) {
    const gap = Math.abs(L[i - 1].y - L[i].y), cur2 = L[i].t;
    if (med > 0 && gap > med * 1.6) out += '\n\n' + cur2;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(cur2)) out = out.slice(0, -1) + cur2;   // word split across two lines
    else out += ' ' + cur2;
  }
  return out;
}
function cleanPdfText(s) {
  return s.replace(/­/g, '').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ');
}
function pdfProgress(p, msg) { $('pdfBar').style.width = Math.round(p * 100) + '%'; $('pdfProgTxt').textContent = msg; }
async function readPdfFile(file) {
  if (pdfBusy) return;
  if (!file) return;
  if (n && !(await confirmBox('Replace the current text and position with the text from this PDF?', 'Replace'))) return;
  pdfBusy = true; pdfCancelled = false;
  $('btnPickPdf').disabled = true; $('pdfProg').hidden = false; $('pdfName').textContent = file.name;
  pdfProgress(0, 'Opening PDF…');
  try {
    const lib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    pdfTask = lib.getDocument({ data, isEvalSupported: false });
    const doc = await pdfTask.promise;
    const total = doc.numPages, parts = [];
    for (let p = 1; p <= total; p++) {
      if (pdfCancelled) throw new Error('cancelled');
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const t = pageToText(tc.items);
      pg.cleanup();
      if (t) {
        // a sentence that runs over the page break keeps flowing; otherwise start a new paragraph
        const prev = parts.length ? parts[parts.length - 1] : '';
        parts.push(prev && !/[.!?:"'”’)\]]\s*$/.test(prev) ? ' ' : (prev ? '\n\n' : ''));
        parts.push(t);
      }
      if (p % 3 === 0 || p === total) pdfProgress(p / total, 'Reading page ' + p + ' of ' + total + '…');
      if (p % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    try { await doc.destroy(); } catch (e) {}
    const full = cleanPdfText(parts.join('')).trim();
    if (!full || !HAS_ALNUM.test(full)) { showError('No readable text was found in "' + file.name + '". It is probably a scanned PDF (pictures of pages), which cannot be read aloud without text recognition.'); }
    else {
      pdfProgress(1, 'Preparing text…');
      await new Promise((r) => setTimeout(r, 50));
      await applyNewText(full);
      toast('PDF loaded: ' + total + ' page' + (total === 1 ? '' : 's') + '. Press Play.');
    }
  } catch (e) {
    const m = e && (e.message || String(e));
    if (m === 'cancelled' || (e && e.name === 'AbortException')) toast('PDF reading cancelled.');
    else if (e && e.name === 'PasswordException') showError('This PDF is password protected. Remove the password and try again.');
    else if (e && e.name === 'InvalidPDFException') showError('This file is not a valid PDF, or it is damaged.');
    else showError('Could not read the PDF: ' + m);
  }
  pdfTask = null; pdfBusy = false; $('btnPickPdf').disabled = false; $('pdfProg').hidden = true; $('pdfFile').value = '';
}
async function clearText() {
  if (!(await confirmBox('Delete the saved text and your reading position? This cannot be undone.', 'Delete'))) return;
  cancelLoop(); mode = 'idle'; releaseLocks(); invalidateBuffers();
  text = ''; starts = new Uint32Array([0]); n = 0; cur = 0; page = 0; finished = false; viewer.replaceChildren();
  try { await kvDel('text'); await kvDel('pos'); } catch (e) {}
  showInput(); setUI(); updateMedia();
}

/* ---------- update / install / share ---------- */
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
function openUrl(url) {
  const B = plugin('Browser');
  if (B) B.open({ url }); else window.open(url, '_blank');
}
let updateUrl = RELEASE_PAGE, updateAction = null;
async function checkUpdates() {
  const msg = $('updMsg'); $('btnGetUpdate').hidden = true; updateAction = null;
  msg.textContent = 'Checking…';
  try {
    if (!isNative) { await checkWebUpdate(msg); return; }
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) { msg.textContent = 'No release found on GitHub yet.'; return; }
    if (!r.ok) throw new Error('GitHub answered with status ' + r.status);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const apk = (j.assets || []).find((a) => /\.apk$/i.test(a.name));
    updateUrl = apk ? apk.browser_download_url : j.html_url;
    if (cmpVer(latest, VERSION) > 0) {
      msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. A new version is available.';
      $('btnGetUpdate').textContent = 'Download update'; $('btnGetUpdate').hidden = false;
    } else { msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. You are up to date.'; }
  } catch (e) {
    msg.textContent = 'Could not check for updates. Connect to the internet and try again. (' + e.message + ')';
  }
}
// Web / iPhone version: compare with version.json on the site, then refresh the cached files.
async function checkWebUpdate(msg) {
  const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('version file answered with status ' + r.status);
  const j = await r.json();
  const latest = String(j.version || '');
  try { if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } } catch (e) {}
  if (cmpVer(latest, VERSION) > 0) {
    msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. A new version is ready.';
    $('btnGetUpdate').textContent = 'Reload to update'; $('btnGetUpdate').hidden = false;
    updateAction = async () => {
      if (mode === 'playing') { toast('Pause reading first, then tap again.'); return; }
      savePos();
      try { const reg = await navigator.serviceWorker.getRegistration(); if (reg && reg.waiting) reg.waiting.postMessage('skipWaiting'); } catch (e) {}
      try { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k.indexOf('offline-reader-shell-') === 0).map((k) => caches.delete(k))); } catch (e) {}
      location.reload();
    };
  } else { msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. You are up to date.'; }
}
async function shareApp() {
  const text = 'Offline Reader: a free text-to-speech reader with natural voices that works offline. iPhone: open the link in Safari, tap Share, then Add to Home Screen. Android: open the link and follow the install steps. ';
  const link = isNative ? SITE_URL : (location.origin + location.pathname.replace(/[^\/]*$/, ''));
  try {
    const S = plugin('Share');
    if (S) { await S.share({ title: 'Offline Reader', text, url: link, dialogTitle: 'Share Offline Reader' }); return; }
    if (navigator.share) { await navigator.share({ title: 'Offline Reader', text, url: link }); return; }
    await navigator.clipboard.writeText(link); toast('Link copied. Send it to anyone.');
  } catch (e) { if (e && /cancel|abort/i.test(e.name + e.message)) return; toast('Could not open sharing. Link: ' + link); }
}

/* ---------- install (auto-detects iPhone / Android / computer) ---------- */
const UA = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(UA);
const iosSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(UA);
const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; renderInstall(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('installCard').hidden = true; toast('Installed. Open it from your home screen.'); });
function renderInstall(force) {
  const card = $('installCard');
  let hidden = false; try { hidden = localStorage.getItem('hideInstall') === '1'; } catch (e) {}
  if (isNative || standalone || (hidden && !force)) { card.hidden = true; return; }
  const st = $('installSteps'); let html = '', title = 'Install Offline Reader';
  $('btnInstallNow').hidden = true; $('btnApk').hidden = true;
  if (isIOS && iosSafari) {
    title = 'Install on your iPhone';
    html = '<ol><li>Tap the <b>Share</b> button (square with an arrow) at the bottom of Safari. On iPad it is at the top.</li>' +
      '<li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li>' +
      '<li>Open <b>Offline Reader</b> from your Home Screen, wait for "Natural voice (offline)", then tap <b>Save voices for offline use</b> once while on Wi-Fi.</li></ol>';
  } else if (isIOS) {
    title = 'Install on your iPhone';
    html = '<p>This page is open in a browser other than Safari. Easiest: copy the link, open <b>Safari</b>, paste it, then:</p>' +
      '<ol><li>Tap <b>Share</b>, then <b>Add to Home Screen</b>, then <b>Add</b>.</li>' +
      '<li>Open <b>Offline Reader</b> from your Home Screen and tap <b>Save voices for offline use</b> once on Wi-Fi.</li></ol>' +
      '<p>(Newer iPhones also show Add to Home Screen in this browser\'s Share menu.)</p>';
  } else if (isAndroid) {
    title = 'Install on your Android phone';
    if (deferredInstall) { $('btnInstallNow').hidden = false; html = '<p>Tap <b>Install now</b>. The app appears on your home screen and works offline.</p>'; }
    else html = '<ol><li>Open this page in <b>Chrome</b>.</li><li>Tap the <b>⋮</b> menu, then <b>Install app</b> (or <b>Add to Home screen</b>).</li><li>Tap <b>Install</b>.</li></ol>';
    html += '<p>Prefer a normal app file? Use the APK download below.</p>';
    $('btnApk').hidden = false;
  } else {
    title = 'Install on this computer';
    if (deferredInstall) { $('btnInstallNow').hidden = false; html = '<p>Tap <b>Install now</b>.</p>'; }
    else html = '<p>In Chrome or Edge, click the install icon at the right end of the address bar.</p>';
    $('btnApk').hidden = false;
  }
  $('installTitle').textContent = title; st.innerHTML = html; card.hidden = false;
}
function installApp() {
  if (isNative) { toast('Offline Reader is already installed on this phone.'); return; }
  if (standalone) { toast('Offline Reader is already installed.'); return; }
  if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; renderInstall(true); return; }
  renderInstall(true); $('installCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- offline voices for the web version ---------- */
async function offlineStatus() {
  if (isNative) { $('btnOfflineVoices').hidden = true; $('offMsg').textContent = ''; return; }
  const msg = $('offMsg');
  try {
    const c = await caches.open('offline-reader-assets-v1');
    const keys = (await c.keys()).map((r) => r.url);
    const have = Object.keys(VOICES).filter((k) => keys.some((u) => u.indexOf(VOICES[k].file) >= 0));
    const pdfSaved = keys.some((u) => u.indexOf('lib/pdf.min.js') >= 0) && keys.some((u) => u.indexOf('lib/pdf.worker.min.js') >= 0);
    msg.textContent = have.length === Object.keys(VOICES).length && !pdfSaved ? 'The PDF reader is not saved yet. Tap the button while online (small download, voices are not downloaded again).' :
      have.length === Object.keys(VOICES).length ? 'Both natural voices and the PDF reader are saved on this phone. Works offline.' :
      have.length ? 'Only one natural voice is saved. Tap the button to save the other one (needs internet).' : 'Voices are not saved yet. Tap the button while on Wi-Fi (about 130 MB).';
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  } catch (e) { msg.textContent = 'Offline storage is not available in this browser.'; }
}
async function saveVoices() {
  if (mode === 'playing') { toast('Pause reading first.'); return; }
  if (!navigator.onLine) { showError('You are offline. Connect to Wi-Fi to save the voices.'); return; }
  if (!('serviceWorker' in navigator) || !('caches' in window)) { showError('This browser cannot save files for offline use.'); return; }
  try { await navigator.serviceWorker.ready; } catch (e) {}
  if (!navigator.serviceWorker.controller) { showError('Almost ready. Close the app, open it again, then tap this button once more.'); return; }
  const msg = $('offMsg'), btn = $('btnOfflineVoices'); btn.disabled = true;
  try {
    const r = await fetch('files.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('file list not found on the site');
    const list = await r.json();
    let done = 0;
    const c = await caches.open('offline-reader-assets-v1');
    for (const f of list.files) {
      msg.textContent = 'Saving voices for offline use… ' + Math.round(done / list.files.length * 100) + '%  Keep this screen open.';
      const url = new URL(f, location.href).href;
      if (!(await c.match(url))) {   // skip files that are already saved
        const res = await fetch(f);
        if (!res.ok) throw new Error(f + ' answered with status ' + res.status);
        await c.put(url, res);
      }
      done++;
    }
    toast('Voices saved. Works offline now.');
  } catch (e) { showError('Could not save the voices: ' + e.message); }
  btn.disabled = false; offlineStatus();
}

/* ---------- wiring ---------- */
function wire() {
  $('verTxt').textContent = 'v' + VERSION;
  $('btnPlay').onclick = () => { if (mode === 'playing') pause(); else play(); };
  $('btnStop').onclick = stop;
  $('btnPrev').onclick = () => step(-1);
  $('btnNext').onclick = () => step(1);
  $('btnLoad').onclick = loadText;
  $('tabText').onclick = () => { if (n) { showReader(); showCurrent(false); } else showInput(); };
  $('tabPdf').onclick = () => setTab('pdf');
  $('btnPickPdf').onclick = () => { if (!pdfBusy) $('pdfFile').click(); };
  $('pdfFile').onchange = () => { const f = $('pdfFile').files && $('pdfFile').files[0]; if (f) readPdfFile(f); };
  $('btnPdfCancel').onclick = () => { pdfCancelled = true; try { if (pdfTask) pdfTask.destroy(); } catch (e) {} };
  $('btnCancelInput').onclick = () => { showReader(); showCurrent(false); };
  $('btnClipboard').onclick = async () => {
    try { $('paste').value = await navigator.clipboard.readText(); } catch (e) { toast('Clipboard blocked. Long-press the box and choose Paste.'); }
  };
  $('btnClear').onclick = clearText;
  $('btnRestart').onclick = async () => { if (n && await confirmBox('Go back to the very beginning?', 'Restart')) jumpTo(0); };
  $('btnShare').onclick = shareApp;
  $('btnInstall').onclick = installApp;
  $('btnUpdate').onclick = checkUpdates;
  $('btnGetUpdate').onclick = () => { if (updateAction) updateAction(); else openUrl(updateUrl); };
  $('btnInstallNow').onclick = installApp;
  $('btnApk').onclick = () => openUrl(RELEASE_PAGE);
  $('btnHideInstall').onclick = () => { try { localStorage.setItem('hideInstall', '1'); } catch (e) {} $('installCard').hidden = true; };
  $('btnOfflineVoices').onclick = saveVoices;
  $('pgPrev').onclick = () => { renderPage(page - 1); markCurrent(false); };
  $('pgNext').onclick = () => { renderPage(page + 1); markCurrent(false); };
  $('pgInfo').onclick = () => showCurrent(true);
  viewer.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('.s') : null;
    if (!t) return;
    const wasIdle = mode !== 'playing';
    jumpTo(parseInt(t.dataset.i, 10));
    if (wasIdle) toast('Position set. Press Play to start from here.');
  });
  const sl = $('posSlider');
  sl.addEventListener('input', () => { sliderDrag = true; $('posPct').textContent = Math.round(sl.value / 10) + '%'; });
  sl.addEventListener('change', () => { sliderDrag = false; jumpTo(Math.round(sl.value / 1000 * (n - 1))); });
  $('voice').onchange = () => {
    settings.voice = $('voice').value; saveSettings();
    if (settings.voice.indexOf('s:') !== 0) neuralFailed = false;
    if (settings.voice.indexOf('s:') !== 0) initNeural(settings.voice).then(() => { engine = 'neural'; setUI(); }).catch(() => {});
    if (settings.voice.indexOf('s:') === 0) engine = 'system';
    applyChange();
  };
  let speedT = null;
  $('speed').oninput = () => {
    settings.speed = Math.round(parseFloat($('speed').value) * 10) / 10;
    $('speedVal').textContent = settings.speed.toFixed(1) + '×';
    clearTimeout(speedT); speedT = setTimeout(() => { saveSettings(); applyChange(); }, 400);
  };
  $('keepAwake').onchange = () => { settings.keepAwake = $('keepAwake').checked; saveSettings(); if (mode === 'playing') { if (settings.keepAwake) acquireLocks(); else if (wl) { wl.release().catch(() => {}); wl = null; } } };
  const A = plugin('App');
  if (A) { try { A.addListener('pause', savePos); A.addListener('appStateChange', (s) => { if (!s.isActive) savePos(); }); } catch (e) {} }
  setupMediaSession();
}

async function init() {
  wire();
  try { db = await dbOpen(); } catch (e) { showError('Could not open storage on this phone: ' + e.message + '. Your text will not be saved.'); }
  if (db) {
    try {
      const s = await kvGet('settings'); if (s) Object.assign(settings, s);
      const t = await kvGet('text');
      if (typeof t === 'string' && t.length) {
        text = t; starts = chunkText(t); n = starts.length - 1;
        const p = await kvGet('pos'); cur = Math.max(0, Math.min(n - 1, Number(p) || 0));
      }
    } catch (e) { showError('Could not read saved text: ' + e.message); }
  }
  $('speed').value = settings.speed; $('speedVal').textContent = Number(settings.speed).toFixed(1) + '×';
  $('keepAwake').checked = !!settings.keepAwake;
  buildVoiceSelect();
  if (n) { showReader(); showCurrent(false); } else { showInput(); setUI(); }
  loadSystemVoices();
  renderInstall(); offlineStatus();
  if (!isNative && 'serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch((e) => { $('offMsg').textContent = 'Offline mode could not start: ' + e.message; }); }
  if (settings.voice.indexOf('s:') !== 0) {
    initNeural(settings.voice).then(() => { engine = 'neural'; setUI(); })
      .catch((e) => { neuralFailed = true; engine = 'system'; setUI(); showError('The natural voice could not start (' + e.message + '). The app will use the phone\'s own voice.'); });
  } else { engine = 'system'; setUI(); }
}
init();
})();
