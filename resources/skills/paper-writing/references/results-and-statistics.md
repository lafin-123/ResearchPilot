# Results and Statistics

## Report the setup

For every comparison state:

- metric definition;
- dataset and split;
- number of seeds/repetitions;
- aggregation rule (mean, median, best);
- uncertainty (std, SEM, CI);
- compute and any early stopping.

## Uncertainty

Prefer mean +/- std or a confidence interval. If only one run exists, say so and avoid claims about robustness. For small n, a bootstrap interval can be more informative than a normal approximation.

## Effect size and practical significance

Report the size of the difference, not only a p-value. A tiny but statistically detectable difference may not matter.

## Multiple comparisons

If you test many conditions, say how you controlled error or label the analysis exploratory. Do not select the best-looking seed or metric after seeing the results.

## Causal language

Use causal language only when the design identifies a causal effect. Otherwise write "associated with", "predicts in this sample", or "under this setup".

## Tables and figures

- Match every number in the abstract and text.
- Include n and uncertainty in the caption.
- Keep decimal precision consistent with measurement precision.
- Mark missing or failed runs explicitly.
