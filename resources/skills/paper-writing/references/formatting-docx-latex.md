# DOCX and LaTeX Formatting

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
