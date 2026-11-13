import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createSite } from '../src/site.mjs';

test('真实浏览器完成一次门户交互', async () => {
  const site = await createSite();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(site.url);
    
await page.getByRole('button', { name: '登录', exact: true }).click();
await page.locator('#identity').filter({ hasText: 'grid-v1' }).waitFor();
await page.getByRole('button', { name: '展开详情' }).first().click();
await page.locator('#detail').filter({ hasText: 'G-001' }).waitFor();
assert.match(await page.locator('#identity').innerText(), /总数 30/);
await page.locator('#filter').selectOption('tip');
await page.locator('#identity').filter({ hasText: 'tip' }).waitFor();
assert.equal(await page.locator('#rows tr').count(), 6);

  } finally {
    await browser.close();
    await site.close();
  }
});
