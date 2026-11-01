#!/usr/bin/env python3
"""Create a concise Markdown pipeline summary from artifacts."""
import argparse
from pathlib import Path

FILES = [
    ('Research brief', 'references/research-brief.md'),
    ('Experiment plan', 'experiments/plan.md'),
    ('Analysis', 'exports/analysis.md'),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    lines = ['# Pipeline Summary', '']
    for label, relative in FILES:
        path = root / relative
        lines.append(f'## {label}')
        lines.append('')
        if path.exists():
            lines.append(path.read_text(encoding='utf-8', errors='replace')[:4000])
        else:
            lines.append('MISSING: ' + relative)
        lines.append('')
    output = root / 'exports' / 'pipeline-summary.md'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'wrote {output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
