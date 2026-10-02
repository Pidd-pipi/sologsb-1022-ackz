/* 集成测试：合并结果必须在阅读/校勘/检索/冲突/版本比较链路中可见 */
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildMergePlan, applyMerge, createHandoffPackage, normalizeDocument } =
  require(path.join(__dirname, '..', '.test-build', 'merge.js'));
const { getConflictGroups, collectSearchResults, getTargetLabel, resolveConflictMembers } =
  require(path.join(__dirname, '..', '.test-build', 'editor.js'));

const T1 = '2026-10-01T00:00:00.000Z';

function makeBase() {
  const s = (id, order, text) => ({
    id, order, text,
    tokens: Array.from(text.matchAll(/[\p{Script=Han}]+|[^\p{Script=Han}]/gu), (m, i) => ({
      id: `${id}-w${i}`, text: m[0]
    }))
  });
  const s1 = s('s1', 1, '北冥有鱼，其名为鲲。');
  const s2 = s('s2', 2, '鲲之大，不知其几千里也。');
  const chapter = { id: 'c1', order: 1, title: '逍遥游', summary: '', sentences: [s1, s2] };
  // 手工把 token 对齐到“字”以便锚点构造
  chapter.sentences.forEach((sentence) => {
    sentence.tokens = [...sentence.text].map((ch, i) => ({ id: `${sentence.id}-w${i}`, text: ch }));
  });
  const pengWord = chapter.sentences[0].tokens.find((t) => t.text === '鲲').id; // s1-w8
  const annotations = [
    { id: 'a1', anchorId: 's1', anchorType: 'sentence', kind: 'footnote', title: '北冥', body: '底本北冥', source: '郭庆藩本', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 },
    { id: 'a2', anchorId: pengWord, anchorType: 'word', kind: 'variant', title: '鲲字', body: '底本鲲字', source: '校勘组', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1 }
  ];
  const doc = { id: 'd1', title: 't', author: '', edition: '', chapters: [chapter], annotations, snapshots: [], importedPackages: [], updatedAt: T1 };
  doc.snapshots.push({ id: 'b1', label: '底本', note: '', createdAt: T1, chapters: structuredClone(doc.chapters), annotations: structuredClone(annotations) });
  return doc;
}

/* ---- 包甲：与内网同改 a1 → 冲突；新增词注 a-new（跟词） ---- */
function makeOffline() {
  const doc = makeBase();
  doc.annotations.find((a) => a.id === 'a1').body = '甲改北冥';
  // 模拟另一台机器的分词 ID 空间（编号/命名都不同），但“鲲”字位置一致
  const s1 = doc.chapters[0].sentences[0];
  s1.tokens = [...s1.text].map((ch, i) => ({ id: `remote-x${i}-001`, text: ch }));
  const remoteKun = s1.tokens.find((t) => t.text === '鲲').id;
  doc.annotations.find((a) => a.id === 'a2').anchorId = remoteKun;
  doc.annotations.push({
    id: 'a-new', anchorId: remoteKun, anchorType: 'word', kind: 'footnote',
    title: '鲲新注', body: '甲机新补鲲注', source: '甲机', references: [], status: 'open', tags: [], conflictState: 'open', updatedAt: T1
  });
  return doc;
}

const local = makeBase();
local.annotations.find((a) => a.id === 'a1').body = '内网改北冥';

const pkg = createHandoffPackage(normalizeDocument(makeOffline()), { member: '甲', note: '' }, T1);
const plan = buildMergePlan(local, pkg);
assert.equal(plan.counts.add, 1);
assert.equal(plan.counts.conflicts, 1);
const newOp = plan.ops.find((o) => o.annotation.id === 'a-new');
assert.equal(newOp.anchorFollow, 'word-followed');
assert.equal(newOp.resolvedAnchorId, 's1-w8', '不同 ID 空间下按词形跟到本地“鲲”');

const applied = applyMerge(local, plan, '2026-10-02T05:00:00.000Z');
assert.equal(applied.added, 1);
assert.equal(applied.conflicts, 1);

/* 合并结果进入冲突机制：孪生稿与本地稿成一组 */
const groups = getConflictGroups(local);
const pairGroup = groups.find((g) => g.key.startsWith('pair:'));
assert.ok(pairGroup, '合并冲突可被现有冲突面板识别');
assert.equal(pairGroup.annotations.length, 2);
assert.deepEqual(pairGroup.annotations.map((a) => a.body).sort(), ['内网改北冥', '甲改北冥']);

/* 检索能找到合并进来的注释 */
const hits = collectSearchResults(local, '甲机新补');
assert.equal(hits.length, 1);
assert.equal(hits[0].annotationId, 'a-new');

/* 目标标签解析到本地词，不悬空 */
const mergedNew = local.annotations.find((a) => a.id === 'a-new');
assert.equal(getTargetLabel(local, mergedNew), '逍遥游 · “鲲”');

/* 快照：可用于版本比较，且包含合并结果 */
const mergeSnapshot = local.snapshots.find((s) => s.id === applied.snapshotId);
assert.ok(mergeSnapshot);
assert.equal(mergeSnapshot.annotations.length, local.annotations.length);
assert.ok(mergeSnapshot.note.includes('甲'));

/* 同包再来一次（断网恢复场景）：一切照旧 */
const plan2 = buildMergePlan(local, pkg);
assert.equal(plan2.alreadyImported, true);
const applied2 = applyMerge(local, plan2, '2026-10-02T06:00:00.000Z');
assert.equal(applied2.added, 0);
assert.equal(getConflictGroups(local).filter((g) => g.key.startsWith('pair:')).length, 1, '冲突不翻倍');

/* ---- 第二个包（另一组员，独立底本之后再改 a1）：孪生稿各自配对，不串组 ---- */
function makeOffline2() {
  const doc = makeBase();
  doc.annotations.find((a) => a.id === 'a1').body = '乙改北冥';
  return doc;
}
const pkg2 = createHandoffPackage(normalizeDocument(makeOffline2()), { member: '乙', note: '' }, T1);
const plan3 = buildMergePlan(local, pkg2);
assert.equal(plan3.alreadyImported, false);
assert.equal(plan3.counts.conflicts, 1, '甲的冲突已在本地稿上，乙相对当前本地仍是“双方改过”');
applyMerge(local, plan3, '2026-10-02T07:00:00.000Z');
const pairGroups = getConflictGroups(local).filter((g) => g.key.startsWith('pair:'));
assert.equal(pairGroups.length, 2, '甲、乙与内网稿分别成组');
assert.equal(local.importedPackages.length, 2);
assert.equal(local.annotations.filter((a) => a.body === '乙改北冥').length, 1);
assert.equal(local.annotations.filter((a) => a.body === '甲改北冥').length, 1, '条文不重复不覆盖');

/* 在甲的配对里选用甲稿：乙的配对不受影响，本地稿仍在乙组中保持争议 */
const pairGroupsAtEnd = getConflictGroups(local);
const jiaGroup = pairGroupsAtEnd.find((g) => g.annotations.some((a) => a.body === '甲改北冥'));
assert.equal(jiaGroup.annotations.length, 2);
resolveConflictMembers(local, jiaGroup, jiaGroup.annotations.find((a) => a.body === '甲改北冥').id, false, '2026-10-02T08:00:00.000Z');
const groupsAfter = getConflictGroups(local);
assert.equal(groupsAfter.filter((g) => g.key.startsWith('pair:')).length, 1, '只剩乙组未决');
assert.equal(groupsAfter[0].annotations.some((a) => a.body === '内网改北冥'), true, '内网稿仍在乙组中');
assert.equal(groupsAfter[0].annotations.some((a) => a.body === '乙改北冥'), true);
const resolvedTwinJia = local.annotations.find((a) => a.body === '甲改北冥');
assert.equal(resolvedTwinJia.conflictState, 'resolved');
const localA1 = local.annotations.find((a) => a.id === 'a1');
assert.equal(localA1.conflictState, 'open', '本地稿因乙组未决仍保持争议');

console.log('merge integration tests: all assertions passed');
