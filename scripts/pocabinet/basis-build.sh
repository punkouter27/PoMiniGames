#!/usr/bin/env bash
# Build Basis Universal's KTX2 transcoder for a page with no 'unsafe-eval' in its
# Content-Security-Policy. Runs inside the Emscripten image:
#
#   docker run --rm -v "${PWD}/scripts/pocabinet:/work:ro" -v "${PWD}/src/PoMiniGames.Client/wwwroot/lib/basis:/out" \
#       emscripten/emsdk:3.1.74-arm64 bash /work/basis-build.sh
#
# (drop -arm64 on an x64 machine). The image is pinned to the Emscripten of the transcoder's own
# day: under the newest one (7.0.0) these sources no longer compile (missing <mutex>, <exception>).
#
# Why not three's copy: three ships this transcoder built the stock way, where embind writes its
# call wrappers as JavaScript text and turns them into functions with `new Function`. The site's
# CSP refuses that, so every KTX2 texture failed to load. -sDYNAMIC_EXECUTION=0 makes embind call
# through closures instead (a little slower per call; the transcoder makes a few calls a texture).
# Nothing else is changed: same sources, same API, so three's KTX2Loader drives it as it is.
set -euo pipefail

TAG="${BASIS_TAG:-v1_60}"
rm -rf /tmp/basis
git clone --quiet --depth 1 --branch "$TAG" https://github.com/BinomialLLC/basis_universal /tmp/basis
cd /tmp/basis/webgl/transcoder

# The one change: no functions made from strings.
grep -q 'MODULARIZE=1' CMakeLists.txt
sed -i 's/-s MODULARIZE=1/-s MODULARIZE=1 -s DYNAMIC_EXECUTION=0/' CMakeLists.txt
grep -q 'DYNAMIC_EXECUTION=0' CMakeLists.txt

mkdir -p build && cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release > /tmp/cmake.log
emmake make -j"$(nproc)" > /tmp/make.log

# No function is made from a string anywhere in the output.
if grep -Eq 'new Function|newFunc\(|[^A-Za-z_.]eval\(' basis_transcoder.js; then
    echo 'the build still makes functions from strings' >&2
    exit 1
fi
cp basis_transcoder.js basis_transcoder.wasm /out/
cp /tmp/basis/LICENSE /out/LICENSE
echo "built $TAG with $(emcc --version | head -1)"
ls -l /out
