export interface WorkspacePage { path: string; label: string; keywords: string }
export interface WorkspaceNavigation { id: string; label: string; path: string; pages: readonly WorkspacePage[] }

export const PRIMARY_WORKSPACES: readonly WorkspaceNavigation[] = [
  { id: 'home', label: '工作台', path: '/', pages: [
    { path: '/', label: '概览', keywords: '首页 项目 home dashboard' },
    { path: '/research', label: '研究探索', keywords: '选题 视角 讨论 research' },
    { path: '/pipeline', label: '研究流程', keywords: '一键 流水线 pipeline workflow' }
  ] },
  { id: 'assistant', label: '助手', path: '/agent', pages: [
    { path: '/agent', label: '对话', keywords: '研究助手 智能体 任务 agent chat' },
    { path: '/skills', label: '技能库', keywords: '科研技能 安装 skills' }
  ] },
  { id: 'literature', label: '文献', path: '/library', pages: [
    { path: '/library', label: '文献库', keywords: '资料 阅读 PDF library references' },
    { path: '/notes', label: '笔记', keywords: '研究笔记 页面关联 收藏 回收站 notes' },
    { path: '/knowledge', label: '知识检索', keywords: '项目知识库 阅读记录 共享上下文 RAG knowledge' }
  ] },
  { id: 'experiments', label: '实验', path: '/experiments', pages: [
    { path: '/experiments', label: '实验与分析', keywords: '运行 代码 experiment runs' },
    { path: '/methods', label: '方法复用', keywords: '论文方法 复现 methods' },
    { path: '/figures', label: '绘图', keywords: '科研绘图 图表 演示 PPT figures plots' }
  ] },
  { id: 'writing', label: '写作', path: '/writing', pages: [
    { path: '/writing', label: '稿件', keywords: '论文工作台 文档 DOCX LaTeX paper writing' },
    { path: '/writing-quality', label: '检查与润色', keywords: '写作质量 规范改写 去AI味 引用 查重 重复 知网 维普 style similarity' }
  ] }
]

export const SETTINGS_WORKSPACE: WorkspaceNavigation = { id: 'settings', label: '设置', path: '/settings', pages: [
  { path: '/settings', label: '模型与偏好', keywords: '设置 API Key settings' },
  { path: '/mcp', label: '工具连接', keywords: 'MCP 工具 mcp' },
  { path: '/setup', label: '环境检查', keywords: '使用准备 Python LaTeX setup' },
  { path: '/backups', label: '备份与恢复', keywords: '导出 迁移 备份 backups' }
] }

function matches(pathname: string, path: string): boolean {
  const normalized = pathname.replace(/\/+$/, '').toLowerCase() || '/'
  if (path === '/notes') return normalized === path || normalized.startsWith('/notes/')
  if (path === '/writing') return normalized === path || normalized.startsWith('/write/')
  return normalized === path
}
export function workspaceForPath(pathname: string): WorkspaceNavigation | undefined {
  return [...PRIMARY_WORKSPACES, SETTINGS_WORKSPACE].find(workspace => workspace.pages.some(page => matches(pathname, page.path)))
}
export function pageForPath(pathname: string): WorkspacePage | undefined {
  return workspaceForPath(pathname)?.pages.find(page => matches(pathname, page.path))
}
