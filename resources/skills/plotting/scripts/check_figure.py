#!/usr/bin/env python3
"""Static checks for a matplotlib figure script."""
import argparse
import re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('script')
    args = parser.parse_args()
    path = Path(args.script)
    if not path.exists():
        print('script not found')
        return 2
    text = path.read_text(encoding='utf-8', errors='replace')
    issues = []
    for pattern, message in [
        (r'savefig', 'missing savefig'),
        (r'RESEARCHPILOT_FIGURE_PATH', 'missing RESEARCHPILOT_FIGURE_PATH'),
        (r'set_xlabel|set_ylabel', 'missing axis labels'),
        (r'dpi\s*=', 'missing explicit dpi'),
        (r'figsize', 'missing explicit figsize'),
        (r'legend\(', 'missing legend (check if needed)'),
        (r'plt\.style\.use|rcParams', 'no explicit style file'),
    ]:
        if not re.search(pattern, text):
            issues.append(message)
    if re.search(r'plt\.(bar|plot|scatter)\([^)]*\d+\.\d+', text) and 'metrics.json' not in text and 'np.load' not in text:
        issues.append('possible hard-coded data; load from artifacts')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
