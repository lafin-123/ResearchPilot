#!/usr/bin/env python3
"""Check that a run directory contains the minimum reproducibility artifacts."""
import argparse
import json
from pathlib import Path

REQUIRED = ['metrics.json', 'manifest.json']


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir')
    args = parser.parse_args()
    path = Path(args.run_dir)
    if not path.exists():
        print('run directory not found')
        return 2
    issues = []
    for name in REQUIRED:
        if not (path / name).exists():
            issues.append(f'missing {name}')
    manifest_path = path / 'manifest.json'
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            for field in ('command', 'startedAt', 'status'):
                if not manifest.get(field):
                    issues.append(f'manifest missing {field}')
            if not manifest.get('seeds'):
                issues.append('manifest missing seeds')
        except json.JSONDecodeError:
            issues.append('manifest.json is not valid JSON')
    if (path / 'metrics.json').exists():
        try:
            json.loads((path / 'metrics.json').read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            issues.append('metrics.json is not valid JSON')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
