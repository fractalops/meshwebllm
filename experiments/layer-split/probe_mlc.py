"""Inspect the installed MLC pipeline pass without importing its native libraries.

This is a source audit, not a successful compile or a browser inference test.
"""
import ast
import hashlib
import importlib.metadata
import json
from pathlib import Path

package = importlib.metadata.distribution('mlc-llm-nightly-cpu')
path = Path(package.locate_file('mlc_llm/compiler_pass/pipeline_parallel_rewrite.py'))
source = path.read_text()
constants = {n.value for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
required = ['runtime.disco.recv_from_prev_group', 'runtime.disco.send_to_next_group', 'mlc.multi_gpu.DispatchFunctionByGroup']
assert all(name in constants for name in required)
result = {'kind': 'source-audit-only', 'package': package.metadata['Name'], 'version': package.version, 'file': 'mlc_llm/compiler_pass/pipeline_parallel_rewrite.py', 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'nativeRuntimeCalls': required}
output = Path(__file__).resolve().parent / 'artifacts/mlc-source-audit.json'
output.write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result, indent=2))
