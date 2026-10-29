#!/usr/bin/env bash
# Builds the www/ folder: app files + onnxruntime + Piper phonemizer + voice models.
set -euo pipefail
VER="${APP_VERSION:-1.0.0}"
rm -rf www && mkdir -p www/lib www/models
cp index.html styles.css config.js app.js tts-worker.js icon-192.png icon-512.png www/
sed -i "s/__VERSION__/${VER}/" www/config.js

# onnxruntime-web (installed by npm install)
cp node_modules/onnxruntime-web/dist/ort.min.js www/lib/
cp node_modules/onnxruntime-web/dist/ort-wasm*.wasm www/lib/
cp node_modules/onnxruntime-web/dist/ort-wasm*.js www/lib/ 2>/dev/null || true

# Piper phonemizer (espeak-ng compiled to WASM)
PW=node_modules/@diffusionstudio/piper-wasm
for f in piper_phonemize.js piper_phonemize.wasm piper_phonemize.data; do
  p=""
  [ -d "$PW" ] && p=$(find "$PW" -name "$f" | head -n1 || true)
  if [ -n "$p" ]; then cp "$p" "www/lib/$f"
  else curl -fL --retry 3 -o "www/lib/$f" "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/$f"; fi
done

# Voice models (Piper, US English, medium quality): Amy = female, Ryan = male
HF=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US
for v in amy ryan; do
  for ext in onnx onnx.json; do
    curl -fL --retry 3 -o "www/models/en_US-$v-medium.$ext" "$HF/$v/medium/en_US-$v-medium.$ext"
  done
done
echo "--- www contents ---"
du -sh www www/lib www/models
ls -la www/lib www/models

# ---- web / iPhone version extras ----
cp manifest.webmanifest sw.js apple-touch-icon.png icon-maskable-512.png www/
sed -i "s/__VERSION__/${VER}/" www/sw.js
echo "{\"version\":\"${VER}\"}" > www/version.json
# list of big files the "Save voices for offline use" button downloads
( cd www && find lib models -type f | sort | python3 -c "import sys,json; print(json.dumps({'files':[l.strip() for l in sys.stdin if l.strip()]}))" > files.json && cat files.json )
