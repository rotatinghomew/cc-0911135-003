import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { collectObservations } from '../lib/collector.mjs';
import { verify } from '../lib/verify.mjs';

async function control(site, value) {
  await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

async function withSite(settings, operation) {
  const site = await createSite();
  if (settings) await control(site, settings);
  try {
    await operation(site);
  } finally {
    await site.close();
  }
}

const collect = (site, extra = {}) => collectObservations({
  url: site.url,
  filter: 'grain',
  launchOptions: { headless: true },
  ...extra,
});

test('普通全表：界面总数、末尾标志与唯一编号一致才算完整', () => withSite(null, async site => {
  const result = await collect(site);
  verify(result);
  assert.equal(result.complete, true);
  assert.equal(result.endSeen, true);
  assert.equal(result.rows.length, 30);
  assert.equal(result.total, 30);
  assert.equal(result.evidence.uniqueRows, 30);
  assert.ok(result.evidence.screens.some(screen => screen.endSeen), '必须留有界面末尾证据');
  assert.deepEqual(result.rows.map(row => row.id).slice(0, 2), ['G-001', 'G-002']);
  assert.deepEqual(result.rows.map(row => row.id).slice(-2), ['G-029', 'G-030']);
  for (const row of result.rows) {
    assert.match(row.evidence.identityText, /展示筛选 grain；版本 grid-v1；总数 30/);
    assert.equal(row.evidence.filter, 'grain');
    assert.equal(row.evidence.version, result.version);
    assert.ok(row.evidence.locator.row.startsWith('#viewport #rows tr'));
  }
}));

test('表头顺序变化时按可见表头定位，而不是固定列号', () => withSite({ reverseColumns: true }, async site => {
  const result = await collect(site, { filter: 'tip' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows[0].raw, { 状态: '待复核', 材料名称: '共享材料 1' });
  assert.deepEqual(result.evidence.screens[0].headers, ['状态', '材料名称', '详情']);
  assert.ok(result.rows.every(row => row.id.startsWith('T-')));
}));

test('重复显示不能被去重掩盖：唯一数不足时不声明完整', () => withSite({ duplicate: true }, async site => {
  const result = await collect(site);
  assert.equal(result.complete, false);
  assert.equal(result.endSeen, true);
  assert.ok(result.rows.length < result.total);
  assert.match(result.reason, /不一致/);
  assert.equal(result.evidence.progress.uniqueRows, result.rows.length);
}));

test('会话过期后重新登录并重新确认筛选与版本，之后仍可完整采集', () => withSite({ expireAfter: 5 }, async site => {
  const result = await collect(site, { filter: 'tip' });
  verify(result);
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 30);
  assert.equal(result.evidence.sessionRenewals, 1);
  assert.ok(result.rows.every(row => row.evidence.version === result.version));
}));

test('籽粒迟到响应不会污染生长点批次', () => withSite({ late: true }, async site => {
  const result = await collect(site, {
    filter: 'tip',
    beforeFilter: async page => {
      // Start reading grain so its response is still in flight, then switch to
      // tip immediately; the overdue grain payload must never be accepted.
      await page.locator('#filter').selectOption('grain');
      await page.waitForTimeout(30);
    },
  });
  verify(result);
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 30);
  assert.ok(result.rows.every(row => row.evidence.filter === 'tip'));
  assert.ok(result.rows.every(row => row.id.startsWith('T-')));
  assert.ok(result.rows.every(row => row.detail.includes('部位=tip')));
  assert.ok(result.evidence.screens.every(screen => screen.filter === 'tip'));
  assert.ok(result.evidence.screens.every(screen => screen.version === result.version));
  // The overdue grain screen was observed and rejected before the retry, which
  // proves the guard ran rather than the race simply never happening.
  assert.ok(result.evidence.restarts >= 1);
  assert.ok(result.evidence.attempts.some(entry => entry.type === 'filter-retry'));
}));

test('版本中途变化时放弃完整性结论并保留有效进度', () => withSite(null, async site => {
  const result = await collect(site, {
    onScreen: async ({ screen }) => {
      if (screen === 2) await control(site, { version: 'grid-v2' });
    },
  });
  assert.equal(result.complete, false);
  assert.match(result.reason, /版本/);
  assert.deepEqual(result.replan, { required: true, previousVersion: 'grid-v1', observedVersion: 'grid-v2' });
  assert.ok(result.rows.length > 0 && result.rows.length < result.total);
  assert.ok(result.rows.every(row => row.evidence.version === 'grid-v1'));
  assert.equal(result.version, 'grid-v1');
}));

test('中止时保留进度并带原因，不伪造完整', () => withSite(null, async site => {
  const controller = new AbortController();
  const result = await collect(site, {
    signal: controller.signal,
    onScreen: ({ screen }) => {
      if (screen === 2) controller.abort();
    },
  });
  assert.equal(result.complete, false);
  assert.equal(result.endSeen, false);
  assert.ok(result.reason);
  assert.ok(result.rows.length > 0 && result.rows.length < result.total);
  assert.equal(result.evidence.progress.uniqueRows, result.rows.length);
}));
