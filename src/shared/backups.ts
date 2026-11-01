/** Project research-data backups, not an account/configuration or full-workspace clone. */
export interface BackupSummary {
  counts: Record<string, number>
  fileCount: number
  totalBytes: number
  warnings: string[]
}
export interface BackupExportResult extends BackupSummary { path: string }
export interface BackupPreview extends BackupSummary {
  token: string
  projectName: string
  createdAt: string
}
export interface BackupRestoreResult extends BackupSummary {
  projectId: string
  rootPath: string
  name: string
}

export const BACKUP_LIMITS = Object.freeze({ files: 5000, bytes: 256 * 1024 * 1024, metadataBytes: 16 * 1024 * 1024, rows: 50000, tokenLifetimeMs: 10 * 60 * 1000 })
export const BACKUP_WARNINGS: readonly string[] = Object.freeze([
  '这是单个项目的研究资料备份，不是整个工作区或账户备份；请逐个备份需要保留的项目。',
  '包含文献、文稿及历史版本、笔记（含回收站和链接）、阅读草稿、PDF 批注、图表及可编辑源文件、实验代码/指标和允许的研究文件。',
  '不包含聊天/智能体会话、流水线、搜索索引、账户、模型密钥、SSH 配置、桥接令牌、隐藏配置、技能、运行命令/环境/日志。搜索索引可重新建立。',
  '仅收录 manuscripts、references、experiments、figures、data、exports 中允许的研究文件类型；隐藏文件、配置/凭据文件、依赖目录和其他文件类型不收录。已登记但缺失或不安全的资料会使备份失败，而非静默丢失。',
  '恢复会创建全新项目、目录及记录 ID，不覆盖原项目；实验恢复为本地 idle 状态，不执行代码。笔记内部链接会重映射；文件内容中的来源 ID、路径、图表证据标签保留原始溯源，需人工核对。',
  '备份未加密：研究文本或代码中自行写入的敏感内容仍可能包含在内，请保存在可信本地位置。SHA-256 只校验完整性，不证明文件来源可信；只恢复自己信任的备份。'
])

export function backupId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || /\s/.test(value)) throw new Error('备份参数无效。')
  return value
}
