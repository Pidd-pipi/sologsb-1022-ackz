export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  updatedAt: string;
  /** 来源交接包 ID（离线合并引入的注释） */
  mergePackageId?: string;
  /** 合并冲突组 ID：双方离线修改了同一条注释，保留双方待人工选定 */
  mergeGroup?: string;
  /** 复制自哪条注释的原始 ID（合并冲突的另一方） */
  mergeOf?: string;
  /** 待确认：词级引用在正文/分词变化后降级到所属句 */
  pendingReview?: boolean;
  /** 待确认说明 */
  reviewNote?: string;
}

/** 已导入的离线交接包记录，用于重复导入去重 */
export interface ImportedPackageRecord {
  id: string;
  label: string;
  /** 包内容指纹（章节 + 注释），内容相同即视为同一个包 */
  fingerprint: string;
  importedAt: string;
  /** 本包引入的注释最终 ID 列表 */
  annotationIds: string[];
}

/** 离线交接包：各机器导出后带回内网合并的批注集合 */
export interface HandoverPackage {
  id: string;
  label: string;
  exportedAt: string;
  sourceDocumentId: string;
  /** 导出时的正文指纹 */
  baseFingerprint?: string;
  /** 导出时的章节正文，用于合并时重定位词级引用 */
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  /** 已导入的离线交接包记录 */
  importedPackages: ImportedPackageRecord[];
  updatedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
  /** 非空表示这是离线合并产生的双方修改冲突 */
  mergeGroup?: string;
}
