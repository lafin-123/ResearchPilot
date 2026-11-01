#!/usr/bin/env python3
"""Read-only CSV audit. Standard library only; never repairs or drops rows."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def audit(path, id_column=None, split_column=None, numeric=()):
    path = Path(path)
    blockers, warnings = [], []
    raw = path.read_bytes()
    with path.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        rows = list(reader)
    if not header or any(not value.strip() for value in header) or len(set(header)) != len(header):
        blockers.append('Missing, blank or duplicate column names')
    if not rows:
        blockers.append('No data records')
    malformed = [i + 2 for i, row in enumerate(rows) if len(row) != len(header)]
    if malformed:
        blockers.append(f'Inconsistent row widths at lines {malformed[:20]}')
    for name in [id_column, split_column, *numeric]:
        if name and name not in header:
            blockers.append(f'Unknown requested column: {name}')
    valid_rows = [row for row in rows if len(row) == len(header)]
    missing = {name: sum(not row[j].strip() for row in valid_rows) for j, name in enumerate(header)}
    if any(missing.values()):
        blockers.append('Missing cells require an explicit handling decision; original data was not changed')
    duplicate_rows = len(valid_rows) - len({tuple(row) for row in valid_rows})
    if duplicate_rows:
        blockers.append(f'{duplicate_rows} duplicate records require review')
    numeric_summary = {}
    for name in numeric:
        if name not in header:
            continue
        j, values, invalid = header.index(name), [], []
        for i, row in enumerate(rows, 2):
            if len(row) != len(header) or not row[j].strip():
                continue
            try:
                value = float(row[j])
                if not math.isfinite(value):
                    raise ValueError('nonfinite')
                values.append(value)
            except ValueError:
                invalid.append(i)
        if invalid:
            blockers.append(f'Invalid/non-finite numeric {name} at lines {invalid[:20]}')
        numeric_summary[name] = {'n': len(values), 'min': min(values) if values else None, 'max': max(values) if values else None}
    duplicate_ids, leakage = [], []
    if id_column in header:
        j = header.index(id_column)
        seen = {}
        for row in valid_rows:
            key = row[j]
            group = row[header.index(split_column)] if split_column in header else ''
            if key in seen:
                duplicate_ids.append(key)
                if group != seen[key]:
                    leakage.append(key)
            seen[key] = group
        if duplicate_ids:
            blockers.append(f'Repeated sampling IDs: {sorted(set(duplicate_ids))[:20]} (may be paired/repeated measures; review design)')
        if leakage:
            blockers.append(f'Cross-split ID leakage: {sorted(set(leakage))[:20]}')
    else:
        warnings.append('No sampling ID supplied; duplicate participants and split leakage cannot be ruled out')
    return {'version': 1, 'status': 'blocked' if blockers else 'passed', 'blockers': blockers, 'warnings': warnings,
            'source': str(path), 'sha256': hashlib.sha256(raw).hexdigest(), 'rows': len(rows), 'columns': header,
            'missing': missing, 'duplicateRows': duplicate_rows, 'numeric': numeric_summary,
            'limits': 'Structural audit only. No privacy, representativeness, causal validity or absence of all leakage is established.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--id-column')
    parser.add_argument('--split-column')
    parser.add_argument('--numeric', nargs='*', default=[])
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    if Path(args.input).resolve() == Path(args.out).resolve():
        parser.error('Output must not overwrite input')
    report = audit(args.input, args.id_column, args.split_column, args.numeric)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(f"{report['status']}: {len(report['blockers'])} blockers; {args.out}")
    return 1 if report['blockers'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
