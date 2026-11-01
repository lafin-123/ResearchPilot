#!/usr/bin/env python3
"""Report duplicate DOI/title candidates in a BibTeX or evidence matrix file."""
import argparse
import re
from pathlib import Path

FIELD_RE = re.compile(r'(title|doi)\s*=\s*[{"]([^}"]+)["}]', re.IGNORECASE)


def normalize(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    args = parser.parse_args()
    path = Path(args.file)
    text = path.read_text(encoding='utf-8', errors='replace')
    seen = {}
    issues = []
    for match in FIELD_RE.finditer(text):
        name, value = match.group(1).lower(), normalize(match.group(2))
        if not value:
            continue
        if value in seen:
            issues.append(f'duplicate {name}: {value} (already seen)')
        else:
            seen[value] = name
    for issue in issues:
        print(issue)
    print(f'candidates={len(seen)} duplicates={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
