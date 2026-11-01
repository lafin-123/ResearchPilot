#!/usr/bin/env python3
"""Create a minimal, reproducible experiment skeleton."""
import argparse
from pathlib import Path

MAIN = '''"""Experiment entry point. Replace with the real study."""
import json
import os
import random

import numpy as np

RUN_DIR = os.environ.get('RESEARCHPILOT_RUN_DIR', '.')
SEED = 42
random.seed(SEED)
np.random.seed(SEED)


def main() -> None:
    values = np.random.normal(size=200)
    result = {'metric': 'mean', 'value': float(values.mean()), 'n': int(values.size), 'seed': SEED}
    print('RESEARCHPILOT_METRIC:' + json.dumps(result))
    with open(os.path.join(RUN_DIR, 'metrics.json'), 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default='experiments/new-study')
    args = parser.parse_args()
    target = Path(args.dir)
    (target / 'runs').mkdir(parents=True, exist_ok=True)
    (target / 'main.py').write_text(MAIN, encoding='utf-8')
    (target / 'config.yaml').write_text('seed: 42\nseeds: [42, 43, 44, 45, 46]\n', encoding='utf-8')
    (target / 'README.md').write_text('# Experiment\n\n- Claim:\n- Command:\n- Env:\n', encoding='utf-8')
    print(f'created {target}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
