import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(['grain', 'tip'].includes(value.filter));
  assert.equal(typeof value.complete, 'boolean');
  assert.ok(value.version && Array.isArray(value.rows));
  assert.ok(Number.isInteger(value.total) && value.total >= 0);
  const ids = value.rows.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of value.rows) {
    assert.ok(row.raw && Object.keys(row.raw).length > 0, `材料 ${row.id} 缺少可见字段原文`);
    assert.ok(row.detail, `材料 ${row.id} 缺少详情原文`);
    assert.ok(row.evidence, `材料 ${row.id} 缺少采集证据`);
  }
  // Every row in one batch must belong to the same filter and data version.
  for (const row of value.rows) {
    if (row.evidence.filter) assert.equal(row.evidence.filter, value.filter, `材料 ${row.id} 的筛选与批次不一致`);
    if (row.evidence.version) assert.equal(row.evidence.version, value.version, `材料 ${row.id} 的版本与批次不一致`);
  }
  if (value.complete) {
    assert.equal(value.rows.length, value.total);
    assert.equal(value.endSeen, true);
  } else assert.ok(value.reason);
}
