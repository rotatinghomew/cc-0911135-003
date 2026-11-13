import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(['grain', 'tip'].includes(value.filter));
  assert.equal(typeof value.complete, 'boolean');
  assert.ok(value.version && Array.isArray(value.rows));
  const ids = value.rows.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of value.rows) assert.ok(row.raw && row.detail && row.evidence);
  if (value.complete) {
    assert.equal(value.rows.length, value.total);
    assert.equal(value.endSeen, true);
  } else assert.ok(value.reason);
}
