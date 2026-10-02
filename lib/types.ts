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
  /** 离线交接包溯源：来自哪个交接包 */
  originPackageId?: string;
  /** 离线交接包溯源：由哪位组员带出 */
  originMember?: string;
  /** 词级锚点随正文/分词变化降到句级，等待人工确认 */
  pendingConfirmation?: boolean;
  /** 合并过程附给整理者的说明 */
  mergeNote?: string;
  /** 双方修改同一注释时，孪生稿记录的配对号 */
  mergePairId?: string;
  /** 本地稿可能连续与多份交接包冲突，这里记录它参与的全部配对号 */
  mergePairs?: string[];
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
  updatedAt: string;
  /** 已导入的离线交接包，按包 ID 去重 */
  importedPackages: ImportedPackageRecord[];
}

/** 离线交接包：组员在内网之外带出的整包工作副本 */
export interface HandoffPackage {
  format: 'jiguantang-handoff/v1';
  /** 内容指纹，同一份数据重复导出时指纹相同，用于幂等 */
  packageId: string;
  documentId: string;
  documentTitle: string;
  member: string;
  note: string;
  exportedAt: string;
  /** 带出时所依据的内网版本快照 ID */
  baseSnapshotId: string;
  baseSnapshotLabel: string;
  baseChapters: Chapter[];
  baseAnnotations: Annotation[];
  chapters: Chapter[];
  annotations: Annotation[];
}

/** 交接包导入登记，防止同一交接包重复/断网恢复后再次导入 */
export interface ImportedPackageRecord {
  packageId: string;
  member: string;
  note: string;
  importedAt: string;
  /** 导入时新增/修改/冲突/待确认的条目数 */
  added: number;
  changed: number;
  conflicts: number;
  pending: number;
  /** 内容指纹相同的另一份导出，可凭此再次拦截 */
  fingerprint: string;
}

/** 预演中每条注释的处置方式 */
export type MergeOpStatus =
  | 'add'
  | 'update-incoming'
  | 'conflict-open'
  | 'identical-skip'
  | 'local-newer-skip'
  | 'already-imported-skip';

export interface MergeOp {
  status: MergeOpStatus;
  annotation: Annotation;
  localAnnotation?: Annotation;
  baseAnnotation?: Annotation;
  /** 预演解析后的最终锚点 */
  resolvedAnchorId: string;
  resolvedAnchorType: AnchorType;
  /** 词级注释跟到同词；找不到降到所属句待确认 */
  anchorFollow: 'unchanged' | 'word-followed' | 'downgraded-sentence' | 'sentence-fallback' | 'chapter-fallback';
  pending: boolean;
  note: string;
}

/** 正文版本差异（交接包带出文本与本地稿之间） */
export interface MergeTextDelta {
  sentenceId: string;
  label: string;
  localText: string;
  incomingText: string;
  baseText: string;
  changed: boolean;
}

/** 可撤销预演结果：只描述将要发生什么，不写草稿 */
export interface MergePlan {
  pkg: HandoffPackage;
  alreadyImported: boolean;
  importedReason: string;
  fingerprintMatch?: string;
  ops: MergeOp[];
  textDeltas: MergeTextDelta[];
  counts: {
    add: number;
    updateIncoming: number;
    conflicts: number;
    pending: number;
    skips: number;
    textChanged: number;
  };
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
}
