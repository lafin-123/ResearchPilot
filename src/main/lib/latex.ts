import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LatexCompileResult } from '@shared/types'
import { truncate } from './util'

const CJK = /[\u4e00-\u9fff]/

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

export function latexTemplate(title: string, options: { author?: string; abstract?: string; cjk?: boolean } = {}): string {
  const cjk = options.cjk ?? hasCjk(title)
  const bodyTitle = title.replace(/([\\{}%$&#_^~])/g, '\\$1')
  return `\\documentclass[11pt]{article}
${cjk ? '\\usepackage[UTF8]{ctex}\n' : ''}\\usepackage[a4paper,margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{multirow}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage{caption}
\\usepackage{subcaption}
\\usepackage{natbib}
\\usepackage{enumitem}
\\usepackage{setspace}

\\hypersetup{colorlinks=true,linkcolor=blue!55!black,citecolor=teal!60!black,urlcolor=blue!55!black}
\\setlength{\\parskip}{0.35em}
\\setlength{\\parindent}{0pt}

\\title{${bodyTitle}}
\\author{${options.author ?? 'ResearchPilot Draft'}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
${options.abstract ?? '替换此段为论文摘要：問題、方法、實驗設計、主要結果與貢獻。所有数值必须来自已执行的实验。'}
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}
在这里陈述研究问题、动机与主要贡献。避免在实验完成前写入未经证实的结论。

\\section{Related Work}
\\label{sec:related}
TODO: 使用文献库中的条目建立相关工作脉络，并给出真实引用。

\\section{Method}
\\label{sec:method}
描述方法、假设与可复现的实验设计。公式示例：
\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\ell(f_\\theta(x_i), y_i)
  \\label{eq:loss}
\\end{equation}

\\section{Experimental Setup}
\\label{sec:setup}
说明数据集、baseline、评价指标、超参数、随机种子与计算环境。

\\section{Results}
\\label{sec:results}
TODO: 插入实验运行得到的真实结果、表格与图表。每个主张都应能追溯到一次实验运行。

\\section{Discussion and Limitations}
\\label{sec:discussion}
讨论有效性威胁、失败案例与适用范围。

\\section{Conclusion}
\\label{sec:conclusion}
总结已完成的工作与主要发现。

% \\bibliographystyle{plainnat}
% \\bibliography{references}

\\end{document}
`
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(lookup, [command], { stdio: 'ignore', shell: false })
  return result.status === 0
}

export function detectLatexCommand(preferred?: string, cjk = false): string | null {
  if (preferred && commandExists(preferred)) return preferred
  const candidates = cjk ? ['xelatex', 'lualatex', 'latexmk', 'pdflatex'] : ['pdflatex', 'xelatex', 'lualatex', 'latexmk']
  return candidates.find(commandExists) ?? null
}

function runLatex(command: string, file: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; log: string }> {
  const args = command === 'latexmk'
    ? ['-pdf', '-interaction=nonstopmode', '-halt-on-error', basename(file)]
    : ['-interaction=nonstopmode', '-halt-on-error', basename(file)]
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', TEXINPUTS: `.${process.platform === 'win32' ? ';' : ':'}` },
      windowsHide: true
    })
    let log = ''
    const timer = setTimeout(() => {
      log += `\n[ResearchPilot] LaTeX 编译超时（${Math.round(timeoutMs / 1000)}s），已终止。\n`
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      log += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, log: `${log}\n${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, log })
    })
  })
}

export async function compileLatex(options: {
  texFilePath: string
  preferredCommand?: string
  timeoutMs?: number
}): Promise<LatexCompileResult> {
  const started = Date.now()
  const source = readFileSync(options.texFilePath, 'utf8')
  const cjk = hasCjk(source)
  const command = detectLatexCommand(options.preferredCommand, cjk)
  if (!command) {
    return {
      ok: false,
      command: null,
      durationMs: Date.now() - started,
      log: '未检测到 LaTeX 编译器。请安装 TeX Live 或 MiKTeX（中文论文建议 xelatex + ctex），然后在设置中指定编译命令。'
    }
  }
  if (cjk && command === 'pdflatex') {
    return {
      ok: false,
      command,
      durationMs: Date.now() - started,
      log: '当前文档包含中文，但只检测到 pdflatex。请安装 xelatex 或 lualatex，或改用英文模板。'
    }
  }

  const cwd = join(options.texFilePath, '..')
  const pdfPath = options.texFilePath.replace(/\.tex$/i, '.pdf')
  const passes = command === 'latexmk' ? 1 : 2
  let log = ''
  let code: number | null = 0
  for (let pass = 0; pass < passes; pass += 1) {
    const result = await runLatex(command, options.texFilePath, cwd, options.timeoutMs ?? 180_000)
    log += `\n=== pass ${pass + 1} ===\n${result.log}`
    code = result.code
    if (code !== 0) break
  }

  const ok = code === 0 && existsSync(pdfPath)
  return {
    ok,
    command,
    durationMs: Date.now() - started,
    log: truncate(log.trim(), 240_000),
    ...(ok ? { pdfRelativePath: basename(pdfPath) } : {})
  }
}
