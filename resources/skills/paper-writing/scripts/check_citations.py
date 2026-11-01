#!/usr/bin/env python3
"""Check LaTeX/[@key] citations against a BibTeX file. No third-party dependencies."""
import argparse
import re
from pathlib import Path

ENTRY_RE = re.compile(r'@\w+\s*\{\s*([^,]+),([\s\S]*?)\n\}', re.MULTILINE)
FIELD_RE = re.compile(r'(\w+)\s*=\s*[{\"]([\s\S]*?)[}\"]\s*,?', re.MULTILINE)


def parse_bib(text: str):
    entries = {}
    for match in ENTRY_RE.finditer(text):
        key = match.group(1).strip()
        body = match.group(2)
        fields = {name.lower(): value.strip() for name, value in FIELD_RE.findall(body)}
        entries[key] = fields
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('manuscript')
    parser.add_argument('bib')
    args = parser.parse_args()
    manuscript = Path(args.manuscript)
    bib_path = Path(args.bib)
    if not manuscript.exists() or not bib_path.exists():
        print('ERROR: manuscript or bib file missing')
        return 2
    text = manuscript.read_text(encoding='utf-8', errors='replace')
    entries = parse_bib(bib_path.read_text(encoding='utf-8', errors='replace'))
    cited = set()
    for match in re.finditer(r'\\cite[tp]?\{([^}]+)\}', text):
        cited.update(part.strip() for part in match.group(1).split(',') if part.strip())
    for match in re.finditer(r'\[@([^\]]+)\]', text):
        cited.update(part.strip().split()[0] for part in match.group(1).split(';') if part.strip())
    missing = sorted(cited - set(entries))
    unused = sorted(set(entries) - cited)
    issues = []
    for key in missing:
        issues.append(f'missing bib entry: {key}')
    for key in unused:
        issues.append(f'unused bib entry: {key}')
    for key, fields in entries.items():
        if not fields.get('title'):
            issues.append(f'{key}: missing title')
        if not fields.get('author'):
            issues.append(f'{key}: missing author')
        if not (fields.get('year') or fields.get('date')):
            issues.append(f'{key}: missing year')
    for issue in issues:
        print(issue)
    print(f'cited={len(cited)} entries={len(entries)} missing={len(missing)} unused={len(unused)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
