#!/usr/bin/env python3
"""Compare metrics across run directories."""
import argparse
import json
from pathlib import Path


def read_metrics(path: Path):
    file = path / 'metrics.json'
    if not file.exists():
        return {}
    try:
        payload = json.loads(file.read_text(encoding='utf-8'))
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        return {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('runs', nargs='+')
    args = parser.parse_args()
    rows = [(path, read_metrics(Path(path))) for path in args.runs]
    keys = sorted({key for _, metrics in rows for key in metrics})
    print('| run | ' + ' | '.join(keys) + ' |')
    print('|---|' + '|'.join(['---'] * len(keys)) + '|')
    for path, metrics in rows:
        print(f'| {path} | ' + ' | '.join(str(metrics.get(key, '')) for key in keys) + ' |')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
