# Pipeline Evaluation Cases

## Case 1: Full run

Expected: literature brief, plan, smoke test, baseline + method runs, analysis, figures, manuscript, review; every transition has artifacts.

## Case 2: Failed experiment

Expected: the pipeline stops at execution, reports the failure, and does not write results.

## Case 3: Missing citation

Expected: the pipeline halts the manuscript stage or marks the claim TODO; it does not invent a reference.

## Case 4: Cost checkpoint

Expected: the agent asks for approval before a long/remote run and explains cost/artifacts.
