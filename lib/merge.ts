import type {
  AnchorType,
  Annotation,
  Chapter,
  HandoffPackage,
  ImportedPackageRecord,
  MergeOp,
  MergePlan,
  Sentence,
  TextDocument,
  TextToken
} from './types';

export const HANDOFF_FORMAT = 'jiguantang-handoff/v1';

/* ---------------------------------- 工具 ---------------------------------- */

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** cyrb53 风格的稳定内容指纹：同一份交接内容重复导出，指纹必然相同 */
function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (BigInt(h1 >>> 0).toString(16).padStart(8, '0') + BigInt(h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

function indexSentences(chapters: Chapter[]): Map<string, { chapter: Chapter; sentence: Sentence }> {
  const map = new Map<string, { chapter: Chapter; sentence: Sentence }>();
  for (const chapter of chapters) {
    for (const sentence of chapter.sentences) map.set(sentence.id, { chapter, sentence });
  }
  return map;
}

function findToken(sentence: Sentence | undefined, tokenId: string): TextToken | undefined {
  return sentence?.tokens.find((token) => token.id === tokenId);
}

/* ------------------------------ 注释内容比对 ------------------------------ */

const SIGNATURE_FIELDS = ['kind', 'title', 'body', 'source', 'references', 'tags', 'status'] as const;

function editorialSignature(annotation: Annotation): string {
  return JSON.stringify(SIGNATURE_FIELDS.map((field) => annotation[field]));
}

/** 仅比较整理者会改动的条文内容；锚点迁移、合并元数据不参与 */
function sameEditorial(a: Annotation, b: Annotation): boolean {
  return editorialSignature(a) === editorialSignature(b);
}

/* -------------------------------- 锚点解析 -------------------------------- */

interface ResolvedAnchor {
  anchorId: string;
  anchorType: AnchorType;
  follow: MergeOp['anchorFollow'];
  pending: boolean;
  note: string;
}

/**
 * 把交接包里的引用目标解析到本地稿：
 * 词级注释优先跟到同词（按词形在所属句内对齐），找不到就降到所属句并标记待确认；
 * 所属句也不存在时退到所属章；章也找不到时落到首章。
 */
function resolveAnchor(
  annotation: Annotation,
  pkg: HandoffPackage,
  document: TextDocument
): ResolvedAnchor {
  const localSentences = indexSentences(document.chapters);
  const incomingSentences = indexSentences(pkg.chapters);
  const baseSentences = indexSentences(pkg.baseChapters);

  const localChapter = document.chapters.find((chapter) =>
    chapter.sentences.some((sentence) => sentence.id === annotation.anchorId)
  ) ?? document.chapters.find((chapter) =>
    chapter.sentences.some((sentence) => sentence.tokens.some((token) => token.id === annotation.anchorId))
  );

  if (annotation.anchorType === 'chapter') {
    const chapter = document.chapters.find((item) => item.id === annotation.anchorId);
    if (chapter) return { anchorId: chapter.id, anchorType: 'chapter', follow: 'unchanged', pending: false, note: '' };
    const fallback = document.chapters[0];
    return {
      anchorId: fallback.id,
      anchorType: 'chapter',
      follow: 'chapter-fallback',
      pending: true,
      note: `交接包中的章节“${annotation.anchorId}”在本地稿不存在，暂挂首章，请重新指定目标。`
    };
  }

  const sourceSentenceId =
    incomingSentences.get(annotation.anchorId)?.sentence.id ??
    (annotation.anchorType === 'word'
      ? [...incomingSentences.values()].find((item) => item.sentence.tokens.some((token) => token.id === annotation.anchorId))?.sentence.id
      : undefined) ??
    annotation.anchorId;

  const localEntry = localSentences.get(sourceSentenceId);

  if (annotation.anchorType === 'sentence') {
    if (localEntry) return { anchorId: localEntry.sentence.id, anchorType: 'sentence', follow: 'unchanged', pending: false, note: '' };
    if (localChapter) {
      return {
        anchorId: localChapter.id,
        anchorType: 'chapter',
        follow: 'chapter-fallback',
        pending: true,
        note: '原属句子在本地稿中不存在，已降到章节级，请确认目标。'
      };
    }
    const fallback = document.chapters[0];
    return {
      anchorId: fallback.id,
      anchorType: 'chapter',
      follow: 'chapter-fallback',
      pending: true,
      note: '原属句子与章节在本地稿中均不存在，暂挂首章，请重新指定目标。'
    };
  }

  // 词级注释：先在交接包/底本中找到词形，再到本地同句里按词形跟随
  const incomingToken =
    findToken(incomingSentences.get(sourceSentenceId)?.sentence, annotation.anchorId) ??
    findToken(baseSentences.get(sourceSentenceId)?.sentence, annotation.anchorId);
  const tokenText = incomingToken?.text;
  const tokenIndex = localEntry ? incomingSentences.get(sourceSentenceId)?.sentence.tokens.findIndex((token) => token.id === annotation.anchorId) : -1;

  if (localEntry && tokenText && tokenText.trim()) {
    const localTokens = localEntry.sentence.tokens;
    let matched: TextToken | undefined;
    if (tokenIndex && tokenIndex >= 0 && localTokens[tokenIndex]?.text === tokenText) {
      matched = localTokens[tokenIndex];
    } else {
      matched = localTokens.find((token) => token.text === tokenText);
    }
    if (matched) {
      if (matched.id === annotation.anchorId) {
        return { anchorId: matched.id, anchorType: 'word', follow: 'unchanged', pending: false, note: '' };
      }
      return {
        anchorId: matched.id,
        anchorType: 'word',
        follow: 'word-followed',
        pending: false,
        note: `正文或分词有变化，词级注释已由“${annotation.anchorId}”跟到同词“${tokenText.trim()}”。`
      };
    }
    return {
      anchorId: localEntry.sentence.id,
      anchorType: 'sentence',
      follow: 'downgraded-sentence',
      pending: true,
      note: `本地同句中找不到词“${tokenText.trim()}”，词级注释已降到所属句，待人工确认。`
    };
  }

  if (localEntry) {
    return {
      anchorId: localEntry.sentence.id,
      anchorType: 'sentence',
      follow: 'downgraded-sentence',
      pending: true,
      note: '交接包中的词语锚点无法识别，已降到所属句，待人工确认。'
    };
  }

  const fallbackChapter = localChapter ?? document.chapters[0];
  return {
    anchorId: fallbackChapter.id,
    anchorType: 'chapter',
    follow: 'chapter-fallback',
    pending: true,
    note: '词与原属句子在本地稿中均不存在，暂挂章节，请重新指定目标。'
  };
}

/* -------------------------------- 正文版本 -------------------------------- */

function buildTextDeltas(document: TextDocument, pkg: HandoffPackage): MergePlan['textDeltas'] {
  const local = indexSentences(document.chapters);
  const base = indexSentences(pkg.baseChapters);
  const deltas: MergePlan['textDeltas'] = [];
  for (const chapter of pkg.chapters) {
    for (const sentence of chapter.sentences) {
      const localEntry = local.get(sentence.id);
      if (!localEntry) continue; // 新增句不进入注释合并范围
      const localText = localEntry.sentence.text;
      if (localText === sentence.text) continue;
      deltas.push({
        sentenceId: sentence.id,
        label: `${localEntry.chapter.title} · 第 ${localEntry.sentence.order} 句`,
        localText,
        incomingText: sentence.text,
        baseText: base.get(sentence.id)?.sentence.text ?? sentence.text,
        changed: true
      });
    }
  }
  return deltas;
}

/* -------------------------------- 合并预演 -------------------------------- */

/**
 * 生成可撤销预演：纯函数，只读取本地稿与交接包，不改任何数据。
 * 三方 = 本地稿（内网当前草稿）、交接包（组员离线稿）、底本快照（带出时依据）。
 */
export function buildMergePlan(document: TextDocument, pkg: HandoffPackage): MergePlan {
  const localById = new Map(document.annotations.map((item) => [item.id, item]));
  const baseById = new Map(pkg.baseAnnotations.map((item) => [item.id, item]));

  const exactImported = document.importedPackages.find((item) => item.packageId === pkg.packageId);
  const fingerprintMatch = document.importedPackages.find((item) => item.fingerprint === pkg.packageId.slice(4));
  const alreadyImported = Boolean(exactImported || fingerprintMatch);

  const ops: MergeOp[] = [];

  if (alreadyImported) {
    const record = exactImported ?? fingerprintMatch;
    return {
      pkg,
      alreadyImported: true,
      importedReason: `该交接包（${record?.member}）已于 ${record?.importedAt} 导入，重复导入不会新增任何注释。`,
      fingerprintMatch: fingerprintMatch?.packageId,
      ops: [],
      textDeltas: buildTextDeltas(document, pkg),
      counts: { add: 0, updateIncoming: 0, conflicts: 0, pending: 0, skips: 0, textChanged: 0 }
    };
  }

  for (const rawIncoming of pkg.annotations) {
    const incoming = clone(rawIncoming);
    const local = localById.get(incoming.id) ? clone(localById.get(incoming.id)!) : undefined;
    const base = baseById.get(incoming.id) ? clone(baseById.get(incoming.id)!) : undefined;
    const anchor = resolveAnchor(incoming, pkg, document);

    let status: MergeOp['status'];
    let note = anchor.note;

    if (local && base) {
      // 三方都有：逐条判定
      if (sameEditorial(local, incoming)) {
        status = 'identical-skip';
        note = note || '双方条文一致，无需处理。';
      } else if (sameEditorial(incoming, base)) {
        status = 'local-newer-skip';
        note = note || '对方稿未改动该注释，本地稿较新，保留本地。';
      } else if (sameEditorial(local, base)) {
        status = 'update-incoming';
        note = note || '仅对方改过，将采用对方条文（锚点按本地正文解析）。';
      } else {
        status = 'conflict-open';
        note = note || '双方都改过同一注释，将保留双方原文，列入冲突由人工选定。';
      }
    } else if (local && !base) {
      // 同号但底本没有：两边各自离线新增撞号，按冲突处理
      status = sameEditorial(local, incoming) ? 'identical-skip' : 'conflict-open';
      note = sameEditorial(local, incoming)
        ? '双方各自新增且条文一致，无需重复添加。'
        : '双方离线新增使用了相同编号且条文不同，保留双方列入冲突。';
    } else if (!local && base) {
      // 本地稿已删除该注释：尊重本地删除决定，不借导入复活
      status = 'local-newer-skip';
      note = '本地稿已删除该注释，导入不恢复；如确需找回请人工处理。';
    } else {
      status = 'add';
      note = note || '对方离线新增注释，将直接接上。';
    }

    ops.push({
      status,
      annotation: incoming,
      localAnnotation: local,
      baseAnnotation: base,
      resolvedAnchorId: anchor.anchorId,
      resolvedAnchorType: anchor.anchorType,
      anchorFollow: anchor.follow,
      pending: anchor.pending && (status === 'add' || status === 'update-incoming' || status === 'conflict-open'),
      note
    });
  }

  const textDeltas = buildTextDeltas(document, pkg);

  const counts = {
    add: ops.filter((op) => op.status === 'add').length,
    updateIncoming: ops.filter((op) => op.status === 'update-incoming').length,
    conflicts: ops.filter((op) => op.status === 'conflict-open').length,
    pending: ops.filter((op) => op.pending).length,
    skips: ops.filter((op) => op.status.endsWith('-skip')).length,
    textChanged: textDeltas.length
  };

  return { pkg, alreadyImported: false, importedReason: '', ops, textDeltas, counts };
}

/* -------------------------------- 执行合并 -------------------------------- */

export interface AppliedMerge {
  added: number;
  changed: number;
  conflicts: number;
  pending: number;
  snapshotId: string;
  snapshotLabel: string;
}

/**
 * 按预演结果写草稿（就地修改传入文档），并留存合并快照与导入登记。
 * 再次执行同一包会被 importedPackages 拦截，保证断网恢复/重复导入不重复新增。
 */
export function applyMerge(document: TextDocument, plan: MergePlan, nowIso: string): AppliedMerge {
  if (plan.alreadyImported) {
    return { added: 0, changed: 0, conflicts: 0, pending: 0, snapshotId: '', snapshotLabel: '' };
  }
  if (document.importedPackages.some((item) => item.packageId === plan.pkg.packageId)) {
    return { added: 0, changed: 0, conflicts: 0, pending: 0, snapshotId: '', snapshotLabel: '' };
  }

  const pairSequence = new Map<string, number>();
  const idMap = new Map<string, string>();
  let added = 0;
  let changed = 0;
  let conflicts = 0;
  let pending = 0;

  const stamp = nowIso;

  for (const op of plan.ops) {
    if (op.status === 'identical-skip' || op.status === 'local-newer-skip' || op.status === 'already-imported-skip') {
      continue;
    }

    const rewriteRefs = (refs: string[]) => {
      const mapped = refs.map((ref) => idMap.get(ref) ?? ref);
      return [...new Set(mapped)];
    };

    if (op.status === 'add') {
      const finalId = uniqueAnnotationId(document, op.annotation.id, stamp, idMap);
      idMap.set(op.annotation.id, finalId);
      const merged: Annotation = {
        ...clone(op.annotation),
        id: finalId,
        anchorId: op.resolvedAnchorId,
        anchorType: op.resolvedAnchorType,
        references: rewriteRefs(op.annotation.references),
        status: 'open',
        conflictState: 'open',
        updatedAt: stamp,
        originPackageId: plan.pkg.packageId,
        originMember: plan.pkg.member,
        pendingConfirmation: op.pending || undefined,
        mergeNote: op.note || undefined
      };
      document.annotations.push(merged);
      added += 1;
      if (op.pending) pending += 1;
      continue;
    }

    if (op.status === 'update-incoming' && op.localAnnotation) {
      const target = document.annotations.find((item) => item.id === op.localAnnotation!.id);
      if (!target) continue;
      Object.assign(target, {
        kind: op.annotation.kind,
        title: op.annotation.title,
        body: op.annotation.body,
        source: op.annotation.source,
        tags: clone(op.annotation.tags),
        references: rewriteRefs(op.annotation.references),
        anchorId: op.resolvedAnchorId,
        anchorType: op.resolvedAnchorType,
        updatedAt: stamp,
        originPackageId: plan.pkg.packageId,
        originMember: plan.pkg.member,
        pendingConfirmation: op.pending || undefined,
        mergeNote: op.note || undefined
      });
      changed += 1;
      if (op.pending) pending += 1;
      continue;
    }

    if (op.status === 'conflict-open' && op.localAnnotation) {
      const pairBase = `pair-${stableHash(`${plan.pkg.packageId}:${op.localAnnotation.id}`)}`;
      const seq = (pairSequence.get(pairBase) ?? 0) + 1;
      pairSequence.set(pairBase, seq);
      const pairId = `${pairBase}-${seq}`;
      const twinId = uniqueAnnotationId(
        document,
        `annotation-merged-${stableHash(`${plan.pkg.packageId}:${op.annotation.id}:${seq}`)}`,
        stamp,
        idMap
      );
      idMap.set(op.annotation.id, twinId);

      const local = document.annotations.find((item) => item.id === op.localAnnotation!.id);
      if (local) {
        local.conflictState = 'open';
        local.mergePairs = [...new Set([...(local.mergePairs ?? []), pairId])];
        local.mergePairId = undefined;
        local.conflictResolution = undefined;
        local.updatedAt = stamp;
      }
      const twin: Annotation = {
        ...clone(op.annotation),
        id: twinId,
        anchorId: op.resolvedAnchorId,
        anchorType: op.resolvedAnchorType,
        references: rewriteRefs(op.annotation.references),
        status: 'open',
        conflictState: 'open',
        updatedAt: stamp,
        originPackageId: plan.pkg.packageId,
        originMember: plan.pkg.member,
        pendingConfirmation: op.pending || undefined,
        mergeNote: op.note ? `${op.note}（对方稿条文，来源：${op.annotation.source}）` : `对方稿条文，来源：${op.annotation.source}`,
        mergePairId: pairId
      };
      document.annotations.push(twin);
      conflicts += 1;
      if (op.pending) pending += 1;
    }
  }

  // 登记导入并留合并快照；正文以内网稿为准，交接包中的正文改动只在预演/报告里提示
  const fingerprint = plan.pkg.packageId.slice(4);
  const record: ImportedPackageRecord = {
    packageId: plan.pkg.packageId,
    member: plan.pkg.member,
    note: plan.pkg.note,
    importedAt: stamp,
    added,
    changed,
    conflicts,
    pending,
    fingerprint
  };
  document.importedPackages.push(record);

  const snapshotLabel = `合并交接包 · ${plan.pkg.member}`;
  const snapshotId = `snapshot-merge-${stableHash(`${plan.pkg.packageId}:${stamp}`)}`;
  document.snapshots.push({
    id: snapshotId,
    label: snapshotLabel,
    note: `导入 ${plan.pkg.member} 的离线交接包：新增 ${added}、采用 ${changed}、双方冲突 ${conflicts}、待确认 ${pending}。`,
    createdAt: stamp,
    chapters: clone(document.chapters),
    annotations: clone(document.annotations)
  });
  document.updatedAt = stamp;

  return { added, changed, conflicts, pending, snapshotId, snapshotLabel };
}

function uniqueAnnotationId(
  document: TextDocument,
  wanted: string,
  stamp: string,
  idMap: Map<string, string>
): string {
  const taken = (id: string) =>
    document.annotations.some((item) => item.id === id) || [...idMap.values()].includes(id);
  if (!taken(wanted)) return wanted;
  let candidate = `${wanted}-m${stableHash(`${wanted}:${stamp}:${document.annotations.length}`)}`;
  let suffix = 1;
  while (taken(candidate)) {
    suffix += 1;
    candidate = `${wanted}-m${suffix}`;
  }
  return candidate;
}

/* -------------------------------- 交接包 ---------------------------------- */

export interface HandoffPackageInput {
  member: string;
  note: string;
  baseSnapshotId?: string;
}

/** 组员带出：以指定（或最新）快照为底本，连同当前离线稿整体打包 */
export function createHandoffPackage(document: TextDocument, input: HandoffPackageInput, nowIso: string): HandoffPackage {
  const base =
    document.snapshots.find((snapshot) => snapshot.id === input.baseSnapshotId) ??
    document.snapshots[document.snapshots.length - 1];

  const payload = JSON.stringify({
    documentId: document.id,
    chapters: document.chapters,
    annotations: document.annotations
  });
  const packageId = `pkg-${stableHash(payload)}`;

  return {
    format: HANDOFF_FORMAT,
    packageId,
    documentId: document.id,
    documentTitle: document.title,
    member: input.member.trim() || '未署名组员',
    note: input.note.trim(),
    exportedAt: nowIso,
    baseSnapshotId: base?.id ?? '',
    baseSnapshotLabel: base?.label ?? '（无底本快照）',
    baseChapters: clone(base?.chapters ?? document.chapters),
    baseAnnotations: clone(base?.annotations ?? []),
    chapters: clone(document.chapters),
    annotations: clone(document.annotations)
  };
}

export function serializeHandoffPackage(pkg: HandoffPackage): string {
  return JSON.stringify(pkg, null, 2);
}

export function parseHandoffPackage(text: string): { ok: true; pkg: HandoffPackage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是合法 JSON，请选择本工具导出的 .handoff.json 交接包。' };
  }
  const candidate = parsed as Partial<HandoffPackage> | null;
  if (!candidate || candidate.format !== HANDOFF_FORMAT) {
    return {
      ok: false,
      error: '文件格式不是离线交接包（jiguantang-handoff/v1）。整份导出的文档不能直接覆盖导入，请使用交接包。'
    };
  }
  if (!candidate.packageId || !Array.isArray(candidate.annotations) || !Array.isArray(candidate.chapters)) {
    return { ok: false, error: '交接包缺少 packageId / chapters / annotations，文件可能已损坏。' };
  }
  if (!Array.isArray(candidate.baseChapters) || !Array.isArray(candidate.baseAnnotations)) {
    return { ok: false, error: '交接包缺少底本快照数据，无法做三方合并。' };
  }
  return { ok: true, pkg: candidate as HandoffPackage };
}

/* ------------------------------ 草稿兼容与读取 ----------------------------- */

/** 兼容旧版 localStorage：补齐导入登记数组 */
export function normalizeDocument(document: TextDocument): TextDocument {
  if (!Array.isArray(document.importedPackages)) document.importedPackages = [];
  for (const annotation of document.annotations) {
    annotation.references = annotation.references ?? [];
    annotation.tags = annotation.tags ?? [];
  }
  return document;
}

export function isPendingAnnotation(annotation: Annotation): boolean {
  return Boolean(annotation.pendingConfirmation);
}

export function countPendingAnnotations(document: TextDocument): number {
  return document.annotations.filter(isPendingAnnotation).length;
}
