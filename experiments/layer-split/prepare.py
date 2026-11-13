"""Extract two independently loadable graphs from the published SmolLM2 ONNX model."""
import hashlib
import json
import re
from pathlib import Path

import onnx
from onnx.utils import Extractor
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / 'artifacts'
SOURCE = ARTIFACTS / 'source'
model = onnx.load(SOURCE / 'onnx/model_q4.onnx')
config = json.loads((SOURCE / 'config.json').read_text())
assert config['num_hidden_layers'] == 30
boundary = [
    '/model/layers.14/post_attention_layernorm/output_3',
    '/model/layers.14/mlp/down_proj/MatMul/output_0',
]
# The optimized graph fuses the residual add into the next layer's RMSNorm.
# Carry the two residual terms, leaving the published operators unchanged.
known = {v.name for v in model.graph.value_info}
for name in boundary:
    if name not in known:
        model.graph.value_info.append(onnx.helper.make_tensor_value_info(name, onnx.TensorProto.FLOAT, ['batch_size', 'sequence_length', 576]))

inputs = [v.name for v in model.graph.input]
outputs = [v.name for v in model.graph.output]
def layer(name):
    return int(name.split('.')[1])
first_inputs = [n for n in inputs if not n.startswith('past_key_values.') or layer(n) < 15]
second_inputs = ['attention_mask', 'position_ids'] + [n for n in inputs if n.startswith('past_key_values.') and layer(n) >= 15] + boundary
first_outputs = boundary + [n for n in outputs if n.startswith('present.') and layer(n) < 15]
second_outputs = ['logits'] + [n for n in outputs if n.startswith('present.') and layer(n) >= 15]
extractor = Extractor(model)
first = extractor.extract_model(first_inputs, first_outputs)
second = extractor.extract_model(second_inputs, second_outputs)

manifest = {'source': {'repo': 'HuggingFaceTB/SmolLM2-135M-Instruct', 'revision': '12fd25f77366fa6b3b4b768ec3050bf629380bac', 'file': 'onnx/model_q4.onnx', 'sha256': hashlib.sha256((SOURCE / 'onnx/model_q4.onnx').read_bytes()).hexdigest()}, 'config': config, 'boundary': boundary, 'models': {}}
for role, graph, path, expected in [
    ('baseline', model, SOURCE / 'onnx/model_q4.onnx', set(range(30))),
    ('first', first, ARTIFACTS / 'first.onnx', set(range(15))),
    ('second', second, ARTIFACTS / 'second.onnx', set(range(15,30))),
]:
    layers = {int(m.group(1)) for i in graph.graph.initializer if (m := re.search(r'layers\.(\d+)\.', i.name)) and int(m.group(1)) < 30}
    assert layers == expected, (role, layers)
    # The published ORT-optimized model uses SimplifiedLayerNormalization in
    # the standard domain, which the generic ONNX schema checker rejects.
    # Validate dependency closure here; ORT validates operator support at load.
    available = {v.name for v in graph.graph.input} | {v.name for v in graph.graph.initializer}
    for node in graph.graph.node:
        assert all(not n or n in available for n in node.input), node.name
        available.update(n for n in node.output if n)
    assert all(v.name in available for v in graph.graph.output)
    if role != 'baseline': onnx.save(graph, path)
    manifest['models'][role] = {
        'url': '/' + str(path.relative_to(ROOT)), 'bytes': path.stat().st_size,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'layers': sorted(layers), 'initializerCount': len(graph.graph.initializer),
        'inputs': [v.name for v in graph.graph.input], 'outputs': [v.name for v in graph.graph.output],
    }
    print(role, path.stat().st_size, 'bytes; layers', sorted(layers))
first_weights = {v.name for v in first.graph.initializer}
second_weights = {v.name for v in second.graph.initializer}
shared = sorted(first_weights & second_weights)
assert not any('layers.' in n for n in shared), shared
manifest['sharedInitializers'] = shared  # Tied embedding/output head, RoPE and mask constants.
tokenizer = Tokenizer.from_file(str(SOURCE / 'tokenizer.json'))
manifest['tests'] = []
for name, prompt in [('short', 'What is the capital of France?'), ('longer', 'Explain in one short sentence why the sky looks blue on a clear day.')]:
    text = '<|im_start|>user\n' + prompt + '<|im_end|>\n<|im_start|>assistant\n'
    manifest['tests'].append({'name':name, 'prompt':prompt, 'tokens':tokenizer.encode(text).ids, 'steps':12})
(ARTIFACTS / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print('Shared non-transformer initializers:', shared)
