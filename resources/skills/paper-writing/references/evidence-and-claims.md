# Evidence and Claims

## Evidence hierarchy

Use the strongest evidence available, but state its limits.

1. Repeated, controlled experiments under identical conditions with uncertainty.
2. A single controlled run with clear seeds and artifacts.
3. Observational analysis of real artifacts.
4. A cited result from another paper.
5. A hypothesis or author intuition (label it clearly).

## Claim calibration

| Evidence | Allowed language | Avoid |
|---|---|---|
| Several seeds, fair baselines, CI | improves, is higher than, is associated with | proves, guarantees, universally |
| One run | in this run, under this setup | robust, general, state of the art |
| Observational | associated with, predicts in this sample | causes, leads to |
| Citation only | prior work reports | we show (unless you replicated it) |
| Hypothesis | we hypothesize, we expect | we demonstrate |

## Number traceability

Every empirical number needs a chain:

number -> table/figure cell -> run ID -> artifact file -> command/environment.

If any link is missing, write TODO: number from run <id> or remove the number.

## Negative and failed results

Report:

- what failed;
- the error or null result;
- what was ruled out;
- what the next test should be.

A paper that hides failures is less trustworthy, not more convincing.

## Claims-evidence map

Build it before drafting. Review it after every major revision. A claim with no evidence should be removed or explicitly labeled as a hypothesis.
