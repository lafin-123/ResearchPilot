---
name: literature-review
description: Systematic literature search, screening, evidence extraction and synthesis for a ResearchPilot project. Use when scoping a topic, building related work, finding baselines, or checking whether a claim is already known.
whenToUse: The user asks for a literature review, related work, research gap, baseline selection, or citation support. Also use at the start of a research pipeline before experiments are designed.
user-invocable: true
---

# Literature Review

Turn a research question into a screened, traceable evidence base. The output is a decision about what is known, what is contested, and what remains open.

## Non-negotiables

- Every citation must come from the project library or a DOI/URL you actually retrieved.
- Never invent authors, years, venues, findings, or identifiers.
- Distinguish what a paper claims from what it demonstrates.
- A literature review is not a substitute for an experiment; use it to choose baselines, metrics, and the gap.

## Resource map

Load only what you need:

- references/question-and-scope.md
- references/search-strategy.md
- references/screening.md
- references/critical-appraisal.md
- references/synthesis.md
- templates/evidence-matrix.md
- templates/research-brief.md
- templates/search-log.csv
- templates/screening-log.csv
- scripts/check_bibtex.py
- scripts/matrix_lint.py
- scripts/dedupe_refs.py
- evals/rubric.md and evals/cases.md

Paths are relative to this skill directory (project copies live under .agents/skills/literature-review/).

## Workflow

### 1. Define scope

Write down the question, population/task, intervention, comparison, outcomes, inclusion/exclusion criteria, and date/venue scope. If the topic is broad, propose 2-3 narrow scopes before a long search.

### 2. Search the local library

Use `mcp__rp_evidence__workspace_inventory`, `reference_search({query})`, and `reference_read({id})`. These return actual project records. Do not invoke the research CLI or shell.

Read notes and attached PDFs. Do not re-add duplicates.

### 3. Search external metadata

Use `mcp__rp_evidence__literature_search({query,limit})` and `reference_add_doi({doi})`. Each requires explicit desktop approval and sends only the query/DOI to Crossref via the application network helper. No arbitrary URL fetch. Record retrieved date and actual returned metadata. Missing abstracts remain missing; never infer methods/results from titles. Write notes, research-brief and evidence-matrix with `mcp__rp_artifacts__project_artifact_write({path,content})` under references/. These native tools do not require shell.

Use several complementary queries. For promising results, inspect the abstract/landing page before adding. Label preprints as preprints.

### 4. Screen and extract

Record every included paper in an evidence matrix using templates/evidence-matrix.md. Use templates/screening-log.csv to record exclusions and reasons. Capture:

- study, venue/year;
- task/dataset;
- method and baseline;
- metric and main result;
- uncertainty and compute;
- limitations;
- relevance and confidence.

### 5. Synthesize

Produce:

1. consensus supported by multiple sources;
2. contested points and why;
3. a precise, falsifiable gap;
4. baselines and metrics to use;
5. risks and methodological concerns.

Organize by claim, not by author list. Do not write a sequence of summaries.

### 6. Handoff

Write references/research-brief.md using templates/research-brief.md. Include the question, gap, hypotheses, baselines, metrics, datasets, compute constraints, and key citations. Tell the user which parts are evidence-backed and which are hypotheses.

## Quality gates

- [ ] Every citation is traceable to the library or a verified DOI.
- [ ] Key claims have more than one source when possible.
- [ ] Baselines and metrics are named explicitly.
- [ ] Preprints are labeled.
- [ ] The gap is falsifiable by an experiment.
- [ ] The brief is saved and summarized in chat.
- [ ] The evidence matrix and screening log are saved.

## Failure modes

- A broad narrative with no screening criteria.
- Citing a source without reading its abstract.
- Treating "many papers do X" as proof that X is correct.
- Proposing a gap that is actually addressed by a source already in the library.
