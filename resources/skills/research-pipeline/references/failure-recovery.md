# Failure Recovery

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
