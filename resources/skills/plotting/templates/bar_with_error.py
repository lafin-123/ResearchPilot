"""Bar comparison with uncertainty. Replace values with real artifacts."""
import json
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

path = os.environ['RESEARCHPILOT_FIGURE_PATH']
labels = ['Baseline', 'Ours']
means = np.array([0.71, 0.78])
errors = np.array([0.020, 0.015])
n = 5

project_root = os.environ.get('RESEARCHPILOT_PROJECT_ROOT', '.')
style_path = os.path.join(project_root, '.agents/skills/plotting/templates/pub.mplstyle')
if os.path.exists(style_path):
    plt.style.use(style_path)
fig, ax = plt.subplots(figsize=(3.4, 2.6))
ax.bar(labels, means, yerr=errors, capsize=3, color=['#8C9A93', '#1F6F5F'])
ax.set_ylabel('Accuracy')
ax.set_ylim(0, 1)
ax.set_title(f'n={n} seeds; error bars = std')
fig.tight_layout()
fig.savefig(path, dpi=300, bbox_inches='tight')
print(json.dumps({'labels': labels, 'means': means.tolist(), 'std': errors.tolist(), 'n': n}))
