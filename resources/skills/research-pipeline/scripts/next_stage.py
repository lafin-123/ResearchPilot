#!/usr/bin/env python3
"""Suggest the next incomplete pipeline stage from artifact presence."""
import argparse
from pathlib import Path

STAGES = [
    ('literature', 'references/research-brief.md'),
    ('hypothesis', 'experiments/plan.md'),
    ('analysis', 'exports/analysis.md'),
    ('figures', 'figures'),
    ('manuscript', 'manuscripts'),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    for stage, relative in STAGES:
        path = root / relative
        if not path.exists() or (path.is_file() and path.stat().st_size < 20):
            print(stage)
            return 0
    print('review')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
