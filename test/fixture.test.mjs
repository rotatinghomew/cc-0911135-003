import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

test('未登录不能读取数据', async () => withSite(async site => {
  assert.equal((await fetch(site.url + '/api/rows?filter=grain')).status, 401);
}));
test('登录后仅返回当前虚拟屏', async () => withSite(async site => {
  const login = await fetch(site.url + '/login', { method: 'POST', body: JSON.stringify({ username: 'reader', password: 'local-reader' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const rows = await (await fetch(site.url + '/api/rows?filter=grain&offset=0', { headers: { cookie } })).json();
  assert.equal(rows.total, 30); assert.equal(rows.rows.length, 6); assert.equal(rows.end, false);
  const detail = await (await fetch(site.url + '/api/detail?filter=grain&index=0', { headers: { cookie } })).json();
  assert.equal(detail.accession, 'G-001');
}));
test('无末尾证据不得宣称完整', () => {
  assert.throws(() => verify({ filter: 'grain', version: '1', complete: true, total: 0, rows: [] }));
});

test('会话过期一次后可重新登录', async () => withSite(async site => {
  await control(site, { expireAfter: 1 });
  async function login() {
    const result = await fetch(site.url + '/login', { method: 'POST', body: JSON.stringify({ username: 'reader', password: 'local-reader' }) });
    return result.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await login();
  assert.equal((await fetch(site.url + '/api/rows?filter=tip&offset=0', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(site.url + '/api/rows?filter=tip&offset=6', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(site.url + '/api/rows?filter=tip&offset=6', { headers: { cookie: await login() } })).status, 200);
}));
