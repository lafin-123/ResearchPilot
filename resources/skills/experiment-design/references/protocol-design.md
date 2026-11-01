# Protocol Design

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
