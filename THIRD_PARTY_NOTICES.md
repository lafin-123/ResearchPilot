# Third-Party Notices

ResearchPilot includes and builds on the following open-source projects. Their licenses and notices are retained in the installed application's dependency tree.

## DeepSeek Harness (dsh)

- License: MIT
- Copyright: DeepSeek AI and contributors
- Role: agent runtime, tool registry, sessions, sandbox and provider adapters.

The MIT license text is distributed with the `@deepseek-ai/dsh` and related packages.

## @docx-editor.dev

- License: Apache-2.0 (core and React adapter)
- Copyright: EigenPal and contributors
- Role: DOCX parsing, layout, rendering and editing.

The `@docx-editor.dev/pro` modules are not bundled. See the package's `THIRD_PARTY_NOTICES.md` for its full dependency notices.

## Electron

- License: MIT
- Copyright: Electron contributors / OpenJS Foundation

## Other dependencies

React, lucide-react, CodeMirror, ssh2, mammoth, docx, js-yaml, JSZip, PDF.js (`pdfjs-dist`), PptxGenJS, sharp, the Model Context Protocol SDK, react-markdown, sonner, clsx and their transitive dependencies retain their respective licenses. See `package.json` and `package-lock.json` for the actual dependency versions. After installing dependencies, inspect each package's `package.json`, LICENSE/COPYING and NOTICE files in `node_modules` for its applicable terms; no `npm licenses` command is supplied by this project.

The generated `resources/mcp/server.mjs` contains bundled third-party SDK code and retains its generated legal comments. The ResearchPilot noncommercial license applies only to the project's original material, not to third-party code inside generated bundles. Rebuild the bundle with `npm run build:mcp`; do not remove its third-party notices.

## lieflat-less-ai-tone

- Author: shiujan
- Source: https://github.com/larashero3-dotcom/lieflat-less-ai-tone
- Pinned commit: `53160078a04926d98de57a233549612d1b89bdc9`
- License: CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
- Role: bundled writing rules, local detection and comparison scripts, and semantic review criteria.

Original files and the full license are retained in `resources/skills/lieflat-less-ai-tone/` (installed as `skills/lieflat-less-ai-tone/`). ResearchPilot adds academic adaptation, a revision template and regression cases; see that directory's `ATTRIBUTION.md`. These adaptations retain CC BY-NC 4.0. Native integration does not imply the original author's endorsement or independent reproduction of the upstream corpus research.

## ResearchPilot original material

ResearchPilot's original code and resources are offered under PolyForm Noncommercial 1.0.0. See `LICENSE.md` and `NOTICE.md`. This does not change or restrict licenses granted directly by third-party copyright holders.

ResearchPilot is an independent product and is not an official DeepSeek product.
