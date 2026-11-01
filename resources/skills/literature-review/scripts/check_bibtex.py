#!/usr/bin/env python3
"""Check BibTeX entries for required fields and duplicate DOIs."""
import argparse
import re
from pathlib import Path

ENTRY_RE = re.compile(r'@\w+\s*\{\s*([^,]+),([\s\S]*?)\n\}', re.MULTILINE)
FIELD_RE = re.compile(r'(\w+)\s*=\s*[{\"]([\s\S]*?)[}\"]\s*,?', re.MULTILINE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('bib')
    args = parser.parse_args()
    path = Path(args.bib)
    if not path.exists():
        print('missing bib file')
        return 2
    text = path.read_text(encoding='utf-8', errors='replace')
    entries = []
    for match in ENTRY_RE.finditer(text):
        key = match.group(1).strip()
        fields = {name.lower(): value.strip() for name, value in FIELD_RE.findall(match.group(2))}
        entries.append((key, fields))
    issues = []
    dois = {}
    for key, fields in entries:
        for required in ('title', 'author', 'year'):
            if not fields.get(required):
                issues.append(f'{key}: missing {required}')
        doi = fields.get('doi', '').lower()
        if doi:
            dois.setdefault(doi, []).append(key)
    for doi, keys in dois.items():
        if len(keys) > 1:
            issues.append(f'duplicate DOI {doi}: {", ".join(keys)}')
    for issue in issues:
        print(issue)
    print(f'entries={len(entries)} issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
