# Statistics and Uncertainty

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
