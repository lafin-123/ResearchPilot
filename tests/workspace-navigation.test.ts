import test from 'node:test'
import assert from 'node:assert/strict'

const routes = ['/', '/research', '/pipeline', '/agent', '/skills', '/library', '/notes', '/knowledge', '/experiments', '/methods', '/figures', '/writing', '/writing-quality', '/settings', '/mcp', '/setup', '/backups']

test('five primary workspaces retain every tool and separate settings', async () => {
  const { PRIMARY_WORKSPACES, SETTINGS_WORKSPACE, workspaceForPath } = await import('../src/renderer/src/lib/workspace-navigation')
  assert.deepEqual(PRIMARY_WORKSPACES.map(item => item.label), ['工作台', '助手', '文献', '实验', '写作'])
  assert.equal(SETTINGS_WORKSPACE.label, '设置')
  const all = [...PRIMARY_WORKSPACES, SETTINGS_WORKSPACE].flatMap(group => group.pages.map(page => page.path))
  assert.deepEqual([...all].sort(), [...routes].sort())
  assert.equal(new Set(all).size, routes.length)
  for (const path of routes) assert.ok(workspaceForPath(path), path)
})

test('nested notes and manuscript editors retain their parent workspace without prefix collisions', async () => {
  const { workspaceForPath, pageForPath } = await import('../src/renderer/src/lib/workspace-navigation')
  assert.equal(workspaceForPath('/notes/note-1')?.id, 'literature')
  assert.equal(pageForPath('/notes/note-1')?.path, '/notes')
  assert.equal(workspaceForPath('/write/doc-1')?.id, 'writing')
  assert.equal(pageForPath('/write/doc-1')?.path, '/writing')
  for (const path of ['/notes-other', '/writing-other', '/unknown']) assert.equal(workspaceForPath(path), undefined)
})

test('route matching accepts case and trailing slash variants like the application router', async () => {
  const { workspaceForPath, pageForPath } = await import('../src/renderer/src/lib/workspace-navigation')
  for (const [path, workspace, page] of [['/library/', 'literature', '/library'], ['/Library', 'literature', '/library'], ['/SKILLS/', 'assistant', '/skills'], ['/settings/', 'settings', '/settings'], ['/backups/', 'settings', '/backups'], ['/Notes/note-1/', 'literature', '/notes'], ['/WRITE/doc-1/', 'writing', '/writing']]) {
    assert.equal(workspaceForPath(path)?.id, workspace)
    assert.equal(pageForPath(path)?.path, page)
  }
})

test('pages have discoverable names and top-level targets remain existing routes', async () => {
  const { PRIMARY_WORKSPACES, SETTINGS_WORKSPACE } = await import('../src/renderer/src/lib/workspace-navigation')
  for (const workspace of [...PRIMARY_WORKSPACES, SETTINGS_WORKSPACE]) {
    assert.ok(workspace.pages.length >= 2)
    assert.equal(workspace.path, workspace.pages[0].path)
    for (const page of workspace.pages) assert.ok(page.label && page.keywords)
  }
})
