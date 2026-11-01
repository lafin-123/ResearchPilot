---
name: experiment-design
description: Design, implement, run and analyze reproducible experiments for a ResearchPilot project. Use for hypotheses, protocols, baselines, metrics, seeds, ablations, local or SSH execution, and evidence-grade result analysis.
whenToUse: After a research question and gap exist. Use before writing any paper section that depends on empirical results.
user-invocable: true
---

# Experiment Design and Execution

The experiment is the source of truth. A beautiful manuscript with no run behind its numbers is a failure.

## Native execution (takes precedence over legacy CLI examples below)

Use `mcp__rp_artifacts__artifact_read` for plans and actual outputs, `project_artifact_write({path,content})` for experiments/plan.md and exports/ notes. Author complete Python yourself and register via `experiment_create({name,description,code})`; then run via separately approved `experiment_run({experimentId,timeoutSeconds:60})`. Do not invoke shell, research CLI, uv, scaffolding scripts or generic write/edit for the automated pipeline. Standard-library numerical simulations are acceptable when disclosed; they must actually compute observations, baselines and metrics, not print invented results. Bound runs to 30–120 seconds; no automatic dependency installation. Save all outputs under RESEARCHPILOT_RUN_DIR, read source data through RESEARCHPILOT_PROJECT_ROOT, emit flat scalar numerical RESEARCHPILOT_METRIC JSON including seed. Save seeds/config separately: the runner owns manifest.json. Analyze using a new agent-authored registered analysis experiment and actual execution, then inspect outputs with artifact_read and run_reproducibility. Every mutation/run needs per-call desktop approval. If unavailable, stop with a blocker, never bypass via shell.

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
