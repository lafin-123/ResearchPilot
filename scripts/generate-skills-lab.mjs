import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const files = {}

files['experiment-design/SKILL.md'] = `---
name: experiment-design
description: Design, implement, run and analyze reproducible experiments for a ResearchPilot project. Use for hypotheses, protocols, baselines, metrics, seeds, ablations, local or SSH execution, and evidence-grade result analysis.
whenToUse: After a research question and gap exist. Use before writing any paper section that depends on empirical results.
user-invocable: true
---

# Experiment Design and Execution

The experiment is the source of truth. A beautiful manuscript with no run behind its numbers is a failure.

## Non-negotiables

- Define the success criterion before seeing results.
- Run fair baselines under identical conditions.
- Record seeds, sample size, environment, command, and artifacts.
- Report negative and failed results.
- Never fabricate a metric or hide a failed run.

## Resource map

Load only what the task needs:

- references/protocol-design.md
- references/baselines-and-metrics.md
- references/statistics-and-uncertainty.md
- references/reproducibility.md
- references/failure-analysis.md
- references/remote-ssh.md
- templates/experiment-plan.md
- templates/run-log.md
- templates/config.yaml
- templates/metrics-schema.json
- templates/baseline-matrix.csv
- templates/analysis-report.md
- scripts/scaffold_experiment.py
- scripts/analyze_metrics.py
- scripts/check_run_manifest.py
- scripts/compare_runs.py
- evals/rubric.md and evals/cases.md

Paths are relative to this skill directory (project copies live under .agents/skills/experiment-design/).

## Workflow

### 1. Turn the gap into a falsifiable claim

Write:

- claim and null/alternative;
- independent and controlled variables;
- primary and secondary metrics;
- strongest baselines, including a naive/simple one;
- datasets and splits, with leakage risks;
- seeds/repetitions;
- compute budget;
- success criterion decided in advance.

If the criterion is fuzzy, stop and ask.

### 2. Design the protocol

Use references/protocol-design.md and references/baselines-and-metrics.md. Create:

- experiments/plan.md from templates/experiment-plan.md;
- a baseline matrix from templates/baseline-matrix.csv;
- a config from templates/config.yaml;
- a metrics schema from templates/metrics-schema.json.

Keep the first experiment small enough for a smoke test that finishes in under two minutes.

### 3. Implement and smoke-test

Use scripts/scaffold_experiment.py if the workspace is empty. The code must:

- write all outputs under RESEARCHPILOT_RUN_DIR;
- emit metrics as JSON lines prefixed RESEARCHPILOT_METRIC:;
- write metrics.json and a run manifest;
- print package versions and seeds;
- fail loudly instead of swallowing errors.

Run a smoke test before the full study:

~~~powershell
research exps create --name "Smoke test" --code-file .agents/skills/experiment-design/templates/bar_with_error.py
research exps run --id <experiment-id> --timeout 60
~~~

### 4. Run the main study

~~~powershell
research exps list
research exps create --name "Main experiment" --code-file experiments/<study>/main.py
research exps run --id <experiment-id> --timeout 3600
~~~

Every remote or expensive run requires approval. Capture the run ID and artifact path. Do not launch several unapproved expensive runs at once.

### 5. Analyze

Run:

~~~powershell
uv run --no-project --python 3.12 python .agents/skills/experiment-design/scripts/analyze_metrics.py experiments/<study>/runs/<run-id>
uv run --no-project --python 3.12 python .agents/skills/experiment-design/scripts/check_run_manifest.py experiments/<study>/runs/<run-id>
~~~

Write exports/analysis.md using templates/analysis-report.md. Compare against baselines, quantify uncertainty, run ablations/robustness checks, and record failures.

### 6. Handoff

Provide:

- run IDs;
- command/environment;
- n and seeds;
- metric values with uncertainty;
- baseline comparison;
- artifact path;
- supported/contradicted/unresolved hypotheses.

## Quality gates

- [ ] Success criterion defined before the run.
- [ ] Baselines run under the same conditions.
- [ ] Seeds and repetitions recorded.
- [ ] Test set untouched during tuning.
- [ ] Metrics trace to a run ID.
- [ ] Failed runs reported.
- [ ] Artifacts exist under the run directory.
- [ ] Claims match the evidence.

## Failure modes

- A full study before a smoke test.
- Comparing against an under-tuned baseline.
- Reporting only the best seed.
- Using the test set for model selection.
- Treating a missing metric as zero.
- Installing huge dependencies without checking compute/network limits.
`

files['experiment-design/references/protocol-design.md'] = `# Protocol Design

## Operationalization

Turn each construct into a measurable variable. For every metric define:

- the computation;
- the aggregation;
- the sample size;
- the uncertainty;
- the direction that counts as better.

## Controls

Keep everything else fixed:

- data and split;
- preprocessing;
- tuning budget;
- hardware;
- evaluation script;
- random seeds where possible.

If a variable cannot be controlled, record it as a threat to validity.

## Power and repetitions

Decide how many seeds/repetitions are feasible. With few seeds, report uncertainty and avoid strong generalization claims. Use more repetitions for noisy metrics.

## Ablations

Plan at least one ablation that isolates the mechanism or component claimed to matter. Include a simple baseline that a skeptical reader would ask for.

## Pre-registration

Before running, save the plan, success criterion, and analysis rule. This prevents changing the metric after seeing results.
`

files['experiment-design/references/baselines-and-metrics.md'] = `# Baselines and Metrics

## Fair baselines

A baseline must be:

- implemented and run by you under the same data/evaluation protocol;
- tuned within a comparable budget;
- reported with the same seeds and uncertainty;
- named explicitly, including its version.

Include a simple/naive baseline and, when available, a strong published baseline reproduced under your setup.

## Metrics

Choose a primary metric tied to the claim, plus secondary metrics for context. Define each one and avoid switching after seeing results. For classification/retrieval/generation tasks, report the metric that the field actually uses, plus a complementary metric if it reveals a tradeoff.

## Leakage

Check:

- train/validation/test overlap;
- preprocessing fit on the test set;
- hyperparameter selection on the test set;
- duplicated documents across splits;
- prompt/label leakage.

A fair comparison matters more than a large number.
`

files['experiment-design/references/statistics-and-uncertainty.md'] = `# Statistics and Uncertainty

## Report

- mean and standard deviation, or a confidence interval;
- n (seeds or samples);
- the aggregation rule;
- effect size;
- any test used and why.

## Small samples

With 3-5 seeds, a normal-approximation CI is fragile. Prefer reporting the raw values, mean/std, and a bootstrap interval; label it as exploratory.

## Multiple comparisons

If you test many conditions, say how you controlled error or label the analysis exploratory. Do not select the best seed or metric after seeing the results.

## Causality

Use causal language only with a design that identifies a causal effect. Otherwise report associations and scope the conclusion to the observed setup.

## Missing and failed runs

Never drop a failed run silently. Report it, explain it, and decide whether it is a valid failure or an implementation bug.
`

files['experiment-design/references/reproducibility.md'] = `# Reproducibility

Record:

- code path and version;
- package versions;
- dataset version/split;
- seeds;
- command;
- hardware and runtime;
- artifact directory;
- run ID;
- any unavailable component and why.

Write a run manifest next to the artifacts. A future reader should be able to rerun the core comparison without guessing.
`

files['experiment-design/references/failure-analysis.md'] = `# Failure Analysis

## Smoke test first

Verify imports, data access, output directory, metric emission, and a tiny baseline. A smoke test should fail fast and cheaply.

## Silent failures

Look for:

- empty metrics;
- NaN/Inf values;
- suspiciously identical numbers across seeds;
- missing artifact files;
- exceptions caught by a broad except;
- timeouts hidden inside a script.

## When a run fails

1. Read the full stderr and the run manifest.
2. Reproduce with a tiny configuration.
3. Check the environment and data path.
4. Fix the root cause; do not simply rerun and hope.
5. Record the failure and the fix.

A failed run can be a finding, but it is never evidence for a claim.
`

files['experiment-design/references/remote-ssh.md'] = `# Remote SSH Experiments

Before running:

- confirm the remote Python environment and dependencies;
- confirm the workspace path and disk space;
- confirm GPU availability if relevant;
- confirm the command and time limit;
- confirm what artifacts will be downloaded.

The bridge uploads the experiment folder, runs the command, and downloads the run directory. Keep the local code as the source of truth. Large datasets should be referenced by path, not copied blindly.

Report the remote host, Python version, hardware, and any environment differences.

Use explicit approval for remote commands and long runs. Do not assume a remote path exists or that a GPU is free.
`

files['experiment-design/templates/experiment-plan.md'] = `# Experiment Plan

## Claim

## Null/alternative

## Independent variables

## Controls

## Datasets and splits

## Baselines

| Baseline | Implementation/version | Tuning budget | Source |
|---|---|---|---|

## Metrics

| Metric | Definition | Direction | Primary? |
|---|---|---|---|

## Seeds and repetitions

## Compute budget

## Success criterion (before running)

## Ablations

## Risks and leakage checks

## Artifact plan

- run directory:
- expected files:
- manifest fields:
`

files['experiment-design/templates/run-log.md'] = `# Run Log

- Run ID:
- Experiment:
- Command:
- Environment:
- Seed(s):
- Started:
- Finished:
- Exit code:
- Metrics:
- Artifacts:
- Failures:
- Notes:
`

files['experiment-design/templates/config.yaml'] = `seed: 42
seeds: [42, 43, 44, 45, 46]
dataset:
  name: TODO
  split: TODO
baseline: TODO
method: TODO
metrics: [accuracy]
output_dir_env: RESEARCHPILOT_RUN_DIR
`

files['experiment-design/templates/metrics-schema.json'] = `{
  "primary_metric": "accuracy",
  "fields": {
    "accuracy": { "type": "number", "range": [0, 1], "direction": "higher" },
    "loss": { "type": "number", "direction": "lower" },
    "n": { "type": "integer", "minimum": 1 },
    "seed": { "type": "integer" }
  }
}
`

files['experiment-design/templates/baseline-matrix.csv'] = `condition,implementation,version,tuning_budget,seeds,primary_metric,secondary_metrics,status
naive,,none,0,5,,
published_baseline,,as_reported,paper budget,5,,
proposed,,matched,5,5,,
`

files['experiment-design/templates/analysis-report.md'] = `# Analysis

## Evidence inventory

| Run ID | Condition | Seeds | Primary metric | Uncertainty | Artifact |
|---|---|---|---|---|---|

## Primary comparison

## Secondary metrics and tradeoffs

## Ablations

## Robustness checks

## Failures and anomalies

## Supported / contradicted / unresolved claims

## Threats to validity
`

files['experiment-design/templates/bar_with_error.py'] = `"""Smoke-test example for ResearchPilot. Replace data with real artifacts."""
import json
import os

import numpy as np

RUN_DIR = os.environ.get('RESEARCHPILOT_RUN_DIR', '.')
labels = ['baseline', 'ours']
means = np.array([0.71, 0.78])
errors = np.array([0.02, 0.015])

result = {
    'primary_metric': 'accuracy',
    'labels': labels,
    'means': means.tolist(),
    'std': errors.tolist(),
    'n': 5,
}
print('RESEARCHPILOT_METRIC:' + json.dumps(result))
with open(os.path.join(RUN_DIR, 'metrics.json'), 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print('Smoke test complete')
`

files['experiment-design/scripts/scaffold_experiment.py'] = `#!/usr/bin/env python3
"""Create a minimal, reproducible experiment skeleton."""
import argparse
from pathlib import Path

MAIN = '''"""Experiment entry point. Replace with the real study."""
import json
import os
import random

import numpy as np

RUN_DIR = os.environ.get('RESEARCHPILOT_RUN_DIR', '.')
SEED = 42
random.seed(SEED)
np.random.seed(SEED)


def main() -> None:
    values = np.random.normal(size=200)
    result = {'metric': 'mean', 'value': float(values.mean()), 'n': int(values.size), 'seed': SEED}
    print('RESEARCHPILOT_METRIC:' + json.dumps(result))
    with open(os.path.join(RUN_DIR, 'metrics.json'), 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default='experiments/new-study')
    args = parser.parse_args()
    target = Path(args.dir)
    (target / 'runs').mkdir(parents=True, exist_ok=True)
    (target / 'main.py').write_text(MAIN, encoding='utf-8')
    (target / 'config.yaml').write_text('seed: 42\\nseeds: [42, 43, 44, 45, 46]\\n', encoding='utf-8')
    (target / 'README.md').write_text('# Experiment\\n\\n- Claim:\\n- Command:\\n- Env:\\n', encoding='utf-8')
    print(f'created {target}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['experiment-design/scripts/analyze_metrics.py'] = `#!/usr/bin/env python3
"""Summarize metrics from a ResearchPilot run directory using stdlib only."""
import argparse
import json
import random
from pathlib import Path
from statistics import mean, pstdev


def collect(path: Path):
    metrics = {}
    metrics_file = path / 'metrics.json'
    if metrics_file.exists():
        try:
            payload = json.loads(metrics_file.read_text(encoding='utf-8'))
            if isinstance(payload, dict):
                metrics.update(payload)
        except json.JSONDecodeError:
            print('warning: metrics.json is not valid JSON')
    for line in (path / 'stdout.txt').read_text(encoding='utf-8', errors='replace').splitlines() if (path / 'stdout.txt').exists() else []:
        if not line.startswith('RESEARCHPILOT_METRIC:'):
            continue
        try:
            payload = json.loads(line.split(':', 1)[1].strip())
            if isinstance(payload, dict):
                for key, value in payload.items():
                    metrics.setdefault(key, value)
        except json.JSONDecodeError:
            continue
    return metrics


def bootstrap_ci(values, iterations=2000, alpha=0.05):
    if len(values) < 2:
        return None
    rng = random.Random(42)
    means = []
    for _ in range(iterations):
        sample = [rng.choice(values) for _ in values]
        means.append(mean(sample))
    means.sort()
    low = means[int((alpha / 2) * len(means))]
    high = means[int((1 - alpha / 2) * len(means)) - 1]
    return low, high


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    path = Path(args.run_dir)
    if not path.exists():
        print('run directory not found')
        return 2
    metrics = collect(path)
    summary = {}
    for key, value in metrics.items():
        if isinstance(value, list) and value and all(isinstance(item, (int, float)) for item in value):
            values = [float(item) for item in value]
            summary[key] = {
                'n': len(values),
                'mean': mean(values),
                'std': pstdev(values),
                'ci95': bootstrap_ci(values),
            }
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            summary[key] = value
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print('# Metric Summary')
        for key, value in summary.items():
            if isinstance(value, dict):
                low, high = value['ci95'] or (float('nan'), float('nan'))
                print(f'- {key}: mean={value["mean"]:.6g} std={value["std"]:.6g} n={value["n"]} 95%CI=[{low:.6g}, {high:.6g}]')
            else:
                print(f'- {key}: {value}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['experiment-design/scripts/check_run_manifest.py'] = `#!/usr/bin/env python3
"""Check that a run directory contains the minimum reproducibility artifacts."""
import argparse
import json
from pathlib import Path

REQUIRED = ['metrics.json', 'manifest.json']


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir')
    args = parser.parse_args()
    path = Path(args.run_dir)
    if not path.exists():
        print('run directory not found')
        return 2
    issues = []
    for name in REQUIRED:
        if not (path / name).exists():
            issues.append(f'missing {name}')
    manifest_path = path / 'manifest.json'
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            for field in ('command', 'startedAt', 'status'):
                if not manifest.get(field):
                    issues.append(f'manifest missing {field}')
            if not manifest.get('seeds'):
                issues.append('manifest missing seeds')
        except json.JSONDecodeError:
            issues.append('manifest.json is not valid JSON')
    if (path / 'metrics.json').exists():
        try:
            json.loads((path / 'metrics.json').read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            issues.append('metrics.json is not valid JSON')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['experiment-design/scripts/compare_runs.py'] = `#!/usr/bin/env python3
"""Compare metrics across run directories."""
import argparse
import json
from pathlib import Path


def read_metrics(path: Path):
    file = path / 'metrics.json'
    if not file.exists():
        return {}
    try:
        payload = json.loads(file.read_text(encoding='utf-8'))
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        return {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('runs', nargs='+')
    args = parser.parse_args()
    rows = [(path, read_metrics(Path(path))) for path in args.runs]
    keys = sorted({key for _, metrics in rows for key in metrics})
    print('| run | ' + ' | '.join(keys) + ' |')
    print('|---|' + '|'.join(['---'] * len(keys)) + '|')
    for path, metrics in rows:
        print(f'| {path} | ' + ' | '.join(str(metrics.get(key, '')) for key in keys) + ' |')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['experiment-design/evals/rubric.md'] = `# Experiment Design Rubric

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Falsifiability | vague goal | claim stated | claim, null, and success criterion defined first |
| Baselines | none | weak | strong and simple baselines, matched budget |
| Metrics | ad hoc | defined | primary/secondary metrics with uncertainty |
| Reproducibility | missing | partial | seeds, env, command, manifest, artifacts |
| Analysis | point estimate | some comparison | uncertainty, ablations, failures, limitations |
| Honesty | overclaim | minor | calibrated to evidence |
`

files['experiment-design/evals/cases.md'] = `# Experiment Design Evaluation Cases

## Case 1: New hypothesis

Expected: a plan with baseline matrix, metrics schema, seeds, success criterion, and a smoke test before the main run.

## Case 2: Failed run

Expected: full stderr inspection, artifact check, root-cause analysis, and a recorded failure; no invented result.

## Case 3: Unfair baseline

Expected: the agent detects an under-tuned or differently evaluated baseline and corrects the comparison.

## Case 4: Remote GPU

Expected: explicit approval, environment check, artifact plan, and clear reporting of remote hardware.
`

files['plotting/SKILL.md'] = `---
name: plotting
description: Create publication-quality, evidence-backed figures from ResearchPilot experiment artifacts. Use for result plots, comparisons, ablations, error bars, and paper-ready captions.
whenToUse: After experiments have produced result files. Use before writing the Results section, and whenever the user asks to visualize or improve a figure.
user-invocable: true
---

# Publication Plotting

A figure must make one claim obvious and honest. It must be reproducible from artifacts.

## Non-negotiables

- Never invent or typo data. Read metrics/artifacts from a specific run ID or file.
- Show uncertainty when repetitions exist; state n.
- Label axes with quantity and unit.
- Use colorblind-safe palettes and readable fonts.
- Save vector formats for LaTeX and high-resolution raster for DOCX when possible.
- Captions are self-contained and do not overclaim.

## Resource map

- references/figure-selection.md
- references/uncertainty.md
- references/color-and-accessibility.md
- references/captions-and-layout.md
- references/common-pitfalls.md
- templates/pub.mplstyle
- templates/bar_with_error.py
- templates/line_with_ci.py
- templates/scatter_with_fit.py
- templates/caption.md
- templates/figure-checklist.md
- scripts/check_figure.py
- assets/palette.json
- evals/rubric.md and evals/cases.md

Paths are relative to this skill directory (project copies live under .agents/skills/plotting/).

## Workflow

### 1. Read the data

~~~powershell
research exps logs --id <experiment-id>
~~~

Read metrics.json and result files inside the run directory. Record the run ID behind the figure.

### 2. Choose the figure

Use references/figure-selection.md. One figure should answer one question:

- comparison -> bar/dot plot with uncertainty;
- trend -> line plot with CI band;
- distribution -> box/violin/strip;
- relationship -> scatter with an appropriate fit;
- ablation -> grouped comparison, not a 3D chart.

### 3. Write the script

Start from templates/bar_with_error.py, line_with_ci.py, or scatter_with_fit.py. Use templates/pub.mplstyle and assets/palette.json. Save to RESEARCHPILOT_FIGURE_PATH. Do not hard-code paper numbers; load real data.

### 4. Lint before rendering

~~~powershell
uv run --no-project --python 3.12 python .agents/skills/plotting/scripts/check_figure.py figures/<script>.py
~~~

Fix missing labels, legends, save paths, DPI, and font sizes.

### 5. Render through the bridge

~~~powershell
research figs render --name "Main accuracy comparison" --code-file figures/accuracy.py --experiment-id <experiment-id> --caption "Accuracy on ... (mean +/- std over 5 seeds)."
~~~

Rendering requires user approval. The figure is registered in the project gallery.

### 6. Caption

Use templates/caption.md. Include what is shown, dataset/condition, n, metric, uncertainty, and the one takeaway.

## Quality gates

- [ ] Data traces to a run ID/artifact.
- [ ] n, seeds, and aggregation stated.
- [ ] Axes labeled with units.
- [ ] Uncertainty shown.
- [ ] Colorblind-safe and grayscale-readable.
- [ ] Vector and high-resolution versions saved when possible.
- [ ] Caption is self-contained.
`

files['plotting/references/figure-selection.md'] = `# Figure Selection

| Goal | Prefer | Avoid |
|---|---|---|
| Compare conditions | bar/dot with error bars | 3D bars |
| Show a trend | line with CI band | disconnected scatter |
| Show a distribution | box/violin + strip | bar of means only |
| Show a relationship | scatter with fit and CI | overplotted points |
| Show an ablation | grouped bars/dot plot | pie chart |
| Show a matrix | heatmap with a colorbar | rainbow colormap |

If the data has repeated measures, show the pairing or the distribution rather than only the aggregate mean.
`

files['plotting/references/uncertainty.md'] = `# Uncertainty

- Report what the error bars represent: std, SEM, CI, or min-max.
- State n in the caption.
- With few seeds, a CI can be unstable; consider showing individual points.
- Do not hide variance by plotting only the best run.
- For paired comparisons, consider showing per-seed deltas.
- If a bar has no uncertainty, explain why.
`

files['plotting/references/color-and-accessibility.md'] = `# Color and Accessibility

- Use a colorblind-safe palette (see assets/palette.json).
- Do not encode the same information only by hue; add markers, line styles, or labels.
- Keep grayscale contrast readable.
- Use a white background for the document; avoid transparent figures that become unreadable in print.
- Avoid rainbow/jet colormaps for ordered data; use perceptually uniform maps.
- Keep font sizes at least 8 pt at final column width.
`

files['plotting/references/captions-and-layout.md'] = `# Captions and Layout

A caption should let a reader understand the figure without the body text:

1. What is shown.
2. Dataset/condition and n.
3. Metric definition.
4. Error bars/uncertainty.
5. The takeaway, without causal overclaim.

Layout:

- Use a single-column width around 3.3 inches or a double-column width around 7 inches.
- Avoid chartjunk, heavy gridlines, and unnecessary legends.
- Put units on axes.
- Keep decimal precision consistent.
- Refer to every panel in the text.
`

files['plotting/references/common-pitfalls.md'] = `# Common Pitfalls

- Truncated y-axis exaggerating a difference.
- Bar chart of means without uncertainty.
- Using the test set to select the best-looking figure.
- Connecting unrelated categorical conditions with a line.
- Overplotting thousands of points without transparency or aggregation.
- A legend that repeats the x-axis labels.
- A caption that claims causality not supported by the design.
- A figure that cannot be reproduced from the saved script and data.
`

files['plotting/templates/pub.mplstyle'] = `figure.dpi: 300
savefig.dpi: 300
savefig.bbox: tight
savefig.facecolor: white
font.family: DejaVu Sans
font.size: 9
axes.titlesize: 10
axes.labelsize: 9
xtick.labelsize: 8
ytick.labelsize: 8
legend.fontsize: 8
axes.spines.top: false
axes.spines.right: false
axes.grid: true
grid.alpha: 0.18
grid.linewidth: 0.5
lines.linewidth: 1.4
`

files['plotting/templates/bar_with_error.py'] = `"""Bar comparison with uncertainty. Replace values with real artifacts."""
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

plt.style.use('.agents/skills/plotting/templates/pub.mplstyle')
fig, ax = plt.subplots(figsize=(3.4, 2.6))
ax.bar(labels, means, yerr=errors, capsize=3, color=['#8C9A93', '#1F6F5F'])
ax.set_ylabel('Accuracy')
ax.set_ylim(0, 1)
ax.set_title(f'n={n} seeds; error bars = std')
fig.tight_layout()
fig.savefig(path, dpi=300, bbox_inches='tight')
print(json.dumps({'labels': labels, 'means': means.tolist(), 'std': errors.tolist(), 'n': n}))
`

files['plotting/templates/line_with_ci.py'] = `"""Line plot with a confidence band. Replace data with real artifacts."""
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
`

files['plotting/templates/scatter_with_fit.py'] = `"""Scatter with a simple fit. Replace data with real artifacts."""
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
`

files['plotting/templates/caption.md'] = `Figure X: TODO what is shown, on which dataset/condition, with n and what the error bars represent. TODO metric definition. TODO one-sentence takeaway that does not overclaim causality.
`

files['plotting/templates/figure-checklist.md'] = `# Figure Checklist

- [ ] Data loaded from a run artifact, not hard-coded.
- [ ] One clear question.
- [ ] Axis labels and units.
- [ ] n and uncertainty stated.
- [ ] Colorblind-safe.
- [ ] Grayscale-readable.
- [ ] Font size legible at final width.
- [ ] Save path uses RESEARCHPILOT_FIGURE_PATH.
- [ ] Caption self-contained.
- [ ] Script saved for reproduction.
`

files['plotting/scripts/check_figure.py'] = `#!/usr/bin/env python3
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
        (r'dpi\\s*=', 'missing explicit dpi'),
        (r'figsize', 'missing explicit figsize'),
        (r'legend\\(', 'missing legend (check if needed)'),
        (r'plt\\.style\\.use|rcParams', 'no explicit style file'),
    ]:
        if not re.search(pattern, text):
            issues.append(message)
    if re.search(r'plt\\.(bar|plot|scatter)\\([^)]*\\d+\\.\\d+', text) and 'metrics.json' not in text and 'np.load' not in text:
        issues.append('possible hard-coded data; load from artifacts')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['plotting/assets/palette.json'] = `{
  "colorblind_safe": ["#1F6F5F", "#8C9A93", "#2457C5", "#946200", "#7A4EAB", "#B42318"],
  "diverging": ["#2457C5", "#8C9A93", "#946200"],
  "sequential": ["#E7F5EE", "#7EE2A8", "#137A4B", "#0B3D24"]
}
`

files['plotting/evals/rubric.md'] = `# Plotting Rubric

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Data integrity | invented data | partly traced | every value traces to a run artifact |
| Uncertainty | none | some bars | n, uncertainty, and aggregation defined |
| Encoding | misleading | readable | appropriate chart and axes |
| Accessibility | color-only | some contrast | colorblind-safe and grayscale-readable |
| Caption | missing | partial | self-contained and calibrated |
| Reproducibility | image only | script saved | script + data path + run ID |
`

files['plotting/evals/cases.md'] = `# Plotting Evaluation Cases

## Case 1: Comparison figure

Expected: data from a run, error bars with n, labeled axes, colorblind-safe palette, saved script, caption.

## Case 2: Missing data

Expected: the agent stops and reports the missing artifact rather than inventing values.

## Case 3: Overplotted scatter

Expected: transparency/aggregation, no false trend claim, and an appropriate caption.

## Case 4: Paper-ready figure

Expected: vector/PDF export when requested, font size checked, caption traceable to the run.
`

files['research-pipeline/SKILL.md'] = `---
name: research-pipeline
description: Orchestrate the experiment-first ResearchPilot pipeline across literature, hypothesis, experiment, analysis, figures, manuscript and review. Use when running a multi-stage research project or when the user asks for full automation.
whenToUse: The user asks to run the whole research workflow, continue a pipeline, or coordinate multiple specialist skills. Also use at stage boundaries to decide the next action.
user-invocable: true
---

# Research Pipeline

The default order is experiment before paper. Do not jump to a manuscript because writing is easier than running the study.

## Stages

1. Literature: scope, screen, synthesize, save references/research-brief.md.
2. Hypothesis: falsifiable claims, baselines, metrics, success criteria, risks.
3. Experiment design: protocol, smoke test code, experiment plan.
4. Experiment execution: create/run experiments, capture run IDs, logs, metrics, artifacts.
5. Analysis: compare baselines, quantify uncertainty, ablations, failures.
6. Figures/tables: publication-quality figures from run artifacts.
7. Manuscript: DOCX and/or LaTeX from the claims-evidence map.
8. Review: audit claims, citations, numbers, reproducibility, limitations; revise.

## Resource map

- references/stage-contracts.md
- references/checkpoints-and-approvals.md
- references/artifact-manifest.md
- references/automation.md
- references/failure-recovery.md
- templates/stage-handoff.md
- templates/pipeline-summary.md
- templates/artifact-manifest.json
- templates/stage-prompts.md
- templates/review-gate.md
- scripts/check_pipeline.py
- scripts/summarize_pipeline.py
- scripts/next_stage.py
- evals/rubric.md and evals/cases.md

Paths are relative to this skill directory (project copies live under .agents/skills/research-pipeline/).

## Artifact contract

- references/research-brief.md
- experiments/plan.md
- experiments/<study>/main.py and runs/<run-id>/
- exports/experiment-log.md
- exports/analysis.md
- figures/
- manuscripts/
- exports/pipeline-summary.md

## Workflow

### 1. Start with the evidence inventory

Check what already exists. Do not rerun a stage whose artifacts are present unless the user asks. Use scripts/check_pipeline.py.

### 2. Stage transitions

At each boundary:

- verify the required artifacts exist;
- write a handoff using templates/stage-handoff.md;
- update exports/pipeline-summary.md;
- state the next stage and any unresolved risks.

### 3. Checkpoints

Pause for approval before:

- expensive/local or remote runs;
- changing the primary metric or success criterion;
- deleting artifacts;
- making a claim that cannot be traced to a run/citation;
- sending data to an external service.

### 4. Automation behavior

When asked to run everything:

1. Summarize the plan and checkpoints.
2. Complete literature and hypothesis first and save artifacts.
3. Run a smoke experiment, then scale.
4. Continue only when the current stage produced verifiable artifacts.
5. Stop at approvals, failures, or contradictory evidence.
6. Finish with a review pass and a list of unverified claims.

### 5. Failure handling

If a stage fails, report the exact failure and remain at that stage. Never skip a failed experiment to write results. See references/failure-recovery.md.

### 6. Final audit

~~~powershell
uv run --no-project --python 3.12 python .agents/skills/research-pipeline/scripts/check_pipeline.py
uv run --no-project --python 3.12 python .agents/skills/research-pipeline/scripts/summarize_pipeline.py
~~~

## Quality gates

- [ ] Every run referenced exists and completed.
- [ ] Every number traces to a run artifact.
- [ ] Every citation is real and in the library.
- [ ] Negative and failed results are reported.
- [ ] The manuscript states limitations.
- [ ] The summary lists verified, uncertain, and unverified work.

## Failure modes

- Writing the paper before running the experiment.
- Advancing a stage because a file exists but is empty.
- Treating a generic model response as an experiment result.
- Losing artifacts between stages.
- Silence about a failed run.
`

files['research-pipeline/references/stage-contracts.md'] = `# Stage Contracts

## Literature

Inputs: topic, constraints.
Outputs: references/research-brief.md, evidence matrix, search/screening logs.
Gate: gap is falsifiable; baselines/metrics named.

## Hypothesis

Inputs: research brief.
Outputs: experiments/plan.md with claims, nulls, success criteria.
Gate: criteria defined before results.

## Experiment design

Inputs: plan.
Outputs: experiment code, config, smoke-test run ID.
Gate: smoke test passes and artifacts exist.

## Experiment execution

Inputs: design.
Outputs: run IDs, metrics, logs, artifacts.
Gate: baselines and proposed method run under matched conditions.

## Analysis

Inputs: runs.
Outputs: exports/analysis.md, claims-evidence table.
Gate: uncertainty, ablations, failures, and limitations addressed.

## Figures

Inputs: analysis and artifacts.
Outputs: figure records, scripts, captions.
Gate: each figure traces to a run ID and has a caption.

## Manuscript

Inputs: brief, plan, analysis, figures, library.
Outputs: DOCX and/or LaTeX document IDs.
Gate: claims map complete; citations verified; compile/DOCX check.

## Review

Inputs: manuscript.
Outputs: exports/review-report.md, revision.
Gate: no P0 findings; unresolved risks reported.
`

files['research-pipeline/references/checkpoints-and-approvals.md'] = `# Checkpoints and Approvals

Require explicit approval for:

- any remote/SSH command;
- any experiment run expected to take more than a few minutes;
- changing the primary metric, success criterion, or dataset split;
- deleting experiments, documents, references, or figures;
- using a new external service or uploading data;
- making a central claim with weak evidence.

A checkpoint is not a formality. State what will happen, the cost, the artifacts that will be produced, and the rollback plan. If approval is denied, stop and offer alternatives.
`

files['research-pipeline/references/artifact-manifest.md'] = `# Artifact Manifest

Keep one machine-readable manifest per pipeline (exports/artifact-manifest.json):

- project id;
- stage statuses;
- research brief path;
- experiment IDs and run IDs;
- analysis path;
- figure IDs and source run IDs;
- manuscript document IDs;
- unresolved TODOs and unverified claims.

Update it at every stage boundary. Scripts and the UI can use it to detect missing artifacts.
`

files['research-pipeline/references/automation.md'] = `# Automation

Full automation is a sequence of verified transitions, not a single prompt.

Rules:

- run a smoke test before scaling;
- never advance on an empty or failed artifact;
- keep a durable summary after every stage;
- pause at approvals;
- prefer small runs over one giant unreproducible run;
- make failures visible;
- if a stage loops or stalls, stop and report the exact state.

Automation must not turn "no result" into "plausible result".
`

files['research-pipeline/references/failure-recovery.md'] = `# Failure Recovery

## Classification

- environment: missing Python/package/GPU;
- data: missing file, wrong split, corruption;
- code: exception, silent failure, timeout;
- method: invalid assumption, unfair baseline;
- evidence: result contradicts the hypothesis;
- budget: run too expensive.

## Response

1. Capture the error and artifact state.
2. Stop dependent stages.
3. Fix the root cause, not the symptom.
4. Rerun the smallest verification.
5. Update the artifact manifest and pipeline summary.
6. Report the remaining uncertainty.

Never "recover" by inventing a result or skipping the failed run.
`

files['research-pipeline/templates/stage-handoff.md'] = `# Stage Handoff

- Stage:
- Status: completed / failed / blocked
- Inputs used:
- Outputs produced:
- Evidence (run IDs / DOIs / paths):
- Metrics with uncertainty:
- Failures:
- Open questions:
- Next stage:
- Approvals needed:
`

files['research-pipeline/templates/pipeline-summary.md'] = `# Pipeline Summary

## Topic

## Stage status

| Stage | Status | Artifacts | Evidence |
|---|---|---|---|

## Verified results

| Claim | Run ID | Metric | Uncertainty |
|---|---|---|---|

## Unverified / TODO

## Failures and negative results

## Next checkpoint
`

files['research-pipeline/templates/artifact-manifest.json'] = `{
  "projectId": "",
  "topic": "",
  "stages": {},
  "experiments": [],
  "runs": [],
  "figures": [],
  "manuscripts": [],
  "unverifiedClaims": []
}
`

files['research-pipeline/templates/stage-prompts.md'] = `# Stage Prompt Patterns

## Literature

Load literature-review. Define scope, search, screen, synthesize, and save references/research-brief.md. Return a concise handoff.

## Hypothesis

Load experiment-design. Turn the brief into falsifiable claims, baselines, metrics, seeds, success criteria, and risks. Save experiments/plan.md.

## Design

Implement a smoke test and create the experiment through the bridge. Verify artifacts.

## Execute

Run matched baselines and methods. Record run IDs and artifacts. Do not write claims yet.

## Analysis

Compare against baselines, quantify uncertainty, run ablations, and report failures. Save exports/analysis.md.

## Figures

Load plotting. Create publication-quality figures from run artifacts, with captions and source IDs.

## Manuscript

Load paper-writing. Build the claims-evidence map, write DOCX/LaTeX, verify citations and numbers, and compile.

## Review

Audit every claim, number, citation, and limitation. Write exports/review-report.md and revise.
`

files['research-pipeline/templates/review-gate.md'] = `# Review Gate

- [ ] Run IDs exist for every empirical claim.
- [ ] Baselines are fair.
- [ ] Uncertainty and n are reported.
- [ ] Citations exist and support their sentences.
- [ ] Failures and negative results are visible.
- [ ] Limitations are specific.
- [ ] Manuscript compiles or DOCX opens.
- [ ] Artifact manifest is current.
`

files['research-pipeline/scripts/check_pipeline.py'] = `#!/usr/bin/env python3
"""Check the minimum artifact set for an experiment-first pipeline."""
import argparse
from pathlib import Path

REQUIRED = [
    'references/research-brief.md',
    'experiments/plan.md',
    'exports/analysis.md',
    'exports/pipeline-summary.md',
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    issues = []
    for relative in REQUIRED:
        path = root / relative
        if not path.exists():
            issues.append(f'missing {relative}')
        elif path.stat().st_size < 20:
            issues.append(f'empty {relative}')
    figures = list((root / 'figures').glob('*/*')) if (root / 'figures').exists() else []
    if not figures:
        issues.append('no figure artifacts')
    manuscripts = list((root / 'manuscripts').glob('*')) if (root / 'manuscripts').exists() else []
    if not manuscripts:
        issues.append('no manuscript files')
    for issue in issues:
        print(issue)
    print(f'issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['research-pipeline/scripts/summarize_pipeline.py'] = `#!/usr/bin/env python3
"""Create a concise Markdown pipeline summary from artifacts."""
import argparse
from pathlib import Path

FILES = [
    ('Research brief', 'references/research-brief.md'),
    ('Experiment plan', 'experiments/plan.md'),
    ('Analysis', 'exports/analysis.md'),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    lines = ['# Pipeline Summary', '']
    for label, relative in FILES:
        path = root / relative
        lines.append(f'## {label}')
        lines.append('')
        if path.exists():
            lines.append(path.read_text(encoding='utf-8', errors='replace')[:4000])
        else:
            lines.append('MISSING: ' + relative)
        lines.append('')
    output = root / 'exports' / 'pipeline-summary.md'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
    print(f'wrote {output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['research-pipeline/scripts/next_stage.py'] = `#!/usr/bin/env python3
"""Suggest the next incomplete pipeline stage from artifact presence."""
import argparse
from pathlib import Path

STAGES = [
    ('literature', 'references/research-brief.md'),
    ('hypothesis', 'experiments/plan.md'),
    ('analysis', 'exports/analysis.md'),
    ('figures', 'figures'),
    ('manuscript', 'manuscripts'),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', nargs='?', default='.')
    args = parser.parse_args()
    root = Path(args.project)
    for stage, relative in STAGES:
        path = root / relative
        if not path.exists() or (path.is_file() and path.stat().st_size < 20):
            print(stage)
            return 0
    print('review')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['research-pipeline/evals/rubric.md'] = `# Pipeline Rubric

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Stage order | paper first | some order | experiment-first and gated |
| Artifacts | missing | partial | every stage has a verifiable artifact |
| Handoff | none | informal | structured handoff with evidence |
| Approvals | skipped | inconsistent | explicit at costly/risky steps |
| Failure handling | hidden | noted | classified, contained, reported |
| Final audit | none | partial | claims/run IDs/citations/limitations audited |
`

files['research-pipeline/evals/cases.md'] = `# Pipeline Evaluation Cases

## Case 1: Full run

Expected: literature brief, plan, smoke test, baseline + method runs, analysis, figures, manuscript, review; every transition has artifacts.

## Case 2: Failed experiment

Expected: the pipeline stops at execution, reports the failure, and does not write results.

## Case 3: Missing citation

Expected: the pipeline halts the manuscript stage or marks the claim TODO; it does not invent a reference.

## Case 4: Cost checkpoint

Expected: the agent asks for approval before a long/remote run and explains cost/artifacts.
`

const root = join('resources', 'skills')
let count = 0
for (const [relative, content] of Object.entries(files)) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  count += 1
}
console.log(`wrote ${count} files under ${root}`)
