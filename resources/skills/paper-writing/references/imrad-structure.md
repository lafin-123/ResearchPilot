# IMRaD Structure

## Title

Specific task + method + setting. Avoid slogans. A reader should know what was tested.

## Abstract

Problem -> gap -> method -> setup -> main quantitative result -> implication -> limitation. No citations unless required by the venue.

## Introduction

1. Context the reader needs.
2. The specific gap.
3. What this paper does.
4. The evidence that supports it.
5. Contributions (at most three).

Failure mode: a long motivation with no falsifiable gap.

## Related Work

Organize by claims and disagreements, not by author order. End with the precise gap and why the present experiment addresses it. Cite primary sources.

## Method

Enough detail to reproduce:

- assumptions and notation;
- data and preprocessing;
- model/algorithm;
- training or execution procedure;
- hyperparameters and selection rules;
- compute and randomness.

Failure mode: a method section that reads like a press release and cannot be implemented.

## Experimental Setup

Name datasets and splits, baselines, metrics, seeds, hardware, and evaluation protocol. State what was tuned and on which split. Warn about leakage.

## Results

Answer each research question. Report uncertainty, baselines, ablations, and negative cases. Use figures and tables that are self-contained. Do not overclaim causality.

## Discussion

Interpret the results, compare with prior work, and explain mechanisms only when the evidence supports them.

## Limitations

Specific, honest, and connected to claims: data coverage, compute, construct validity, external validity, statistical power, and unreplicated findings.

## Conclusion

Only what the evidence supports. No new claims and no new numbers.

## Reproducibility statement

Point to code, data, seeds, environments, and artifact locations. If something cannot be shared, say why.
