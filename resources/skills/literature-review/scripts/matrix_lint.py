#!/usr/bin/env python3
"""Check an evidence matrix for empty required cells."""
import argparse
import csv
from pathlib import Path

REQUIRED = ['Study', 'Venue/Year', 'Task/Dataset', 'Method', 'Baselines', 'Metric', 'Main result', 'Limitations', 'Relevance']


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('matrix')
    args = parser.parse_args()
    path = Path(args.matrix)
    if not path.exists():
        print('missing matrix')
        return 2
    with path.open(encoding='utf-8', errors='replace', newline='') as handle:
        rows = list(csv.DictReader(handle))
    issues = []
    for index, row in enumerate(rows, 2):
        for column in REQUIRED:
            if not (row.get(column) or '').strip():
                issues.append(f'row {index}: empty {column}')
    for issue in issues:
        print(issue)
    print(f'rows={len(rows)} issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
