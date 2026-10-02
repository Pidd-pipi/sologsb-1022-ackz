import type {
  Annotation,
  Chapter,
  HandoverPackage,
  ImportedPackageRecord,
  TextDocument,
  TextToken,
  VersionSnapshot
} from './types';
import { clone } from './editor';

/**
 * 离线批注合并。
 *
 * 规则：
 * 1. 按注释编号匹配：本地没有的新增注释直接接入。
 * 2. 两边改过同一注释（编号相同但内容不同）：保留双方，标记合并冲突，由人选定。
 * 3. 词级注释在正文/分词变化后跟随到同词；找不到同词则降级到所属句并标“待确认”。
 * 4. 同一交接包重复导入（或断网恢复后再次导入）不重复新增。
 * 5. 合并先做可撤销预演，确认后才写草稿并留快照。
 */

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

function hashString(value: string): string {
  // cyrb53 变体，足够做内容去重
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 正文章节指纹：句子文本变化即变化 */
export function fingerprintChapters(chapters: Chapter[]): string {
  const raw = chapters
    .map((chapter) => `${chapter.id}:${chapter.sentences.map((sentence) => sentence.text).join('')}`)
    .join('');
  return hashString(raw);
}

function fingerprintAnnotations(annotations: Annotation[]): string {
  const raw = annotations
    .map((annotation) =>
      [
        annotation.id,
        annotation.anchorId,
        annotation.anchorType,
        annotation.kind,
        annotation.title,
        annotation.body,
        annotation.source,
        annotation.references.join(','),
        annotation.tags.join(',')
      ].join('')
    )
    .sort()
    .join('');
  return hashString(raw);
}

/** 交接包内容指纹：章节 + 注释 */
export function fingerprintPackage(pkg: HandoverPackage): string {
  return hashString(`${fingerprintChapters(pkg.chapters)}|${fingerprintAnnotations(pkg.annotations)}`);
}

// ---------------------------------------------------------------------------
// 词级引用重定位
// ---------------------------------------------------------------------------

interface ParsedTokenId {
  sentenceId: string;
  index: number;
}

function parseTokenId(tokenId: string): ParsedTokenId | null {
  const match = /^(sentence-\d+-\d+)-token-(\d+)-/.exec(tokenId);
  if (!match) return null;
  return { sentenceId: match[1], index: Number.parseInt(match[2], 10) };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

/** 内容是否相同（不含锚点：锚点由重定位处理） */
function contentEqual(a: Annotation, b: Annotation): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.body === b.body &&
    a.source === b.source &&
    arraysEqual(a.references, b.references) &&
    arraysEqual(a.tags, b.tags)
  );
}

export interface ReanchorResult {
  annotation: Annotation;
  /** 成功跟随到同词 */
  reanchored: boolean;
  /** 降级到所属句，待确认 */
  downgraded: boolean;
  note?: string;
}

/**
 * 把外来词级注释重定位到本地正文：
 * 1. 本地仍有同 ID 词 → 不动；
 * 2. 所属句存在 → 按包内分词文本找同词（优先同序号）；
 * 3. 找不到同词 → 降级到所属句并标待确认；
 * 4. 所属句也不存在 → 保留原锚点并标待确认。
 */
function reanchorWordAnnotation(
  incoming: Annotation,
  localChapters: Chapter[],
  packageChapters: Chapter[]
): ReanchorResult {
  const moved = clone(incoming);
  if (incoming.anchorType !== 'word') {
    return { annotation: moved, reanchored: false, downgraded: false };
  }

  // 1. 本地仍有同 ID 词
  for (const chapter of localChapters) {
    for (const sentence of chapter.sentences) {
      if (sentence.tokens.some((token) => token.id === incoming.anchorId)) {
        return { annotation: moved, reanchored: false, downgraded: false };
      }
    }
  }

  const parsed = parseTokenId(incoming.anchorId);
  const sentenceId = parsed?.sentenceId;
  const localSentence = sentenceId
    ? localChapters.flatMap((chapter) => chapter.sentences).find((sentence) => sentence.id === sentenceId)
    : undefined;

  if (!localSentence) {
    moved.pendingReview = true;
    moved.reviewNote = '合并时正文版本已更新，原词与所属句均未找到，引用待人工确认。';
    return { annotation: moved, reanchored: false, downgraded: true, note: moved.reviewNote };
  }

  // 2. 取包内该词的分词文本
  const packageSentence = packageChapters.flatMap((chapter) => chapter.sentences).find((sentence) => sentence.id === sentenceId);
  let tokenText = '';
  if (packageSentence && parsed) {
    const token = packageSentence.tokens.find((item) => {
      const itemParsed = parseTokenId(item.id);
      return itemParsed?.sentenceId === sentenceId && itemParsed?.index === parsed?.index;
    });
    tokenText = token?.text ?? '';
  }

  // 3. 在本地句中找同词（优先同序号）
  let match: TextToken | undefined;
  if (tokenText) {
    const candidates = localSentence.tokens.filter((token) => token.text === tokenText);
    match =
      candidates.find((token) => {
        const itemParsed = parseTokenId(token.id);
        return itemParsed?.index === parsed?.index;
      }) ?? candidates[0];
  }
  if (!match && parsed) {
    // 包内未带分词文本时的兜底：同序号词
    const candidate = localSentence.tokens[parsed.index];
    if (candidate && (!tokenText || candidate.text === tokenText)) match = candidate;
  }

  if (match) {
    moved.anchorId = match.id;
    return { annotation: moved, reanchored: true, downgraded: false };
  }

  // 4. 降级到所属句
  moved.anchorId = localSentence.id;
  moved.anchorType = 'sentence';
  moved.pendingReview = true;
  moved.reviewNote = '合并时正文或分词已变化，原词未找到同词，已降到所属句，待人工确认。';
  return { annotation: moved, reanchored: false, downgraded: true, note: moved.reviewNote };
}

// ---------------------------------------------------------------------------
// 预演
// ---------------------------------------------------------------------------

export interface PreviewEntry {
  /** 包内原始注释 ID */
  originalId: string;
  /** 合并到本地后的最终 ID */
  finalId: string;
  /** 待写入的注释（已应用重定位、合并字段） */
  incoming: Annotation;
  /** 本地已有的同 ID 注释（若有） */
  local?: Annotation;
  status: 'new' | 'modified' | 'unchanged';
  reanchored: boolean;
  downgraded: boolean;
}

export interface MergePreview {
  pkg: HandoverPackage;
  /** 该交接包是否已导入过 */
  alreadyImported: boolean;
  importedAt?: string;
  entries: PreviewEntry[];
  added: PreviewEntry[];
  modified: PreviewEntry[];
  reanchored: PreviewEntry[];
  downgraded: PreviewEntry[];
  unchanged: PreviewEntry[];
}

export function computeMergePreview(document: TextDocument, pkg: HandoverPackage): MergePreview {
  const record = document.importedPackages.find(
    (item) => item.id === pkg.id || item.fingerprint === fingerprintPackage(pkg)
  );

  const preview: MergePreview = {
    pkg,
    alreadyImported: Boolean(record),
    importedAt: record?.importedAt,
    entries: [],
    added: [],
    modified: [],
    reanchored: [],
    downgraded: [],
    unchanged: []
  };

  if (record) return preview;

  for (const incoming of pkg.annotations) {
    const { annotation: moved, reanchored, downgraded } = reanchorWordAnnotation(
      incoming,
      document.chapters,
      pkg.chapters
    );
    const local = document.annotations.find((item) => item.id === incoming.id);

    let finalId = incoming.id;
    let status: PreviewEntry['status'] = 'new';

    if (local) {
      if (contentEqual(local, moved)) {
        status = 'unchanged';
      } else {
        // 两边改过同一注释：保留双方，外来方复制为新 ID 并标记合并冲突
        finalId = `${incoming.id}__${pkg.id}`;
        moved.id = finalId;
        moved.mergeOf = incoming.id;
        moved.mergeGroup = `mg-${incoming.id}-${pkg.id}`;
        moved.conflictState = 'open';
        status = 'modified';
      }
    } else {
      moved.mergePackageId = pkg.id;
    }

    const entry: PreviewEntry = {
      originalId: incoming.id,
      finalId,
      incoming: moved,
      local,
      status,
      reanchored,
      downgraded
    };
    preview.entries.push(entry);
    if (status === 'new') preview.added.push(entry);
    if (status === 'modified') preview.modified.push(entry);
    if (status === 'unchanged') preview.unchanged.push(entry);
    if (reanchored) preview.reanchored.push(entry);
    if (downgraded) preview.downgraded.push(entry);
  }

  return preview;
}

// ---------------------------------------------------------------------------
// 应用合并
// ---------------------------------------------------------------------------

export interface MergeResult {
  added: number;
  modified: number;
  reanchored: number;
  downgraded: number;
  unchanged: number;
}

/** 把预演结果写入文档，并留快照、登记交接包。 */
export function applyMerge(document: TextDocument, preview: MergePreview): MergeResult {
  const result: MergeResult = {
    added: preview.added.length,
    modified: preview.modified.length,
    reanchored: preview.reanchored.length,
    downgraded: preview.downgraded.length,
    unchanged: preview.unchanged.length
  };

  if (preview.alreadyImported) return result;

  // 引用重映射：包内 ID → 本地最终 ID
  const idRemap = new Map<string, string>();
  for (const entry of preview.entries) {
    idRemap.set(entry.originalId, entry.finalId);
  }

  for (const entry of preview.entries) {
    if (entry.status === 'unchanged') continue;
    entry.incoming.references = entry.incoming.references.map((ref) => idRemap.get(ref) ?? ref);
    document.annotations.push(entry.incoming);
    // 双方修改：本地注释也标记同一合并组，冲突面板才能把双方配成一组
    if (entry.status === 'modified' && entry.local) {
      entry.local.mergeGroup = entry.incoming.mergeGroup;
    }
  }

  const now = new Date().toISOString();

  const record: ImportedPackageRecord = {
    id: preview.pkg.id,
    label: preview.pkg.label,
    fingerprint: fingerprintPackage(preview.pkg),
    importedAt: now,
    annotationIds: preview.entries
      .filter((entry) => entry.status !== 'unchanged')
      .map((entry) => entry.finalId)
  };
  document.importedPackages.push(record);

  const snapshot: VersionSnapshot = {
    id: `snapshot-merge-${Date.now().toString(36)}`,
    label: `离线合并 · ${preview.pkg.label}`,
    note: `交接包 ${preview.pkg.id}：新增 ${result.added}，双方修改 ${result.modified}，跟随到词 ${result.reanchored}，降级待确认 ${result.downgraded}，无变化 ${result.unchanged}`,
    createdAt: now,
    chapters: clone(document.chapters),
    annotations: clone(document.annotations)
  };
  document.snapshots.push(snapshot);
  document.updatedAt = now;

  return result;
}

// ---------------------------------------------------------------------------
// 导出交接包
// ---------------------------------------------------------------------------

export function buildHandoverPackage(document: TextDocument): HandoverPackage {
  const now = new Date().toISOString();
  return {
    id: `handover-${document.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: `${document.title} · 离线交接包`,
    exportedAt: now,
    sourceDocumentId: document.id,
    baseFingerprint: fingerprintChapters(document.chapters),
    chapters: clone(document.chapters),
    annotations: clone(document.annotations)
  };
}
