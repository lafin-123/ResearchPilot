#!/usr/bin/env python3
"""Verify explicit artifact hashes and rerun metadata without executing any command."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def verify(root, manifest):
    root = Path(root).resolve()
    blockers, checked = [], []
    for key in ('command', 'environment', 'samplingUnit'):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip() or 'TODO' in manifest[key]:
            blockers.append(f'Missing concrete {key}')
    if not isinstance(manifest.get('seeds'), list) or not manifest['seeds']:
        blockers.append('Declare seeds, or an explicit nondeterministic protocol in seeds')
    files = manifest.get('files')
    if not isinstance(files, list) or not files:
        blockers.append('No artifact files listed')
        files = []
    for item in files:
        try:
            name, expected = item['path'], item['sha256']
            if Path(name).is_absolute() or not re.fullmatch('[0-9a-f]{64}', expected):
                raise ValueError('Expected project-relative path and SHA-256')
            path = (root / name).resolve(strict=True)
            path.relative_to(root)
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError('Empty or non-file artifact')
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != expected:
                raise ValueError('Hash mismatch')
            checked.append({'path': name, 'sha256': actual})
        except (OSError, ValueError, KeyError, TypeError) as error:
            blockers.append(f'Invalid artifact {item}: {error}')
    return {'version': 1, 'status': 'blocked' if blockers else 'passed', 'blockers': blockers, 'checked': checked,
            'rerunExecuted': False, 'limits': 'Hash and metadata audit only. Rerun commands were not executed; reproducibility is not empirically established.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('manifest')
    p.add_argument('--root', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    if Path(args.manifest).resolve() == Path(args.out).resolve():
        p.error('Output must not overwrite input')
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8-sig'))
    report = verify(args.root, manifest)
    output = Path(args.out).resolve()
    if any((Path(args.root) / item.get('path', '')).resolve() == output for item in manifest.get('files', []) if isinstance(item, dict)):
        p.error('Output must not overwrite an audited artifact')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(report['status'])
    return bool(report['blockers'])


if __name__ == '__main__':
    raise SystemExit(main())
