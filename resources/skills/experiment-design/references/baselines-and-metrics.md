# Baselines and Metrics

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
