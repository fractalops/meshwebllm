"""Condense the browser's saved results into reviewable, reproducible evidence."""
import json
import statistics
from pathlib import Path
from tokenizers import Tokenizer

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'artifacts/manifest.json').read_text())
tokenizer = Tokenizer.from_file(str(root / 'artifacts/source/tokenizer.json'))
report = {
    'scope': 'One Mac, one physical Apple GPU, three isolated browser workers (baseline plus two stages). Browser iroh endpoints share the page and use a public relay.',
    'runtime': 'onnxruntime-web 1.23.2, WebGPU; iroh 1.4',
    'source': manifest['source'],
    'weights': {k:{f:v[f] for f in ['bytes','sha256','layers','initializerCount']} for k,v in manifest['models'].items()},
    'sharedInitializers': manifest['sharedInitializers'],
    'runs': {},
}
for mode in ['local', 'iroh']:
    raw = json.loads((root / f'artifacts/results/{mode}.json').read_text())
    assert raw['passed'], raw.get('error')
    steps = [r for t in raw['tests'] for r in t['steps']]
    assert len(steps) == 24
    assert all(r['baselineToken'] == r['splitToken'] for r in steps)
    assert all(r['cacheTensors'] == [30,30] for r in steps)
    assert all(n > 0 for n in steps[-1]['gpuDispatches'])
    assert all(r['exactHashMatch'] if mode == 'iroh' else r['maxAbs'] == 0 for r in steps)
    decode = [r for r in steps if not r['prefill']]
    entry = {
        'date': raw['date'], 'userAgent': raw['userAgent'], 'passed': raw['passed'],
        'adapters': [w['adapter'] for w in raw['workers']],
        'checkedSteps': len(steps), 'allLogitsExact': True,
        'medianDecodeMs': statistics.median(r['splitMs'] for r in decode),
        'medianBaselineDecodeMs': statistics.median(r['baselineMs'] for r in decode),
        'decodeActivationBytes': sorted({r['activationBytes'] for r in decode}),
        'finalGpuDispatches': steps[-1]['gpuDispatches'],
        'tests': [],
    }
    if mode == 'iroh':
        entry['relayAddress'] = raw['peers']['address']['addrs']
        entry['decodeRequestBytes'] = sorted({r['requestBytes'] for r in decode})
        entry['decodeReplyBytes'] = sorted({r['responseBytes'] for r in decode})
    for test in raw['tests']:
        ids=[s['splitToken'] for s in test['steps']]
        # The harness deliberately runs a fixed number of steps past EOS.
        visible=ids[:ids.index(2)] if 2 in ids else ids
        entry['tests'].append({'name':test['name'], 'textBeforeEos':tokenizer.decode(visible), 'steps':test['steps']})
    report['runs'][mode]=entry
(root / 'results.json').write_text(json.dumps(report, indent=2)+'\n')
for name,run in report['runs'].items():
    print(name, 'median split decode', round(run['medianDecodeMs'],1), 'ms; baseline', round(run['medianBaselineDecodeMs'],1), 'ms')
    for test in run['tests']: print(test['name'], repr(test['textBeforeEos']))
