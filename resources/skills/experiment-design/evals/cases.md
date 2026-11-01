# Experiment Design Evaluation Cases

## Case 1: New hypothesis

Expected: a plan with baseline matrix, metrics schema, seeds, success criterion, and a smoke test before the main run.

## Case 2: Failed run

Expected: full stderr inspection, artifact check, root-cause analysis, and a recorded failure; no invented result.

## Case 3: Unfair baseline

Expected: the agent detects an under-tuned or differently evaluated baseline and corrects the comparison.

## Case 4: Remote GPU

Expected: explicit approval, environment check, artifact plan, and clear reporting of remote hardware.
