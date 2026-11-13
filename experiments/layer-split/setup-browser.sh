#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
hf download HuggingFaceTB/SmolLM2-135M-Instruct \
  onnx/model_q4.onnx config.json \
  --revision 12fd25f77366fa6b3b4b768ec3050bf629380bac --local-dir artifacts/source
npm ci
./build-iroh.sh
