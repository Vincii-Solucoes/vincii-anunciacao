#!/bin/sh
# Compila o bcg729 (G.729, GPLv3 — vendor/bcg729) para WebAssembly usando o Emscripten em Docker.
# Saída: src/media/g729/bcg729.mjs (wasm embutido). Uso: sh scripts/build-g729.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p src/media/g729
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.74-arm64 \
  emcc vendor/bcg729/src/*.c -Ivendor/bcg729/include -Ivendor/bcg729/src \
    -O3 -flto -DNDEBUG \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 -s ENVIRONMENT=web,worker,node \
    -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
    -s EXPORT_NAME=createBcg729 \
    -s EXPORTED_FUNCTIONS=_initBcg729EncoderChannel,_closeBcg729EncoderChannel,_bcg729Encoder,_initBcg729DecoderChannel,_closeBcg729DecoderChannel,_bcg729Decoder,_malloc,_free \
    -s EXPORTED_RUNTIME_METHODS=HEAP16,HEAPU8 \
    -o src/media/g729/bcg729.mjs
ls -la src/media/g729/bcg729.mjs
