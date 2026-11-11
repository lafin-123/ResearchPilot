import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { pageForPath, workspaceForPath } from '../lib/workspace-navigation'

export function WorkspaceNav(): ReactNode {
  const { pathname } = useLocation()
  const workspace = workspaceForPath(pathname)
  const activePage = pageForPath(pathname)
  if (!workspace) return null
  return <nav className="workspace-nav" aria-label={`${workspace.label}内导航`}>
    {workspace.pages.map(page => <Link key={page.path} to={page.path} aria-current={activePage?.path === page.path ? 'page' : undefined} className={`workspace-nav-link${activePage?.path === page.path ? ' active' : ''}`}>{page.label}</Link>)}
  </nav>
}
