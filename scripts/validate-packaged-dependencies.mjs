#!/usr/bin/env node
// Read-only, bounded ESM audit. Run with --experimental-import-meta-resolve so
// Node honors each importing file (not this script) as the resolution anchor.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const args = process.argv.slice(2)
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
if (args.some((arg, i) => i % 2 === 0 && !['--app-root', '--compare-root'].includes(arg)) || args.length % 2 || !option('--app-root')) throw new Error('Usage: node --experimental-import-meta-resolve scripts/validate-packaged-dependencies.mjs --app-root PATH [--compare-root PATH]')
if (!process.execArgv.includes('--experimental-import-meta-resolve')) throw new Error('Required: --experimental-import-meta-resolve (per-importer Node ESM resolution)')
const app = resolve(option('--app-root'))
const source = resolve(option('--compare-root') ?? app)
const inside = (root, file) => { const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const unresolved = [], checked = new Set(), queue = []
const enqueue = (sourceFile, targetFile) => queue.push({ sourceFile, targetFile })
let bytes = 0, importsChecked = 0
const entrypoints = [
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
]
for (const entry of entrypoints) enqueue(join(source, entry), join(app, entry))
// SDK plugin entrypoints are selected from bundle metadata/YAML. Include the
// SDK/base production plugin entrypoints, resolving BOTH trees independently:
// electron-builder may legitimately hoist a nested dependency to a new path.
for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']) {
  const manifest = JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'), 'utf8'))
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    try {
      const url = import.meta.resolve(dep, pathToFileURL(join(source, 'node_modules', name, 'package.json')).href)
      const target = import.meta.resolve(dep, pathToFileURL(join(app, 'node_modules', name, 'package.json')).href)
      if (url.startsWith('file:') && target.startsWith('file:')) enqueue(fileURLToPath(url), fileURLToPath(target))
    } catch (error) { unresolved.push({ importer: `${name}/package.json`, specifier: dep, reason: error.message }) }
  }
}
while (queue.length) {
  const { sourceFile: file, targetFile: packagedFile } = queue.shift()
  const key = `${file}\0${packagedFile}`
  if (checked.has(key)) continue
  checked.add(key)
  if (checked.size > 2500) throw new Error('Audit exceeds 2500-file safety bound')
  if (!inside(source, file)) throw new Error(`Source resolution escaped root: ${file}`)
  const importer = relative(source, file)
  if (!inside(app, packagedFile)) {
    unresolved.push({ importer, specifier: '(entrypoint)', reason: `Import resolves outside artifact: ${packagedFile}` })
    continue
  }
  if (!existsSync(packagedFile)) {
    unresolved.push({ importer, specifier: '(entrypoint)', reason: 'File missing from artifact' })
    continue
  }
  if (!/\.[cm]?js$/.test(file)) continue
  const size = statSync(file).size
  bytes += size
  if (size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error('Audit exceeds source-byte safety bound')
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  for (const statement of ast.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (isBuiltin(specifier)) continue
    importsChecked++
    try {
      const sourceUrl = import.meta.resolve(specifier, pathToFileURL(file).href)
      const url = import.meta.resolve(specifier, pathToFileURL(packagedFile).href)
      if (url.startsWith('file:')) {
        const target = fileURLToPath(url)
        if (!inside(app, target)) throw new Error(`Import resolves outside artifact: ${target}`)
        if (!existsSync(target)) throw new Error(`Resolved artifact file missing: ${target}`)
        if (sourceUrl.startsWith('file:')) enqueue(fileURLToPath(sourceUrl), target)
      }
    } catch (error) { unresolved.push({ importer, specifier, reason: error.message }) }
  }
}
const report = { appRoot: app, compareRoot: source, scope: 'Static ESM closure of DSH CLI boot, SDK client, and SDK/base production plugin entrypoints; CJS internals and computed dynamic imports require runtime smoke', filesChecked: checked.size, importsChecked, sourceBytes: bytes, unresolved }
console.log(JSON.stringify(report, null, 2))
if (unresolved.length) process.exitCode = 1
