#!/usr/bin/env python3
"""Check the minimum artifact set for an experiment-first pipeline."""
import argparse
from pathlib import Path

REQUIRED = [
    'references/research-brief.md',
    'experiments/plan.md',
    'exports/analysis.md',
    'exports/pipeline-summary.md',
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    issues = []
    for relative in REQUIRED:
        path = root / relative
        if not path.exists():
            issues.append(f'missing {relative}')
        elif path.stat().st_size < 20:
            issues.append(f'empty {relative}')
    figures = list((root / 'figures').glob('*/*')) if (root / 'figures').exists() else []
    if not figures:
        issues.append('no figure artifacts')
    manuscripts = list((root / 'manuscripts').glob('*')) if (root / 'manuscripts').exists() else []
    if not manuscripts:
        issues.append('no manuscript files')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
