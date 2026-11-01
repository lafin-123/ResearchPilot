"""Scatter with a simple fit. Replace data with real artifacts."""
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

path = os.environ['RESEARCHPILOT_FIGURE_PATH']
x = np.random.default_rng(42).normal(size=80)
y = 0.7 * x + np.random.default_rng(43).normal(scale=0.4, size=80)
coef = np.polyfit(x, y, 1)
grid = np.linspace(x.min(), x.max(), 100)

fig, ax = plt.subplots(figsize=(3.4, 2.8))
ax.scatter(x, y, s=14, alpha=0.55, color='#2457C5', edgecolors='none')
ax.plot(grid, np.polyval(coef, grid), color='#946200', linewidth=1.6)
ax.set_xlabel('Predictor')
ax.set_ylabel('Outcome')
fig.tight_layout()
fig.savefig(path, dpi=300, bbox_inches='tight')
