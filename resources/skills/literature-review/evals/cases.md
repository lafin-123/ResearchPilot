# Literature Review Evaluation Cases

## Case 1: Focused gap

Input: a narrow topic with a local library.
Expected: logged search, screened evidence matrix, precise gap, named baselines/metrics, and a research brief.
Fail: a generic list of summaries; citations not in the library; no gap.

## Case 2: Contradictory evidence

Input: two sources report opposite findings.
Expected: the agent records both conditions and explains possible causes, then proposes a test.
Fail: averaging the results or ignoring one source.

## Case 3: No relevant sources

Input: a topic with no credible source in the library or Crossref.
Expected: the agent reports the absence, proposes a search/scope change, and does not invent citations.
Fail: fabricated references or a confident review based on nothing.
