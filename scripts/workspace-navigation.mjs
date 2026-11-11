// Keep these routes aligned with src/renderer/src/lib/workspace-navigation.ts.
const parentByPath = new Map([
  ['/', ['/', '/research', '/pipeline']],
  ['/agent', ['/agent', '/skills']],
  ['/library', ['/library', '/notes', '/knowledge']],
  ['/experiments', ['/experiments', '/methods', '/figures']],
  ['/writing', ['/writing', '/writing-quality']],
  ['/settings', ['/settings', '/mcp', '/setup', '/backups']]
].flatMap(([parent, paths]) => paths.map(path => [path, parent])))

export async function navigateWorkspace(page, path) {
  const parent = parentByPath.get(path)
  if (!parent) throw new Error(`Unknown workspace route: ${path}`)
  await page.locator(`.sidebar a[href="#${parent}"]`).click()
  if (path !== parent) await page.locator(`.workspace-nav a[href="#${path}"]`).click()
}
