import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    root_path TEXT NOT NULL UNIQUE,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('docx','latex')),
    file_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, position);

  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions(document_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS reference_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '',
    doi TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    abstract TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    pdf_relative_path TEXT NOT NULL DEFAULT '',
    bibtex TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_references_project ON reference_items(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'python',
    entry_file TEXT NOT NULL DEFAULT 'main.py',
    env_kind TEXT NOT NULL DEFAULT 'local',
    ssh_host_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    last_run_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS experiment_runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    exit_code INTEGER,
    command TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    stdout TEXT NOT NULL DEFAULT '',
    stderr TEXT NOT NULL DEFAULT '',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    artifact_dir TEXT NOT NULL DEFAULT '',
    env_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_runs_experiment ON experiment_runs(experiment_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_project ON experiment_runs(project_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS figures (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    experiment_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    format TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_figures_project ON figures(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '新对话',
    dsh_session_id TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON chat_messages(chat_id, created_at);

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key_enc TEXT NOT NULL DEFAULT '',
    models_json TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ssh_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_kind TEXT NOT NULL DEFAULT 'key',
    key_path TEXT NOT NULL DEFAULT '',
    password_enc TEXT NOT NULL DEFAULT '',
    passphrase_enc TEXT NOT NULL DEFAULT '',
    host_fingerprint TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL DEFAULT '~/researchpilot',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    current_stage TEXT NOT NULL DEFAULT '',
    auto_run INTEGER NOT NULL DEFAULT 0,
    formats_json TEXT NOT NULL DEFAULT '[]',
    chat_id TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_project ON pipeline_runs(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS pipeline_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    prompt TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_steps_run ON pipeline_steps(run_id, position);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE chats ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(provider_id, model_id, created_at DESC);
  `,
  `
  CREATE TABLE knowledge_sources (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL REFERENCES reference_items(id) ON DELETE CASCADE,
    indexed_at TEXT NOT NULL,
    source_updated_at TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, reference_id)
  );
  CREATE TABLE knowledge_chunks (
    source_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL REFERENCES reference_items(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    excerpt TEXT NOT NULL,
    terms_json TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX idx_knowledge_project ON knowledge_chunks(project_id, reference_id);
  CREATE TABLE reference_activity (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_reference_activity_project ON reference_activity(project_id, created_at DESC);
  CREATE INDEX idx_reference_activity_debounce ON reference_activity(project_id, reference_id, kind, channel, created_at DESC);
  `,
  `
  CREATE TABLE project_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (project_id, id)
  );
  CREATE INDEX idx_notes_project ON project_notes(project_id, deleted_at, pinned DESC, updated_at DESC, id);
  CREATE TABLE note_links (
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (project_id, source_id, target_id),
    FOREIGN KEY (project_id, source_id) REFERENCES project_notes(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, target_id) REFERENCES project_notes(project_id, id) ON DELETE CASCADE
  );
  CREATE INDEX idx_note_backlinks ON note_links(project_id, target_id, source_id);
  `,
  `
  CREATE TABLE reference_reading_drafts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL REFERENCES reference_items(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    source_coverage TEXT NOT NULL CHECK (source_coverage = 'abstract-only'),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 40000),
    model_label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_reading_drafts_reference ON reference_reading_drafts(project_id, reference_id, created_at DESC);
  `,
  `
  CREATE TABLE pdf_annotations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL REFERENCES reference_items(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    page INTEGER NOT NULL CHECK (page BETWEEN 1 AND 10000),
    quote TEXT NOT NULL CHECK (length(quote) <= 4000),
    comment TEXT NOT NULL CHECK (length(comment) <= 4000),
    color TEXT NOT NULL CHECK (color IN ('yellow', 'green', 'rose')),
    rects_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_pdf_annotations_scope ON pdf_annotations(project_id, reference_id, fingerprint, page, created_at);
  `
]

export class Db {
  readonly raw: DatabaseSync

  readonly migrationBackupPath: string | null

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    const existed = existsSync(file) && lstatSync(file).size > 0
    this.raw = new DatabaseSync(file)
    let backup: string | null = null
    try {
      const version = this.scalar<number>('PRAGMA user_version') ?? 0
      if (version > MIGRATIONS.length) throw new Error(`数据库版本 ${version} 高于此应用支持的版本 ${MIGRATIONS.length}，请使用较新的 ResearchPilot，不能降级写入。`)
      if (existed && version < MIGRATIONS.length) {
        const directory = join(dirname(file), 'migration-backups')
        if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('升级备份目录不能是符号链接。')
        mkdirSync(directory, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        backup = join(directory, `${basename(file)}.v${version}.${stamp}.${randomUUID().slice(0, 8)}.sqlite`)
        this.raw.prepare('VACUUM INTO ?').run(backup)
        try { chmodSync(backup, 0o600) } catch { /* Windows uses the OS profile's access permissions. */ }
      }
      this.raw.exec('PRAGMA journal_mode = WAL;')
      this.raw.exec('PRAGMA foreign_keys = ON;')
      this.raw.exec('PRAGMA synchronous = NORMAL;')
      this.migrate()
      this.migrationBackupPath = backup
    } catch (error) {
      this.raw.close()
      throw error
    }
  }

  private migrate(): void {
    const current = this.scalar<number>('PRAGMA user_version') ?? 0
    const start = Math.max(current, 0)
    for (let index = start; index < MIGRATIONS.length; index += 1) {
      this.raw.exec('BEGIN')
      try {
        this.raw.exec(MIGRATIONS[index]!)
        this.raw.exec(`PRAGMA user_version = ${index + 1}`)
        this.raw.exec('COMMIT')
      } catch (error) {
        this.raw.exec('ROLLBACK')
        throw error
      }
    }
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql)
  }

  run(sql: string, ...params: Array<string | number | bigint | null | Uint8Array>): void {
    this.raw.prepare(sql).run(...params)
  }

  get<T>(sql: string, ...params: Array<string | number | bigint | null>): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: Array<string | number | bigint | null>): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }

  scalar<T>(sql: string, ...params: Array<string | number | bigint | null>): T | undefined {
    const row = this.raw.prepare(sql).get(...params) as Record<string, T> | undefined
    if (!row) return undefined
    return Object.values(row)[0]
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.raw.close()
  }
}
