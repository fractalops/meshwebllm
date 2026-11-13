#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_INCREMENTAL=0
export PATH="$HOME/.cargo/bin:$PATH"
if [[ "$(uname)" == Darwin && -z "${CC_wasm32_unknown_unknown:-}" ]]; then
  llvm="$(brew --prefix llvm)"
  export CC_wasm32_unknown_unknown="$llvm/bin/clang"
  export AR_wasm32_unknown_unknown="$llvm/bin/llvm-ar"
fi
cargo build -p meshwebllm-web --target wasm32-unknown-unknown --features layer-split-experiment
wasm-bindgen "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/debug/meshwebllm_web.wasm" \
  --out-dir experiments/layer-split/artifacts/iroh --target web --weak-refs
