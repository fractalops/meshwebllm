#!/usr/bin/env bash
# Pinned upstream assets for graph-partition and tokenizer integration tests.
set -euo pipefail
cd "$(dirname "$0")/.."
root=experiments/layer-split/artifacts/source
revision=12fd25f77366fa6b3b4b768ec3050bf629380bac
mkdir -p "$root/onnx"
for file in onnx/model_q4.onnx config.json tokenizer.json tokenizer_config.json; do
  if [[ ! -s "$root/$file" ]]; then
    curl --fail --location --retry 3 \
      "https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/$revision/$file" \
      --output "$root/$file.part"
    mv "$root/$file.part" "$root/$file"
  fi
done
