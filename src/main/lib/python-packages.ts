const PACKAGE_MAP: Record<string, string> = {
  numpy: 'numpy', pandas: 'pandas', matplotlib: 'matplotlib', scipy: 'scipy',
  sklearn: 'scikit-learn', seaborn: 'seaborn', statsmodels: 'statsmodels', plotly: 'plotly'
}
const HEAVY_PACKAGES = new Set(['torch', 'tensorflow', 'jax', 'transformers', 'datasets', 'vllm', 'deepspeed'])

export function detectPackages(code: string, allowHeavy = false): string[] {
  const imports = new Set<string>()
  // This is dependency discovery, not a sandbox or a Python parser.
  const stripped = code.replace(/(["']{3})[\s\S]*?\1/g, '').replace(/#[^\n]*/g, '')
  for (const match of stripped.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_]\w*(?:\.\w+)*)[ \t]+import\b|import[ \t]+([^\r\n;]+))/gm)) {
    const modules = match[1] ? [match[1]] : (match[2] ?? '').split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0]!)
    for (const module of modules) {
      const root = module.trim().split('.')[0]
      if (root) imports.add(root)
    }
  }
  const heavy = [...imports].filter((name) => HEAVY_PACKAGES.has(name))
  if (heavy.length && !allowHeavy) throw new Error(`本地实验检测到重型依赖 ${heavy.join(', ')}。请配置已安装这些库的 Python 解释器，或改用 SSH 主机运行。`)
  return [...new Set([...imports].map((name) => PACKAGE_MAP[name]).filter((name): name is string => Boolean(name)))].sort()
}
