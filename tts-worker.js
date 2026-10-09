'use strict';
// Piper neural TTS worker: phonemize (espeak-ng WASM) -> ONNX model (onnxruntime-web) -> audio samples.
var BASE = self.location.href.replace(/[^\/]*$/, '');
var loadError = null;
try {
  importScripts('lib/ort.min.js', 'lib/piper_phonemize.js');
} catch (e) {
  loadError = 'Voice engine files are missing from the app (' + (e && e.message ? e.message : e) + ').';
}

var session = null, cfg = null, wasmBinary = null, dataBuf = null;
var currentGen = 0;
var queue = Promise.resolve();

if (!loadError) {
  ort.env.wasm.wasmPaths = BASE + 'lib/';
  ort.env.wasm.numThreads = 1;
}

function post(m, t) { self.postMessage(m, t || []); }

function phonemize(text) {
  return new Promise(function (resolve, reject) {
    var result = null;
    createPiperPhonemize({
      print: function (line) {
        try {
          var j = JSON.parse(line);
          if (j && j.phoneme_ids && !result) result = j.phoneme_ids;
        } catch (e) { /* not a JSON line */ }
      },
      printErr: function () {},
      locateFile: function (url) { return BASE + 'lib/' + url.split('/').pop(); },
      wasmBinary: wasmBinary,
      getPreloadedPackage: function () { return dataBuf; }
    }).then(function (mod) {
      try {
        mod.callMain(['-l', cfg.espeak.voice, '--input', JSON.stringify([{ text: text }]), '--espeak_data', '/espeak-ng-data']);
      } catch (e) { /* callMain may throw on normal exit; result is already captured */ }
      resolve(result);
    }).catch(reject);
  });
}

async function synth(text, speed) {
  var ids = await phonemize(text);
  if (!ids || !ids.length) return { samples: new Float32Array(0), sr: cfg.audio.sample_rate };
  var inf = cfg.inference || {};
  var noise = inf.noise_scale != null ? inf.noise_scale : 0.667;
  var len = (inf.length_scale != null ? inf.length_scale : 1) / speed;
  var nw = inf.noise_w != null ? inf.noise_w : 0.8;
  var feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, function (x) { return BigInt(x); }), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise, len, nw]), [3])
  };
  if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(0)]), [1]);
  var out = await session.run(feeds);
  var first = out[Object.keys(out)[0]];
  return { samples: new Float32Array(first.data), sr: cfg.audio.sample_rate };
}

async function init(msg) {
  if (loadError) throw new Error(loadError);
  post({ type: 'status', msg: 'Loading voice model…' });
  var r = await fetch(msg.cfg);
  if (!r.ok) throw new Error('Voice settings file not found (' + msg.cfg + ').');
  cfg = await r.json();
  var m = await fetch(msg.file);
  if (!m.ok) throw new Error('Voice model file not found (' + msg.file + ').');
  var modelBuf = await m.arrayBuffer();
  if (session) { try { await session.release(); } catch (e) {} session = null; }
  post({ type: 'status', msg: 'Starting voice engine…' });
  session = await ort.InferenceSession.create(new Uint8Array(modelBuf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  if (!wasmBinary) {
    var w = await fetch('lib/piper_phonemize.wasm');
    if (!w.ok) throw new Error('Phonemizer file missing.');
    wasmBinary = await w.arrayBuffer();
    var d = await fetch('lib/piper_phonemize.data');
    if (!d.ok) throw new Error('Phonemizer data file missing.');
    dataBuf = await d.arrayBuffer();
  }
  await synth('Hello.', 1); // warm-up, also proves the engine works
  post({ type: 'ready', iid: msg.iid, key: msg.key });
}

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'gen') { currentGen = msg.gen; return; }
  queue = queue.then(async function () {
    if (msg.type === 'init') {
      try { await init(msg); }
      catch (err) { post({ type: 'error', iid: msg.iid, msg: String(err && err.message ? err.message : err) }); }
    } else if (msg.type === 'synth') {
      if (msg.gen < currentGen) { post({ type: 'skipped', id: msg.id }); return; }
      try {
        var res = await synth(msg.text, msg.speed);
        post({ type: 'audio', id: msg.id, samples: res.samples, sr: res.sr }, [res.samples.buffer]);
      } catch (err) {
        post({ type: 'error', id: msg.id, msg: String(err && err.message ? err.message : err) });
      }
    }
  });
};
