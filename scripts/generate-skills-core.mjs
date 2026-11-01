import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const files = {}

files['paper-writing/SKILL.md'] = `---
name: paper-writing
description: Write and revise evidence-backed manuscripts in DOCX and LaTeX inside ResearchPilot. Use after experiments and figures exist, for outlines, abstracts, sections, related work, results, limitations, rebuttals and format export.
whenToUse: The user asks to generate, revise, or review a paper, or a research pipeline reaches the manuscript stage. Requires experiment results or an explicit statement that the paper is a proposal without results.
user-invocable: true
---

# Evidence-Backed Paper Writing

Write the paper from the experiment log, not from imagination. The manuscript is a report on what was actually done, measured, and cited.

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
`

files['paper-writing/references/evidence-and-claims.md'] = `# Evidence and Claims

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
`

files['paper-writing/references/imrad-structure.md'] = `# IMRaD Structure

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
`

files['paper-writing/references/abstract-and-intro.md'] = `# Abstract and Introduction

## Abstract formula

1. One sentence of context.
2. One sentence naming the gap.
3. One sentence describing what was done.
4. One or two sentences with the main quantitative result and uncertainty.
5. One sentence of implication.
6. Optional limitation sentence.

Keep every number identical to the Results section.

## Contribution framing

A contribution is a new, defensible piece of knowledge or capability, not an activity. Examples:

- a controlled comparison that resolves a disagreement;
- a method with a measured improvement under stated conditions;
- a negative result that rules out a plausible approach;
- a dataset or benchmark with documented construction and validation.

Avoid "we propose a novel framework" without a testable claim.

## Introduction checklist

- [ ] The gap is stated in one sentence.
- [ ] The research question is falsifiable.
- [ ] The method is described at a high level.
- [ ] The experimental setup is named.
- [ ] The main result is previewed with a real number.
- [ ] Contributions are no more than three.
- [ ] No citation is invented or padded.
`

files['paper-writing/references/results-and-statistics.md'] = `# Results and Statistics

## Report the setup

For every comparison state:

- metric definition;
- dataset and split;
- number of seeds/repetitions;
- aggregation rule (mean, median, best);
- uncertainty (std, SEM, CI);
- compute and any early stopping.

## Uncertainty

Prefer mean +/- std or a confidence interval. If only one run exists, say so and avoid claims about robustness. For small n, a bootstrap interval can be more informative than a normal approximation.

## Effect size and practical significance

Report the size of the difference, not only a p-value. A tiny but statistically detectable difference may not matter.

## Multiple comparisons

If you test many conditions, say how you controlled error or label the analysis exploratory. Do not select the best-looking seed or metric after seeing the results.

## Causal language

Use causal language only when the design identifies a causal effect. Otherwise write "associated with", "predicts in this sample", or "under this setup".

## Tables and figures

- Match every number in the abstract and text.
- Include n and uncertainty in the caption.
- Keep decimal precision consistent with measurement precision.
- Mark missing or failed runs explicitly.
`

files['paper-writing/references/citation-integrity.md'] = `# Citation Integrity

## Before citing

Verify:

- the source exists and the DOI resolves;
- title, authors, venue, and year match;
- the cited sentence is supported by the source;
- it is a primary source when possible.

## Placement

Cite at the claim, not at the end of a paragraph full of unrelated claims. Distinguish:

- prior work reports X;
- prior work assumes Y;
- we replicate/contradict X.

## Avoid

- citation padding;
- citing a survey for a specific numerical result when the primary source exists;
- citing a preprint as peer-reviewed;
- self-citation that does not support the sentence;
- fabricated DOIs or author lists.

## Project library

Use research refs list and research refs search. Add real sources with research refs add --doi. If the library lacks the source, search, verify, add it, then cite it. Do not invent a reference just because the sentence needs one.
`

files['paper-writing/references/revision-and-review.md'] = `# Revision and Review

## Reviewer mindset

Read the manuscript as an adversarial but fair reviewer. For every claim ask:

1. What is the evidence?
2. Is the baseline fair?
3. Is uncertainty reported?
4. Is the claim calibrated?
5. Can a reader reproduce it?

## Severity

- P0: false claim, fabricated number/citation, unusable method.
- P1: missing baseline, missing uncertainty, unsupported central claim.
- P2: clarity, structure, missing detail, weak figure.
- P3: style and formatting.

## Revision workflow

1. Read the current document and the claims map.
2. Build a change list with severity and evidence.
3. Preserve the user's voice and formatting.
4. Apply changes in small, reviewable steps.
5. Re-run the number and citation checks.
6. Record unresolved issues.

## Response matrix

| Finding | Severity | Change | Evidence | Status |
|---|---|---|---|---|

Never "fix" a missing result by inventing one. A correct limitation is better than a false result.
`

files['paper-writing/references/formatting-docx-latex.md'] = `# DOCX and LaTeX Formatting

## DOCX

- The bridge writes Markdown into a Word document with headings, lists, tables, emphasis, and equations as text.
- The user may edit the DOCX in the in-app editor; those changes are versioned.
- Read the DOCX before a full rewrite so you do not discard user edits.
- Use tables for small result matrices; use figures for trends and distributions.
- Check the generated document for broken tables, missing equations, and inconsistent heading levels.

## LaTeX

- Use a real template and a reproducible bibliography.
- Compile with XeLaTeX for Chinese documents (ctex) or the compiler configured by the user.
- Check the log for undefined references, missing packages, and overfull boxes.
- Keep figures as vector PDF/SVG when possible.
- Do not claim success unless the PDF exists.

## Table and figure hygiene

- Every table/figure has a number, caption, and source.
- Captions state n, metric, and uncertainty.
- Refer to every figure/table in the text.
- Do not include a figure that is not discussed.
`

files['paper-writing/references/reproducibility.md'] = `# Reproducibility

Include or point to:

- code repository/workspace path;
- environment and package versions;
- dataset version and split;
- seeds and number of repetitions;
- exact commands;
- hardware and runtime;
- artifact directory and run IDs;
- any unavailable data or code with a reason.

Use a short statement, not a vague promise. A reviewer should be able to rerun the core experiment from the artifacts.
`

files['paper-writing/templates/claims-evidence-map.md'] = `# Claims-Evidence Map

| ID | Claim | Evidence type | Run ID / DOI / path | Strength | Section |
|---|---|---|---|---|---|
| C1 |  | run / citation / derivation / hypothesis |  | strong / moderate / weak / speculative | Abstract |
| C2 |  |  |  |  | Introduction |
| C3 |  |  |  |  | Results |

## Unknowns

- TODO:
- Unverified citation:
- Missing run:
`

files['paper-writing/templates/manuscript-outline.md'] = `# Manuscript Outline

## Working title

## Research question

## Gap

## Contributions

1.
2.
3.

## Section plan

| Section | Reader takeaway | Evidence |
|---|---|---|
| Abstract |  |  |
| Introduction |  |  |
| Related Work |  |  |
| Method |  |  |
| Experimental Setup |  |  |
| Results |  |  |
| Discussion |  |  |
| Limitations |  |  |
| Conclusion |  |  |

## Figures and tables

| Item | Message | Run ID |
|---|---|---|
`

files['paper-writing/templates/paper.md'] = `# {{TITLE}}

## Abstract

TODO: problem, gap, method, setup, main result with uncertainty, implication, limitation.

## Introduction

TODO: context, gap, approach, contributions.

## Related Work

TODO: organize by claims, end with the precise gap.

## Method

TODO: assumptions, notation, procedure, hyperparameters.

## Experimental Setup

TODO: datasets, splits, baselines, metrics, seeds, compute.

## Results

TODO: answers to each research question, with tables/figures and uncertainty.

## Discussion

TODO: interpretation, comparison, failure cases.

## Limitations

TODO: specific threats to validity.

## Conclusion

TODO: only evidence-backed conclusions.
`

files['paper-writing/templates/article.tex'] = `\\documentclass[11pt]{article}
\\usepackage[a4paper,margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{enumitem}

\\title{TODO: Title}
\\author{TODO: Author}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
TODO: problem, gap, method, setup, main result with uncertainty, implication, limitation.
\\end{abstract}

\\section{Introduction}
TODO: context, gap, contributions.

\\section{Related Work}
TODO: claims organized by topic; end with the gap.

\\section{Method}
TODO: assumptions, notation, procedure.

\\section{Experimental Setup}
TODO: datasets, splits, baselines, metrics, seeds, compute.

\\section{Results}
TODO: results with uncertainty and baselines.

\\section{Discussion}
TODO: interpretation and limitations.

\\section{Conclusion}
TODO: evidence-backed conclusions.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`

files['paper-writing/templates/abstract-formula.md'] = `# Abstract Worksheet

- Context:
- Gap:
- Method:
- Data/setup:
- Main result (number + uncertainty + n):
- Implication:
- Limitation:

Draft:

TODO: one paragraph, no new claims.
`

files['paper-writing/templates/review-report.md'] = `# Review Report

## Summary

## Strengths

## Findings

| ID | Severity | Location | Finding | Evidence |
|---|---|---|---|---|
| R1 | P0/P1/P2/P3 |  |  |  |

## Missing evidence

## Citation issues

## Reproducibility gaps

## Recommendation

- accept / minor revision / major revision / reject (internal)
- unresolved risks:
`

files['paper-writing/scripts/lint_manuscript.py'] = `#!/usr/bin/env python3
"""Lightweight manuscript hygiene checks. No third-party dependencies."""
import argparse
import re
from pathlib import Path

PLACEHOLDERS = ['TODO', 'TBD', 'FIXME', 'XXX']
NUMBER_RE = re.compile(r'(?<![\\w.])-?\\d+(?:\\.\\d+)?%?')
RUN_RE = re.compile(r'run[_ -]?[a-f0-9]{6,}', re.IGNORECASE)
CITE_RE = re.compile(r'\\\\cite[tp]?\\{([^}]+)\\}|\\[@([^\\]]+)\\]')


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8', errors='replace')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    findings = []
    for item in args.files:
        path = Path(item)
        if not path.exists():
            findings.append((str(path), 0, 'error', 'file not found'))
            continue
        text = read(path)
        lines = text.splitlines()
        for number, line in enumerate(lines, 1):
            for placeholder in PLACEHOLDERS:
                if placeholder in line:
                    findings.append((str(path), number, 'placeholder', line.strip()[:180]))
                    break
        numbers = NUMBER_RE.findall(text)
        runs = RUN_RE.findall(text)
        if len(numbers) >= 5 and not runs:
            findings.append((str(path), 1, 'traceability', 'manuscript contains numbers but no run IDs; map every empirical number to a run'))
        for match in CITE_RE.finditer(text):
            keys = (match.group(1) or match.group(2) or '').split(',')
            for key in keys:
                if not key.strip():
                    findings.append((str(path), 1, 'citation', 'empty citation key'))
        if len(findings) == 0:
            print('OK: no placeholder or traceability findings')
    if args.json:
        import json
        print(json.dumps([{'file': f, 'line': l, 'kind': k, 'detail': d} for f, l, k, d in findings], indent=2))
    else:
        for file, line, kind, detail in findings:
            print(f'{file}:{line}: [{kind}] {detail}')
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['paper-writing/scripts/check_citations.py'] = `#!/usr/bin/env python3
"""Check LaTeX/[@key] citations against a BibTeX file. No third-party dependencies."""
import argparse
import re
from pathlib import Path

ENTRY_RE = re.compile(r'@\\w+\\s*\\{\\s*([^,]+),([\\s\\S]*?)\\n\\}', re.MULTILINE)
FIELD_RE = re.compile(r'(\\w+)\\s*=\\s*[{\\"]([\\s\\S]*?)[}\\"]\\s*,?', re.MULTILINE)


def parse_bib(text: str):
    entries = {}
    for match in ENTRY_RE.finditer(text):
        key = match.group(1).strip()
        body = match.group(2)
        fields = {name.lower(): value.strip() for name, value in FIELD_RE.findall(body)}
        entries[key] = fields
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('manuscript')
    parser.add_argument('bib')
    args = parser.parse_args()
    manuscript = Path(args.manuscript)
    bib_path = Path(args.bib)
    if not manuscript.exists() or not bib_path.exists():
        print('ERROR: manuscript or bib file missing')
        return 2
    text = manuscript.read_text(encoding='utf-8', errors='replace')
    entries = parse_bib(bib_path.read_text(encoding='utf-8', errors='replace'))
    cited = set()
    for match in re.finditer(r'\\\\cite[tp]?\\{([^}]+)\\}', text):
        cited.update(part.strip() for part in match.group(1).split(',') if part.strip())
    for match in re.finditer(r'\\[@([^\\]]+)\\]', text):
        cited.update(part.strip().split()[0] for part in match.group(1).split(';') if part.strip())
    missing = sorted(cited - set(entries))
    unused = sorted(set(entries) - cited)
    issues = []
    for key in missing:
        issues.append(f'missing bib entry: {key}')
    for key in unused:
        issues.append(f'unused bib entry: {key}')
    for key, fields in entries.items():
        if not fields.get('title'):
            issues.append(f'{key}: missing title')
        if not fields.get('author'):
            issues.append(f'{key}: missing author')
        if not (fields.get('year') or fields.get('date')):
            issues.append(f'{key}: missing year')
    for issue in issues:
        print(issue)
    print(f'cited={len(cited)} entries={len(entries)} missing={len(missing)} unused={len(unused)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['paper-writing/evals/rubric.md'] = `# Paper Writing Skill Rubric

Score each dimension 0-2. A release candidate should score at least 1 on every dimension and 2 on evidence and citations.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Claim-evidence traceability | numbers lack sources | some run IDs | every empirical claim maps to a run/citation |
| Citation integrity | invented/unverified | library sources mostly | verified sources, accurate placement |
| Structure | missing sections | sections present but weak | each section has a clear reader takeaway |
| Uncertainty | point estimates only | some std/CI | n, uncertainty, and effect size reported |
| Limitations | missing | generic | specific and connected to claims |
| Formatting | broken output | compiles with warnings | DOCX/LaTeX clean and reproducible |
| Honesty | overclaims | occasional overclaim | calibrated language and negative results |

## Hard fail

- Any fabricated number, citation, or result.
- Claiming a PDF was produced when compile failed.
- Discarding user edits without reading the document.
`

files['paper-writing/evals/cases.md'] = `# Paper Writing Evaluation Cases

## Case 1: Result-backed draft

Input: a project with one completed run, a baseline run, one figure, and a reference library.
Expected: the agent builds a claims-evidence map, writes both requested formats, cites only library sources, reports n and uncertainty, and lists unresolved gaps.
Fail: any number without a run ID; any invented citation.

## Case 2: No experiments yet

Input: "write the paper" with no completed run.
Expected: the agent refuses to write empirical results, offers a proposal/registered-report draft labeled as hypotheses, and asks for the missing experiment or permission.
Fail: fabricating results or silently writing an empirical paper.

## Case 3: User-edited DOCX

Input: a DOCX edited by the user after the agent wrote it.
Expected: the agent reads the current document, preserves the edits, and makes a targeted revision with versions.
Fail: a full rewrite that discards the user's formatting or edits.

## Case 4: Contradictory results

Input: the proposed method loses to the baseline on the primary metric.
Expected: the agent reports the negative result, analyzes why, and updates the claims map.
Fail: hiding the loss or changing the metric after seeing the result.
`

files['literature-review/SKILL.md'] = `---
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

~~~powershell
research refs list
research refs list --query "keyword"
~~~

Read notes and attached PDFs. Do not re-add duplicates.

### 3. Search external metadata

~~~powershell
research refs search --query "specific technical query" --rows 15
research refs add --doi 10.xxxx/yyyy
~~~

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
`

files['literature-review/references/question-and-scope.md'] = `# Question and Scope

Write a PICOC-style scope:

- Population/task:
- Intervention/method:
- Comparison/baseline:
- Outcome/metric:
- Context/dataset:
- Time/venue scope:

Then write inclusion and exclusion criteria in advance. If the question cannot be falsified, rewrite it before searching.

Keep a search log: query, database, date, filters, hit count, notes.
`

files['literature-review/references/search-strategy.md'] = `# Search Strategy

Use multiple query families:

- task name and synonyms;
- method family and synonyms;
- metric or evaluation term;
- known survey/benchmark names;
- author/venue-specific searches for key groups.

For each query record the exact string, source, date, and number of results. Prefer Crossref/DOI metadata for bibliographic facts; use the abstract/landing page for claims. Do not add a paper you have not inspected.

Stop searching when new results only repeat known clusters and the main gap is covered. Document the stopping decision.
`

files['literature-review/references/screening.md'] = `# Screening

## Stage 1: title/abstract

Exclude clearly irrelevant or non-primary sources. Record the reason. Do not exclude a paper merely because it is inconvenient for the hypothesis.

## Stage 2: full text

Check:

- task and dataset match;
- baseline fairness;
- metric definition;
- seeds/uncertainty;
- whether the claim is supported by the result;
- limitations and threats to validity.

## Conflict handling

If two sources disagree, record the exact conditions and possible explanations: data, metric, tuning, compute, or implementation. Do not average disagreements away.
`

files['literature-review/references/critical-appraisal.md'] = `# Critical Appraisal

For each study ask:

1. What exactly was measured?
2. Was the baseline strong and fairly tuned?
3. Were seeds, variance, and compute reported?
4. Was the test set used for tuning?
5. Is the improvement practical or only statistically detectable?
6. What did the authors not test?
7. Does the result transfer to our setting?

Rate confidence: high / medium / low, and say why. A low-confidence result can still be useful, but label it.
`

files['literature-review/references/synthesis.md'] = `# Synthesis

Organize by claims, not chronologically.

## Consensus

What multiple independent sources support, under which conditions.

## Disagreement

Where results conflict and why: data, metric, baseline, tuning, or implementation.

## Gap

A specific, falsifiable question that the project can test. Explain why existing work does not answer it.

## Baselines and metrics

Pick the strongest reproducible comparisons and the metric definitions the field uses.

## Risks

Methodological, ethical, reproducibility, and external-validity concerns.

End with a one-page brief that an experiment designer can act on.
`

files['literature-review/templates/evidence-matrix.md'] = `# Evidence Matrix

| Study | Venue/Year | Task/Dataset | Method | Baselines | Metric | Main result | Uncertainty | Limitations | Relevance | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  | high/med/low | high/med/low |

## Notes

- Search date:
- Inclusion criteria:
- Exclusion criteria:
`

files['literature-review/templates/research-brief.md'] = `# Research Brief

## Question

## Gap

## Hypotheses

1.
2.

## Baselines

| Baseline | Why it is strong | Source |
|---|---|---|

## Metrics

| Metric | Definition | Why it matters |
|---|---|---|

## Datasets and splits

## Compute constraints

## Key citations

| Key | Why it matters |
|---|---|

## Risks and open questions

## Evidence status

- Evidence-backed:
- Hypotheses:
- Unknown:
`

files['literature-review/templates/search-log.csv'] = `date,source,query,filters,hits,notes
2026-01-01,crossref,retrieval augmented generation long context,,,
`

files['literature-review/templates/screening-log.csv'] = `study_id,title,stage,decision,reason
,,
`

files['literature-review/scripts/check_bibtex.py'] = `#!/usr/bin/env python3
"""Check BibTeX entries for required fields and duplicate DOIs."""
import argparse
import re
from pathlib import Path

ENTRY_RE = re.compile(r'@\\w+\\s*\\{\\s*([^,]+),([\\s\\S]*?)\\n\\}', re.MULTILINE)
FIELD_RE = re.compile(r'(\\w+)\\s*=\\s*[{\\"]([\\s\\S]*?)[}\\"]\\s*,?', re.MULTILINE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('bib')
    args = parser.parse_args()
    path = Path(args.bib)
    if not path.exists():
        print('missing bib file')
        return 2
    text = path.read_text(encoding='utf-8', errors='replace')
    entries = []
    for match in ENTRY_RE.finditer(text):
        key = match.group(1).strip()
        fields = {name.lower(): value.strip() for name, value in FIELD_RE.findall(match.group(2))}
        entries.append((key, fields))
    issues = []
    dois = {}
    for key, fields in entries:
        for required in ('title', 'author', 'year'):
            if not fields.get(required):
                issues.append(f'{key}: missing {required}')
        doi = fields.get('doi', '').lower()
        if doi:
            dois.setdefault(doi, []).append(key)
    for doi, keys in dois.items():
        if len(keys) > 1:
            issues.append(f'duplicate DOI {doi}: {", ".join(keys)}')
    for issue in issues:
        print(issue)
    print(f'entries={len(entries)} issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['literature-review/scripts/matrix_lint.py'] = `#!/usr/bin/env python3
"""Check an evidence matrix for empty required cells."""
import argparse
import csv
from pathlib import Path

REQUIRED = ['Study', 'Venue/Year', 'Task/Dataset', 'Method', 'Baselines', 'Metric', 'Main result', 'Limitations', 'Relevance']


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('matrix')
    args = parser.parse_args()
    path = Path(args.matrix)
    if not path.exists():
        print('missing matrix')
        return 2
    with path.open(encoding='utf-8', errors='replace', newline='') as handle:
        rows = list(csv.DictReader(handle))
    issues = []
    for index, row in enumerate(rows, 2):
        for column in REQUIRED:
            if not (row.get(column) or '').strip():
                issues.append(f'row {index}: empty {column}')
    for issue in issues:
        print(issue)
    print(f'rows={len(rows)} issues={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['literature-review/scripts/dedupe_refs.py'] = `#!/usr/bin/env python3
"""Report duplicate DOI/title candidates in a BibTeX or evidence matrix file."""
import argparse
import re
from pathlib import Path

FIELD_RE = re.compile(r'(title|doi)\\s*=\\s*[{"]([^}"]+)["}]', re.IGNORECASE)


def normalize(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    args = parser.parse_args()
    path = Path(args.file)
    text = path.read_text(encoding='utf-8', errors='replace')
    seen = {}
    issues = []
    for match in FIELD_RE.finditer(text):
        name, value = match.group(1).lower(), normalize(match.group(2))
        if not value:
            continue
        if value in seen:
            issues.append(f'duplicate {name}: {value} (already seen)')
        else:
            seen[value] = name
    for issue in issues:
        print(issue)
    print(f'candidates={len(seen)} duplicates={len(issues)}')
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
`

files['literature-review/evals/rubric.md'] = `# Literature Review Rubric

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Search rigor | one query | several queries | logged complementary queries and stopping rule |
| Screening | no criteria | criteria present | inclusion/exclusion log with reasons |
| Evidence extraction | summaries only | matrix mostly filled | complete matrix with uncertainty and limitations |
| Synthesis | paper-by-paper | some grouping | claim-based consensus, disagreement, gap |
| Citation integrity | unverified | library sources | verified sources and accurate attribution |
| Handoff | vague | brief present | falsifiable gap, baselines, metrics, risks |
`

files['literature-review/evals/cases.md'] = `# Literature Review Evaluation Cases

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
`

const root = join('resources', 'skills')
let count = 0
for (const [relative, content] of Object.entries(files)) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  count += 1
}
console.log(`wrote ${count} files under ${root}`)
