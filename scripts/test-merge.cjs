/* 离线交接包合并引擎测试：npx tsc 编译到 .test-build 后由 node 直接运行 */
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildMergePlan,
  applyMerge,
  createHandoffPackage,
  serializeHandoffPackage,
  parseHandoffPackage,
  normalizeDocument,
  countPendingAnnotations
} = require(path.join(__dirname, '..', '.test-build', 'merge.js'));

const T1 = '2026-10-01T01:00:00.000Z';
const T2 = '2026-10-01T08:00:00.000Z';
const T3 = '2026-10-02T03:00:00.000Z';

function tokens(sentenceId, list) {
  return list.map((text, index) => ({ id: `${sentenceId}-tk-${index}`, text }));
}

function mkDoc() {
  const s1Base = {
    id: 's1', order: 1, text: '北冥有鱼，其名为鲲。',
    tokens: tokens('s1', ['北冥', '有', '鱼', '，', '其', '名', '为', '鲲', '。'])
  };
  const s3Base = {
    id: 's3', order: 3, text: '化而为鸟，其名为鹏。',
    tokens: tokens('s3', ['化', '而', '为', '鸟', '，', '其', '名', '为', '鹏', '。'])
  };
  const chapter = { id: 'c1', order: 1, title: '逍遥游', summary: '', sentences: [s1Base, s3Base] };

  const annotations = [
    { id: 'a1', anchorId: 's1', anchorType: 'sentence', kind: 'footnote', title: '北冥', body: 'BASE-A1', source: '底本', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 },
    { id: 'a3', anchorId: 's3-tk-8', anchorType: 'word', kind: 'variant', title: '鹏', body: 'BASE-A3', source: '底本', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 },
    { id: 'a8', anchorId: 's3', anchorType: 'sentence', kind: 'background', title: '鹏之徙', body: 'BASE-A8', source: '底本', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 },
    { id: 'a9', anchorId: 's1-tk-7', anchorType: 'word', kind: 'crossref', title: '鲲', body: 'BASE-A9', source: '底本', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 }
  ];

  const doc = {
    id: 'doc-1', title: '测试', author: '', edition: '',
    chapters: [chapter], annotations, snapshots: [], importedPackages: [], updatedAt: T1
  };
  doc.snapshots.push({ id: 'snap-base', label: '底本', note: '', createdAt: T1, chapters: structuredClone(doc.chapters), annotations: structuredClone(annotations) });
  return doc;
}

/* ---------- 内网当前稿：甲机刚补过脚注、改过 a1；正文 s1 删去“鲲” ---------- */
const localDoc = mkDoc();
{
  const s1 = localDoc.chapters[0].sentences[0];
  s1.text = '北冥有鱼，不知其名。';
  s1.tokens = tokens('s1', ['北冥', '有', '鱼', '，', '不', '知', '其', '名', '。']);
  // 既有机制：词级引用随正文修订降到句级
  const a9 = localDoc.annotations.find((a) => a.id === 'a9');
  a9.anchorId = 's1'; a9.anchorType = 'sentence';
  const a1 = localDoc.annotations.find((a) => a.id === 'a1');
  a1.body = 'LOCAL-A1'; a1.updatedAt = T2;
  localDoc.annotations.push({
    id: 'a-local', anchorId: 's1', anchorType: 'sentence', kind: 'footnote',
    title: '甲机刚补', body: 'LOCAL-NEW', source: '甲机', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T2
  });
  localDoc.updatedAt = T2;
}

/* ---------- 乙机离线稿：新增3条、改 a8、与甲机同改 a1、s3 分词变化 ---------- */
const offlineDoc = mkDoc();
{
  const s3 = offlineDoc.chapters[0].sentences.find((s) => s.id === 's3');
  s3.text = '化而为鸟，其名曰鹏。';
  s3.tokens = tokens('s3', ['化', '而', '为', '鸟', '，', '其', '名', '曰', '鹏', '。']); // 鹏的 token 编号仍是 8
  // 人为模拟另一台机器的 token 命名空间：编号整体重排
  s3.tokens = s3.tokens.map((t, i) => ({ id: `s3-off-${i}-zz`, text: t.text }));

  const a1 = offlineDoc.annotations.find((a) => a.id === 'a1');
  a1.body = 'OFFLINE-A1';
  const a8 = offlineDoc.annotations.find((a) => a.id === 'a8');
  a8.body = 'OFFLINE-A8';
  offlineDoc.annotations.push(
    { id: 'a-new-peng', anchorId: s3.tokens[8].id, anchorType: 'word', kind: 'footnote', title: '新注鹏', body: 'NEW-PENG', source: '乙机', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T2 },
    { id: 'a-new-kun', anchorId: 's1-tk-7', anchorType: 'word', kind: 'variant', title: '新注鲲', body: 'NEW-KUN', source: '乙机', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T2 },
    { id: 'a-new-off', anchorId: 's1', anchorType: 'sentence', kind: 'background', title: '乙机背景注', body: 'NEW-OFF', source: '乙机', references: ['a-new-peng'], status: 'open', tags: [], conflictState: 'open', updatedAt: T2 }
  );
}

const pkg = createHandoffPackage(normalizeDocument(offlineDoc), { member: '乙', note: '校外批' }, T2);
assert.equal(pkg.format, 'jiguantang-handoff/v1');
assert.equal(pkg.baseSnapshotId, 'snap-base');

/* ---------- 预演：不落草稿 ---------- */
const plan = buildMergePlan(localDoc, pkg);
assert.equal(plan.alreadyImported, false);
assert.deepEqual(plan.counts, { add: 3, updateIncoming: 1, conflicts: 1, pending: 1, skips: 2, textChanged: 2 });
assert.equal(plan.textDeltas.map((d) => d.sentenceId).sort().join(','), 's1,s3', '本地与乙机各改一句，均列出');

const opPeng = plan.ops.find((op) => op.annotation.id === 'a-new-peng');
assert.equal(opPeng.status, 'add');
assert.equal(opPeng.anchorFollow, 'word-followed');
assert.equal(opPeng.resolvedAnchorType, 'word');
assert.equal(opPeng.resolvedAnchorId, 's3-tk-8', '词级注释应跟到本地同词“鹏”');

const opKun = plan.ops.find((op) => op.annotation.id === 'a-new-kun');
assert.equal(opKun.status, 'add');
assert.equal(opKun.anchorFollow, 'downgraded-sentence');
assert.equal(opKun.resolvedAnchorId, 's1');
assert.equal(opKun.resolvedAnchorType, 'sentence');
assert.equal(opKun.pending, true, '本地无“鲲”，降到所属句待确认');

const opA1 = plan.ops.find((op) => op.annotation.id === 'a1');
assert.equal(opA1.status, 'conflict-open', '双方都改 a1，须保留双方由人选定');

const opA8 = plan.ops.find((op) => op.annotation.id === 'a8');
assert.equal(opA8.status, 'update-incoming', '仅乙机改 a8，采用乙稿');

const opA3 = plan.ops.find((op) => op.annotation.id === 'a3');
assert.equal(opA3.status, 'identical-skip');

assert.equal(localDoc.annotations.length, 5, '预演不得修改草稿');
assert.equal(localDoc.importedPackages.length, 0);

/* ---------- 确认后写草稿 + 快照 ---------- */
const beforeSnapshots = localDoc.snapshots.length;
const result = applyMerge(localDoc, plan, T3);
assert.deepEqual([result.added, result.changed, result.conflicts, result.pending], [3, 1, 1, 1]);
assert.equal(localDoc.annotations.length, 9, '5 现存 + 3 新增 + 1 冲突孪生稿');
assert.equal(localDoc.snapshots.length, beforeSnapshots + 1, '合并后自动留快照');
assert.equal(localDoc.importedPackages.length, 1);
assert.equal(countPendingAnnotations(localDoc), 1);

const mergedA1 = localDoc.annotations.find((a) => a.id === 'a1');
const twinA1 = localDoc.annotations.find((a) => a.mergePairId && (mergedA1.mergePairs ?? []).includes(a.mergePairId));
assert.ok(twinA1, '冲突孪生稿存在');
assert.equal(twinA1.body, 'OFFLINE-A1');
assert.equal(twinA1.originMember, '乙');
assert.equal(mergedA1.body, 'LOCAL-A1', '本地稿原文不被覆盖');
assert.equal(mergedA1.anchorId, 's1');
assert.equal(twinA1.anchorId, 's1', '同锚点同类型才能进同一冲突组');
assert.ok(mergedA1.mergePairs.includes(twinA1.mergePairId));

const mergedA8 = localDoc.annotations.find((a) => a.id === 'a8');
assert.equal(mergedA8.body, 'OFFLINE-A8');
assert.equal(mergedA8.originMember, '乙');

const mergedPeng = localDoc.annotations.find((a) => a.id === 'a-new-peng');
assert.equal(mergedPeng.anchorId, 's3-tk-8');
const mergedKun = localDoc.annotations.find((a) => a.id === 'a-new-kun');
assert.equal(mergedKun.anchorId, 's1');
assert.equal(mergedKun.anchorType, 'sentence');
assert.equal(mergedKun.pendingConfirmation, true);
assert.ok(mergedKun.mergeNote.includes('待人工确认'));
const mergedOff = localDoc.annotations.find((a) => a.id === 'a-new-off');
assert.deepEqual(mergedOff.references, ['a-new-peng'], '引用关系随包保留');
assert.ok(localDoc.annotations.find((a) => a.id === 'a-local'), '甲机刚补的脚注不得被整份导入压掉');

/* ---------- 同一交接包重复导入：幂等 ---------- */
const planAgain = buildMergePlan(localDoc, pkg);
assert.equal(planAgain.alreadyImported, true);
assert.equal(planAgain.ops.length, 0);
const resultAgain = applyMerge(localDoc, planAgain, T3);
assert.deepEqual([resultAgain.added, resultAgain.changed, resultAgain.conflicts], [0, 0, 0]);
assert.equal(localDoc.annotations.length, 9, '重复导入不得重复新增');
assert.equal(localDoc.importedPackages.length, 1);
assert.equal(localDoc.snapshots.length, beforeSnapshots + 1, '重复导入不再留快照');

/* ---------- 断网恢复：同内容重新导出（新文件、新时间）仍按指纹拦截 ---------- */
const pkgReexport = createHandoffPackage(normalizeDocument(offlineDoc), { member: '乙', note: '校外批' }, T3);
assert.equal(pkgReexport.packageId, pkg.packageId, '内容相同则交接包 ID 相同');
const planRe = buildMergePlan(localDoc, pkgReexport);
assert.equal(planRe.alreadyImported, true);

/* ---------- 解析校验 ---------- */
assert.equal(parseHandoffPackage(serializeHandoffPackage(pkg)).ok, true);
assert.equal(parseHandoffPackage('{not json').ok, false);
assert.equal(parseHandoffPackage(JSON.stringify({ format: 'other' })).ok, false);

console.log('merge engine tests: all assertions passed');
