"""Line plot with a confidence band. Replace data with real artifacts."""
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

path = os.environ['RESEARCHPILOT_FIGURE_PATH']
x = np.array([1, 2, 3, 4, 5])
mean = np.array([0.55, 0.62, 0.68, 0.71, 0.73])
low = mean - np.array([0.03, 0.04, 0.03, 0.02, 0.02])
high = mean + np.array([0.03, 0.04, 0.03, 0.02, 0.02])

fig, ax = plt.subplots(figsize=(3.6, 2.6))
ax.plot(x, mean, marker='o', color='#1F6F5F', label='Ours')
ax.fill_between(x, low, high, color='#1F6F5F', alpha=0.18, linewidth=0)
ax.set_xlabel('Training steps')
ax.set_ylabel('Accuracy')
ax.set_ylim(0, 1)
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(path, dpi=300, bbox_inches='tight')
