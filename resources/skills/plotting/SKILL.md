---
name: plotting
description: Create publication-quality, evidence-backed figures from ResearchPilot experiment artifacts. Use for result plots, comparisons, ablations, error bars, and paper-ready captions.
whenToUse: After experiments have produced result files. Use before writing the Results section, and whenever the user asks to visualize or improve a figure.
user-invocable: true
---

# Publication Plotting

A figure must make one claim obvious and honest. It must be reproducible from artifacts.

## Native editable pipeline (takes precedence over legacy rendering examples below)

Read actual run values with artifact_read/experiment_runs. Construct an inline FigureSpec from those values and call figure_create_spec({spec,experimentId,name,caption}) after approval; exporter writes registered JSON, SVG and native editable PPTX without Python or shell. Follow editable-presentation schema and inspect via figure_inspect. Do not use CLI/matplotlib rendering for a native-editable gate. Schema does not support error bars/log axes; preserve uncertainty in explicitly labeled lower/upper interval series or accompanying exact tables, never silently omit it. State simulations as simulations, use actual run ID and artifact path in sourceLabel. Writing an SVG screenshot into PPTX does not qualify.

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
