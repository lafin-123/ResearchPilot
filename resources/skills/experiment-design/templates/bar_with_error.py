"""Smoke-test example for ResearchPilot. Replace data with real artifacts."""
import json
import os

import numpy as np

RUN_DIR = os.environ.get('RESEARCHPILOT_RUN_DIR', '.')
labels = ['baseline', 'ours']
means = np.array([0.71, 0.78])
errors = np.array([0.02, 0.015])

result = {
    'primary_metric': 'accuracy',
    'labels': labels,
    'means': means.tolist(),
    'std': errors.tolist(),
    'n': 5,
}
print('RESEARCHPILOT_METRIC:' + json.dumps(result))
with open(os.path.join(RUN_DIR, 'metrics.json'), 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print('Smoke test complete')
