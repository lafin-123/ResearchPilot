# Stage Contracts

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
