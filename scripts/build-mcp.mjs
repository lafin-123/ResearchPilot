import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  absWorkingDir: root,
  entryPoints: ['resources/mcp/server.ts'],
  outfile: 'resources/mcp/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'inline',
  // Some SDK validators are CommonJS; keep Node built-in requires usable after bundling.
  banner: { js: "import { createRequire as __rpCreateRequire } from 'node:module'; const require = __rpCreateRequire(import.meta.url);" }
})
console.log('Built ResearchPilot bundled MCP stdio server (three scoped tool groups).')
