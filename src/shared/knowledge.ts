/** Local lexical retrieval only: no embeddings, remote search or PDF coverage implied. */
export const KNOWLEDGE_LIMITS = {
  queryChars: 512,
  queryTerms: 64,
  results: 20,
  chunkChars: 1000,
  fieldChars: 24000,
  candidateChunks: 20000,
  contextChars: 8000,
  activityRows: 200
} as const

export type KnowledgeField = 'title' | 'abstract' | 'notes'
export type ReferenceActivityKind = 'created' | 'imported' | 'read' | 'note_updated' | 'pdf_attached' | 'deleted'
export type ReferenceReadChannel = 'reference_view' | 'pdf_read' | 'mcp_read'

export interface KnowledgeHit {
  sourceId: string
  referenceId: string
  projectId: string
  title: string
  field: KnowledgeField
  /** Logical registered-library path, never an arbitrary file supplied by the renderer. */
  path: string
  excerpt: string
  /** UTF-16 offsets in normalized, secret-redacted indexed field text. */
  start: number
  end: number
  score: number
  indexedAt: string
  coverage: 'metadata-only'
}

export interface KnowledgeSearchInput { projectId: string; query: string; limit?: number }
export interface KnowledgeSearchResult {
  query: string
  method: 'local-bm25'
  hits: KnowledgeHit[]
  queryTruncated: boolean
  candidatesTruncated: boolean
  limitation: string
}
export interface KnowledgeStatus {
  projectId: string
  method: 'local-bm25'
  references: number
  indexedReferences: number
  pendingReferences: number
  chunks: number
  pdfAttachments: number
  lastIndexedAt: string | null
  coverage: 'metadata-only'
  limitation: string
  errors: Array<{ referenceId: string; message: string }>
}
export interface ReferenceActivity {
  id: string
  projectId: string
  referenceId: string
  title: string
  kind: ReferenceActivityKind
  channel: string
  createdAt: string
}
