# Automation

Full automation is a sequence of verified transitions, not a single prompt.

Rules:

- run a smoke test before scaling;
- never advance on an empty or failed artifact;
- keep a durable summary after every stage;
- pause at approvals;
- prefer small runs over one giant unreproducible run;
- make failures visible;
- if a stage loops or stalls, stop and report the exact state.

Automation must not turn "no result" into "plausible result".
