#!/usr/bin/env python3
"""Summarize metrics from a ResearchPilot run directory using stdlib only."""
import argparse
import json
import random
from pathlib import Path
from statistics import mean, pstdev


def collect(path: Path):
    metrics = {}
    metrics_file = path / 'metrics.json'
    if metrics_file.exists():
        try:
            payload = json.loads(metrics_file.read_text(encoding='utf-8'))
            if isinstance(payload, dict):
                metrics.update(payload)
        except json.JSONDecodeError:
            print('warning: metrics.json is not valid JSON')
    for line in (path / 'stdout.txt').read_text(encoding='utf-8', errors='replace').splitlines() if (path / 'stdout.txt').exists() else []:
        if not line.startswith('RESEARCHPILOT_METRIC:'):
            continue
        try:
            payload = json.loads(line.split(':', 1)[1].strip())
            if isinstance(payload, dict):
                for key, value in payload.items():
                    metrics.setdefault(key, value)
        except json.JSONDecodeError:
            continue
    return metrics


def bootstrap_ci(values, iterations=2000, alpha=0.05):
    if len(values) < 2:
        return None
    rng = random.Random(42)
    means = []
    for _ in range(iterations):
        sample = [rng.choice(values) for _ in values]
        means.append(mean(sample))
    means.sort()
    low = means[int((alpha / 2) * len(means))]
    high = means[int((1 - alpha / 2) * len(means)) - 1]
    return low, high


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    path = Path(args.run_dir)
    if not path.exists():
        print('run directory not found')
        return 2
    metrics = collect(path)
    summary = {}
    for key, value in metrics.items():
        if isinstance(value, list) and value and all(isinstance(item, (int, float)) for item in value):
            values = [float(item) for item in value]
            summary[key] = {
                'n': len(values),
                'mean': mean(values),
                'std': pstdev(values),
                'ci95': bootstrap_ci(values),
            }
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            summary[key] = value
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print('# Metric Summary')
        for key, value in summary.items():
            if isinstance(value, dict):
                low, high = value['ci95'] or (float('nan'), float('nan'))
                print(f'- {key}: mean={value["mean"]:.6g} std={value["std"]:.6g} n={value["n"]} 95%CI=[{low:.6g}, {high:.6g}]')
            else:
                print(f'- {key}: {value}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
