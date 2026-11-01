#!/usr/bin/env python3
"""Lightweight manuscript hygiene checks. No third-party dependencies."""
import argparse
import re
from pathlib import Path

PLACEHOLDERS = ['TODO', 'TBD', 'FIXME', 'XXX']
NUMBER_RE = re.compile(r'(?<![\w.])-?\d+(?:\.\d+)?%?')
RUN_RE = re.compile(r'run[_ -]?[a-f0-9]{6,}', re.IGNORECASE)
CITE_RE = re.compile(r'\\cite[tp]?\{([^}]+)\}|\[@([^\]]+)\]')


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8', errors='replace')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    findings = []
    for item in args.files:
        path = Path(item)
        if not path.exists():
            findings.append((str(path), 0, 'error', 'file not found'))
            continue
        text = read(path)
        lines = text.splitlines()
        for number, line in enumerate(lines, 1):
            for placeholder in PLACEHOLDERS:
                if placeholder in line:
                    findings.append((str(path), number, 'placeholder', line.strip()[:180]))
                    break
        numbers = NUMBER_RE.findall(text)
        runs = RUN_RE.findall(text)
        if len(numbers) >= 5 and not runs:
            findings.append((str(path), 1, 'traceability', 'manuscript contains numbers but no run IDs; map every empirical number to a run'))
        for match in CITE_RE.finditer(text):
            keys = (match.group(1) or match.group(2) or '').split(',')
            for key in keys:
                if not key.strip():
                    findings.append((str(path), 1, 'citation', 'empty citation key'))
        if len(findings) == 0:
            print('OK: no placeholder or traceability findings')
    if args.json:
        import json
        print(json.dumps([{'file': f, 'line': l, 'kind': k, 'detail': d} for f, l, k, d in findings], indent=2))
    else:
        for file, line, kind, detail in findings:
            print(f'{file}:{line}: [{kind}] {detail}')
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
