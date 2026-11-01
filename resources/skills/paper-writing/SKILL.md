---
name: paper-writing
description: Write and revise evidence-backed manuscripts in DOCX and LaTeX inside ResearchPilot. Use after experiments and figures exist, for outlines, abstracts, sections, related work, results, limitations, rebuttals and format export.
whenToUse: The user asks to generate, revise, or review a paper, or a research pipeline reaches the manuscript stage. Requires experiment results or an explicit statement that the paper is a proposal without results.
user-invocable: true
---

# Evidence-Backed Paper Writing

Write the paper from the experiment log, not from imagination. The manuscript is a report on what was actually done, measured, and cited.

## Native manuscript workflow (takes precedence over legacy CLI examples below)

Read stage artifacts with artifact_read and registered documents with manuscript_list/manuscript_read. Write the actual document via mcp__rp_writing__manuscript_write({id,markdown}); a missing id plus title creates a new DOCX after approval. Existing LaTeX IDs accept complete TeX source in markdown, but compilation is NOT performed and must remain explicitly unverified. No shell/CLI/generic writes. Put the agent-authored full Markdown source at exports/manuscript-source.md using project_artifact_write for audit traceability. Embed actual registered figure previews with standalone ![caption](figures/.../figure.svg), using returned project-relative paths; native document service resolves structured figures. Include exact numeric tables and uncertainty captions, retain editable PPTX separately. Create the claims map with project_artifact_write. Automated audits use agent-authored registered analysis/audit experiments and actual execution, never forged passed reports or human supportReviewed flags.

## Non-negotiables

- Every empirical number must trace to a run ID and an artifact path.
- Every citation must exist in the project reference library or a DOI/URL you actually verified.
- Mark unverified content as TODO. Never invent a result, citation, venue, year, p-value, or error bar.
- Preserve the user's edits and voice when revising. Save a new version before large rewrites.
- A negative or inconclusive result is evidence; report it honestly.

## Resource map

This skill is a small router. Load only the files you need:

- references/evidence-and-claims.md - claim strength, claims-evidence tables, number traceability.
- references/imrad-structure.md - what each section must do and how it usually fails.
- references/abstract-and-intro.md - abstract formulas and contribution framing.
- references/results-and-statistics.md - reporting uncertainty, effect sizes, and causal limits.
- references/citation-integrity.md - verifying sources and placing citations honestly.
- references/revision-and-review.md - reviewer mindset and revision workflow.
- references/formatting-docx-latex.md - DOCX/LaTeX operations, compile errors, fonts, tables.
- references/reproducibility.md - reproducibility statement and artifact availability.
- templates/claims-evidence-map.md - build this first.
- templates/manuscript-outline.md - section-level planning.
- templates/paper.md - Markdown source for a DOCX draft.
- templates/article.tex - a clean LaTeX article skeleton.
- templates/review-report.md - severity-ranked review.
- scripts/lint_manuscript.py - find placeholders, missing citations, and untraced numbers.
- scripts/check_citations.py - verify citation keys and bibliography metadata.
- evals/rubric.md and evals/cases.md - quality gates for this skill.

Paths are relative to this skill directory. Project copies normally live under .agents/skills/paper-writing/.

## Workflow

### 1. Read the evidence before writing

Read, in order:

1. references/research-brief.md
2. experiments/plan.md
3. exports/experiment-log.md
4. exports/analysis.md
5. the figure records and captions
6. the current manuscript and its claims map

If a required artifact is missing, stop and report the gap. Do not fill gaps with plausible text.

### 2. Build the claims-evidence map

Copy templates/claims-evidence-map.md into exports/claims-evidence-map.md or update the existing file. For every claim record:

- claim id
- exact claim text
- evidence type: run, citation, derivation, or hypothesis
- run ID / DOI / source path
- strength: strong, moderate, weak, speculative
- where it appears: section and paragraph

Remove or relabel claims with no evidence. This map is the source of truth for the manuscript.

### 3. Outline

Use templates/manuscript-outline.md. Write one sentence per section explaining what the reader must learn. Put the research question, gap, method, and main result in the abstract plan before drafting prose.

### 4. Draft with calibrated language

Use references/imrad-structure.md and references/abstract-and-intro.md.

Rules:

- Report means with uncertainty and n. Use the exact numbers from artifacts.
- Describe associations as associations unless the design supports causality.
- Put limitations next to the claims they constrain.
- Keep related work organized by claims, not by a list of papers.
- Do not use words like "significantly" unless a statistical test supports it.
- Use TODO: number from run <id> when a number is missing.

### 5. Citations

Follow references/citation-integrity.md. Before writing a citation:

- verify the reference exists in the library or Crossref/DOI;
- verify title, authors, year, and venue;
- ensure the sentence is actually supported by the source;
- prefer primary sources over summaries.

### 6. Produce DOCX and/or LaTeX

List and read documents first:

~~~powershell
research docs list
research docs read --id <document-id>
~~~

DOCX workflow:

~~~powershell
research docs write --id <document-id> --file drafts/manuscript.md
~~~

The bridge converts Markdown headings, paragraphs, lists, tables, emphasis, and equations into a Word-style document. After the user edits in the app, re-read the document before a full rewrite so you do not discard formatting or edits.

LaTeX workflow:

~~~powershell
research docs write --id <document-id> --file drafts/manuscript.tex
research docs compile --id <document-id>
~~~

Check the compile log for missing packages, undefined references, and overfull boxes. Chinese documents need XeLaTeX and ctex. Keep the bibliography source reproducible; use real citation keys from the project library.

### 7. Review and lint

Run the manuscript linter and citation checker:

~~~powershell
uv run --no-project --python 3.12 python .agents/skills/paper-writing/scripts/lint_manuscript.py manuscripts/<file>
uv run --no-project --python 3.12 python .agents/skills/paper-writing/scripts/check_citations.py manuscripts/<file> manuscripts/references.bib
~~~

Then perform a reviewer pass using references/revision-and-review.md and templates/review-report.md. Fix problems in this order:

1. false or unsupported claims
2. missing or wrong citations
3. numbers that do not match results
4. missing limitations or negative results
5. structure and clarity
6. style and formatting

## Output contract

When you finish, report:

- document IDs and formats produced;
- compile status and word count;
- claims with weak or missing evidence;
- citations that could not be verified;
- the review findings that remain open;
- the exact artifact paths.

Never claim the paper is finished if the claims map has unresolved evidence gaps.

## Failure modes to avoid

- Writing a beautiful abstract before any experiment exists.
- Copying numbers from memory or from a different run.
- Padding citations to look scholarly.
- Hiding failed runs or null results.
- Treating a preprint as established fact.
- Rewriting a user-edited DOCX from scratch without reading it first.
- Declaring LaTeX success when the PDF was not produced.
