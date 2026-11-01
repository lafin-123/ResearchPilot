# Failure Analysis

## Smoke test first

Verify imports, data access, output directory, metric emission, and a tiny baseline. A smoke test should fail fast and cheaply.

## Silent failures

Look for:

- empty metrics;
- NaN/Inf values;
- suspiciously identical numbers across seeds;
- missing artifact files;
- exceptions caught by a broad except;
- timeouts hidden inside a script.

## When a run fails

1. Read the full stderr and the run manifest.
2. Reproduce with a tiny configuration.
3. Check the environment and data path.
4. Fix the root cause; do not simply rerun and hope.
5. Record the failure and the fix.

A failed run can be a finding, but it is never evidence for a claim.
