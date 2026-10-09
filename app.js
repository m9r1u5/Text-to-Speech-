(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const CAP = window.Capacitor;
const isNative = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
const VERSION = String(window.APP_VERSION || '').indexOf('__') >= 0 ? '0.0.0' : String(window.APP_VERSION);
const REPO = window.APP_REPO;
const RELEASE_PAGE = 'https://github.com/' + REPO + '/releases/latest';
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
function showInput() { $('inputView').hidden = false; $('readerView').hidden = true; $('btnCancelInput').hidden = !n; }
function showReader() { $('inputView').hidden = true; $('readerView').hidden = false; }
function engineLabel() {
  if (busyMsg) return busyMsg;
  if (engine === 'neural') return 'Natural voice (offline)';
  if (engine === 'system') return 'Android system voice';
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
function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  try { dest = ctx.createMediaStreamDestination(); $('sink').srcObject = dest.stream; } catch (e) { dest = null; }
}
async function startSink() {
  ensureAudio();
  if (ctx.state !== 'running') await ctx.resume();
  if (dest) { try { await $('sink').play(); } catch (e) { dest = null; $('sink').srcObject = null; } }
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
      u.onend = res; u.onerror = (ev) => (ev.error === 'canceled' || ev.error === 'interrupted') ? res() : rej(new Error('System voice error: ' + ev.error));
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
  }
  buildVoiceSelect();
}
function buildVoiceSelect() {
  const sel = $('voice'); sel.innerHTML = '';
  Object.keys(VOICES).forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = VOICES[k].label; sel.appendChild(o); });
  if (sysVoices.length) {
    const g = document.createElement('optgroup'); g.label = 'Android system voices (fallback)';
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
    showError('The natural voice could not start (' + e.message + '). Using the Android system voice instead.');
  }
  setUI();
}
function cancelLoop() { token++; loopActive = false; stopCurrent(); stopSystem(); }
function startLoop() {
  const my = ++token; mode = 'playing'; loopActive = true; finished = false; setUI(); acquireLocks();
  runLoop(my).catch((e) => {
    if (my !== token) return;
    showError('Reading stopped: ' + (e && e.message ? e.message : e));
    loopActive = false; mode = 'idle'; releaseLocks(); setUI(); updateMedia();
  });
}
async function runLoop(my) {
  await startSink();
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
        showError('The natural voice stopped working (' + e.message + '). Switched to the Android system voice.');
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
  cancelLoop(); mode = 'idle'; invalidateBuffers();
  text = t; starts = chunkText(t); n = starts.length - 1; cur = 0; page = 0; finished = false; viewer.replaceChildren();
  try { await kvSet('text', text); await kvSet('pos', 0); }
  catch (e) { showError('Could not save the text on this phone (storage may be full): ' + e.message); }
  $('paste').value = '';
  $('btnLoad').disabled = false;
  showReader(); showCurrent(false);
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
let updateUrl = RELEASE_PAGE;
async function checkUpdates() {
  const msg = $('updMsg'); $('btnGetUpdate').hidden = true;
  msg.textContent = 'Checking…';
  try {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) { msg.textContent = 'No release found on GitHub yet.'; return; }
    if (!r.ok) throw new Error('GitHub answered with status ' + r.status);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const apk = (j.assets || []).find((a) => /\.apk$/i.test(a.name));
    updateUrl = apk ? apk.browser_download_url : j.html_url;
    if (cmpVer(latest, VERSION) > 0) {
      msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. A new version is available.';
      $('btnGetUpdate').hidden = false;
    } else { msg.textContent = 'Installed: ' + VERSION + '  •  Latest: ' + latest + '. You are up to date.'; }
  } catch (e) {
    msg.textContent = 'Could not check for updates. Connect to the internet and try again. (' + e.message + ')';
  }
}
async function shareApp() {
  const text = 'Offline Reader: a free offline text-to-speech reader with natural voices. Download the app here: ' + RELEASE_PAGE;
  try {
    const S = plugin('Share');
    if (S) { await S.share({ title: 'Offline Reader', text, url: RELEASE_PAGE, dialogTitle: 'Share Offline Reader' }); return; }
    if (navigator.share) { await navigator.share({ title: 'Offline Reader', text, url: RELEASE_PAGE }); return; }
    await navigator.clipboard.writeText(RELEASE_PAGE); toast('Download link copied.');
  } catch (e) { if (e && /cancel|abort/i.test(e.name + e.message)) return; toast('Could not open sharing. Link: ' + RELEASE_PAGE); }
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
function installApp() {
  if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
  if (isNative) { toast('Offline Reader is already installed on this phone.'); return; }
  toast('Opening the download page. Download the APK and tap it to install.'); openUrl(RELEASE_PAGE);
}

/* ---------- wiring ---------- */
function wire() {
  $('verTxt').textContent = 'v' + VERSION;
  $('btnPlay').onclick = () => { if (mode === 'playing') pause(); else play(); };
  $('btnStop').onclick = stop;
  $('btnPrev').onclick = () => step(-1);
  $('btnNext').onclick = () => step(1);
  $('btnLoad').onclick = loadText;
  $('btnCancelInput').onclick = () => { showReader(); showCurrent(false); };
  $('btnClipboard').onclick = async () => {
    try { $('paste').value = await navigator.clipboard.readText(); } catch (e) { toast('Clipboard blocked. Long-press the box and choose Paste.'); }
  };
  $('btnClear').onclick = clearText;
  $('btnRestart').onclick = async () => { if (n && await confirmBox('Go back to the very beginning?', 'Restart')) jumpTo(0); };
  $('btnShare').onclick = shareApp;
  $('btnInstall').onclick = installApp;
  $('btnUpdate').onclick = checkUpdates;
  $('btnGetUpdate').onclick = () => openUrl(updateUrl);
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
    if (settings.voice.indexOf('s:') !== 0 && !neuralFailed) initNeural(settings.voice).then(() => { engine = 'neural'; setUI(); }).catch(() => {});
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
  if (settings.voice.indexOf('s:') !== 0) {
    initNeural(settings.voice).then(() => { engine = 'neural'; setUI(); })
      .catch((e) => { neuralFailed = true; engine = 'system'; setUI(); showError('The natural voice could not start (' + e.message + '). The app will use the Android system voice.'); });
  } else { engine = 'system'; setUI(); }
}
init();
})();
