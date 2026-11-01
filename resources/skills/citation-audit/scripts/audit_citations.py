#!/usr/bin/env python3
"""Audit local citation keys and manually reviewed claim-source mappings. No network access."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def audit(manuscript, references, claims):
    blockers, warnings, index = [], [], {}
    for reference in references:
        keys = [reference.get('id'), reference.get('citekey')]
        match = re.search(r'@\w+\s*\{\s*([^,\s]+)', reference.get('bibtex', ''))
        if match:
            keys.append(match.group(1))
        for key in filter(None, keys):
            if key in index and index[key] is not reference:
                blockers.append(f'Ambiguous local reference key: {key}')
            index[key] = reference
    keys = set(re.findall(r'\[@([\w:./-]+)', manuscript))
    for match in re.findall(r'\\cite\w*\*?(?:\[[^\]]*\])*\{([^}]+)\}', manuscript):
        keys.update(key.strip() for key in match.split(','))
    if not keys:
        warnings.append('No supported citation syntax detected; numeric and author-date citations require manual review')
    for key in sorted(keys):
        if key not in index:
            blockers.append(f'Unresolved citation: {key}')
    if not claims:
        blockers.append('No claim-source mappings supplied; citation support has not been reviewed')
    reviewed = []
    for i, claim in enumerate(claims, 1):
        source = index.get(claim.get('sourceId'))
        text, quote = claim.get('claim', ''), claim.get('quote', '')
        if not source:
            blockers.append(f'Claim {i}: unknown local sourceId')
        if not text or text not in manuscript:
            blockers.append(f'Claim {i}: exact claim text is not present in manuscript')
        if not quote or not claim.get('locator') or claim.get('supportReviewed') is not True:
            blockers.append(f'Claim {i}: quote, page/section locator and human support review required')
        if source and not (source.get('doi') or source.get('url') or source.get('pdfRelativePath')):
            blockers.append(f'Claim {i}: no retrievable source locator in local reference')
        reviewed.append({'claim': text, 'sourceId': claim.get('sourceId'), 'supportReviewed': claim.get('supportReviewed') is True})
    warnings.append('Local matching cannot establish authenticity, retractions, quote accuracy or that every factual claim was mapped; review these explicitly')
    return {'version': 1, 'status': 'blocked' if blockers else 'passed', 'blockers': blockers, 'warnings': warnings,
            'citationKeys': sorted(keys), 'claims': reviewed, 'manuscriptSha256': hashlib.sha256(manuscript.encode()).hexdigest(), 'networkUsed': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('manuscript')
    p.add_argument('--references', required=True)
    p.add_argument('--claims', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    if Path(args.out).resolve() in {Path(name).resolve() for name in (args.manuscript, args.references, args.claims)}:
        p.error('Output must not overwrite inputs')
    report = audit(Path(args.manuscript).read_text(encoding='utf-8-sig'), json.loads(Path(args.references).read_text(encoding='utf-8-sig')), json.loads(Path(args.claims).read_text(encoding='utf-8-sig')))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(report['status'])
    return bool(report['blockers'])


if __name__ == '__main__':
    raise SystemExit(main())
