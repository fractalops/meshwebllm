#!/usr/bin/env bash
# Builds the browser crate and writes JS bindings to web/src/wasm.
# Usage: scripts/build-wasm.sh [--dev]
set -euo pipefail
cd "$(dirname "$0")/.."

profile=release
cargo_flags=(--release)
if [[ "${1:-}" == "--dev" ]]; then
  profile=debug
  cargo_flags=()
  export CARGO_PROFILE_DEV_DEBUG=0
  export CARGO_INCREMENTAL=0
fi

# ring needs a C compiler with a wasm32 target. Apple clang has none.
if [[ "$(uname)" == "Darwin" && -z "${CC_wasm32_unknown_unknown:-}" ]]; then
  llvm="$(brew --prefix llvm 2>/dev/null || true)"
  if [[ -x "$llvm/bin/clang" ]]; then
    export CC_wasm32_unknown_unknown="$llvm/bin/clang"
    export AR_wasm32_unknown_unknown="$llvm/bin/llvm-ar"
  else
    echo "error: install LLVM with 'brew install llvm'. Apple clang cannot build for wasm32." >&2
    exit 1
  fi
fi

cargo build -p meshwebllm-web --target wasm32-unknown-unknown ${cargo_flags[@]+"${cargo_flags[@]}"}
wasm-bindgen "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/$profile/meshwebllm_web.wasm" \
  --out-dir web/src/wasm --target web --weak-refs

if [[ "$profile" == "release" ]] && command -v wasm-opt >/dev/null; then
  wasm-opt --enable-nontrapping-float-to-int --enable-bulk-memory -Os \
    -o web/src/wasm/meshwebllm_web_bg.wasm web/src/wasm/meshwebllm_web_bg.wasm
fi
