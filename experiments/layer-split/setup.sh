#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
uv venv --python 3.13 --allow-existing .venv
uv pip install --python .venv/bin/python -r requirements.txt
hf download HuggingFaceTB/SmolLM2-135M-Instruct \
  onnx/model_q4.onnx config.json tokenizer.json tokenizer_config.json \
  --revision 12fd25f77366fa6b3b4b768ec3050bf629380bac --local-dir artifacts/source
.venv/bin/python prepare.py
npm ci
