#!/usr/bin/env python3
"""Seeded bootstrap mean difference for two groups. No automatic significance claims."""
import argparse
import csv
import hashlib
import json
import math
import random
import statistics
from pathlib import Path


def compare(path, group_column, value_column, id_column, control, treatment, paired, unit, seed=42, resamples=5000):
    raw = Path(path).read_bytes()
    blockers, warnings = [], []
    groups = {control: {}, treatment: {}}
    if control == treatment:
        blockers.append('Control and treatment must differ')
    with Path(path).open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if not {group_column, value_column, id_column}.issubset(reader.fieldnames or []):
            blockers.append('Missing group, value or sampling-ID column')
        else:
            for line, row in enumerate(reader, 2):
                name = row.get(group_column)
                if name not in groups:
                    blockers.append(f'Unexpected group at line {line}: {name}')
                    continue
                key = row.get(id_column, '')
                try:
                    value = float(row[value_column])
                    if not math.isfinite(value) or not key or key in groups[name]:
                        raise ValueError('Invalid/duplicate unit')
                    groups[name][key] = value
                except (ValueError, TypeError):
                    blockers.append(f'Missing/nonfinite value or duplicate sampling unit at line {line}')
    a, b = groups[control], groups[treatment]
    if min(len(a), len(b)) < 2:
        blockers.append('At least two independent units per group are required')
    if paired and set(a) != set(b):
        blockers.append('Paired design requires exactly matching sampling IDs; no rows were dropped')
    if not paired and set(a) & set(b):
        blockers.append('Independent design has overlapping sampling IDs; choose the correct design')
    if not unit.strip():
        blockers.append('Declare the independent sampling unit')
    report = {'version': 1, 'status': 'blocked' if blockers else 'passed', 'blockers': blockers, 'warnings': warnings,
              'source': str(path), 'sha256': hashlib.sha256(raw).hexdigest(), 'design': 'paired' if paired else 'independent',
              'unit': unit, 'control': control, 'treatment': treatment, 'nControl': len(a), 'nTreatment': len(b),
              'seed': seed, 'resamples': resamples, 'method': 'Percentile bootstrap; mean(treatment)-mean(control)',
              'limits': 'Exploratory interval, not a p-value or proof of equivalence/causality. Assumes independent sampling units; clustered/time-series and multiple-endpoint inference are unsupported.'}
    if blockers:
        return report
    av, bv = list(a.values()), list(b.values())
    rng = random.Random(seed)
    if paired:
        differences = [b[key] - a[key] for key in sorted(a)]
        draws = [statistics.mean(rng.choices(differences, k=len(differences))) for _ in range(resamples)]
    else:
        draws = [statistics.mean(rng.choices(bv, k=len(bv))) - statistics.mean(rng.choices(av, k=len(av))) for _ in range(resamples)]
    draws.sort()
    def percentile(q):
        index = (len(draws) - 1) * q
        lower = math.floor(index)
        upper = math.ceil(index)
        return draws[lower] + (draws[upper] - draws[lower]) * (index - lower)
    report.update({'meanControl': statistics.mean(av), 'meanTreatment': statistics.mean(bv),
                   'difference': statistics.mean(bv) - statistics.mean(av), 'ci95': [percentile(.025), percentile(.975)]})
    if min(len(a), len(b)) < 10:
        warnings.append('Small sample: bootstrap coverage may be poor; report raw data and avoid strong claims')
    if statistics.pvariance(av + bv) == 0:
        warnings.append('All observations identical; a degenerate interval is not certainty')
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input')
    p.add_argument('--group', default='group')
    p.add_argument('--value', default='value')
    p.add_argument('--id', default='unit_id')
    p.add_argument('--control', required=True)
    p.add_argument('--treatment', required=True)
    p.add_argument('--unit', required=True)
    p.add_argument('--paired', action='store_true')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--resamples', type=int, default=5000)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    if not 1000 <= args.resamples <= 100000:
        p.error('resamples must be 1000..100000')
    if Path(args.input).resolve() == Path(args.out).resolve():
        p.error('Output must not overwrite input')
    report = compare(args.input, args.group, args.value, args.id, args.control, args.treatment, args.paired, args.unit, args.seed, args.resamples)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(report['status'])
    return bool(report['blockers'])


if __name__ == '__main__':
    raise SystemExit(main())
