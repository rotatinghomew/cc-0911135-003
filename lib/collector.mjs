import { chromium } from 'playwright';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const IDENTITY_PATTERN =
  /展示筛选\s+(\S+?)\s*；\s*版本\s+(\S+?)\s*；\s*总数\s+(\d+)\s*；\s*起始\s+(\d+)/;
const DETAIL_ACCESSION_PATTERN = /材料编号\s+([^；;\s]+)/;
const DETAIL_FILTER_PATTERN = /部位\s*=\s*([^；;\s]+)/;
const DETAIL_VERSION_PATTERN = /版本\s+([^；;\s]+)/;
const END_PATTERN = /已到末尾/;

export function parseIdentity(value) {
  const match = IDENTITY_PATTERN.exec(value || '');
  if (!match) return null;
  return {
    filter: match[1],
    version: match[2],
    total: Number(match[3]),
    start: Number(match[4]),
  };
}

export function parseDetail(value) {
  const text = value || '';
  const accession = DETAIL_ACCESSION_PATTERN.exec(text);
  return {
    id: accession ? accession[1] : null,
    filter: DETAIL_FILTER_PATTERN.exec(text)?.[1] || null,
    version: DETAIL_VERSION_PATTERN.exec(text)?.[1] || null,
  };
}

export function endSeenFrom(value) {
  return END_PATTERN.test(value || '');
}

class CollectorFailure extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CollectorFailure';
    this.code = code;
  }
}

class SessionExpired extends CollectorFailure {
  constructor() {
    super('会话过期，需要重新登录并重新确认筛选与版本', 'session-expired');
  }
}

class Contaminated extends CollectorFailure {
  constructor(observed, expected) {
    super(`页面显示筛选 ${observed}，与目标筛选 ${expected} 不一致；迟到的响应不能进入本批次`,
      'filter-contaminated');
    this.observed = observed;
    this.expected = expected;
  }
}

class VersionChanged extends CollectorFailure {
  constructor(previous, current) {
    super(`页面报告的站点版本由 ${previous} 变为 ${current}`, 'version-changed');
    this.previous = previous;
    this.current = current;
  }
}

class TotalChanged extends CollectorFailure {
  constructor(previous, current) {
    super(`界面报告的总数由 ${previous} 变为 ${current}`, 'total-changed');
    this.previous = previous;
    this.current = current;
  }
}

class NavigationLost extends CollectorFailure {
  constructor(message) {
    super(message, 'navigation-lost');
  }
}

class SessionUnrecoverable extends CollectorFailure {
  constructor(message) {
    super(message, 'session-unrecoverable');
  }
}

class CollectionAborted extends CollectorFailure {
  constructor() {
    super('采集被中止，已保存的进度仅供续采参考', 'aborted');
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function sameRaw(a, b) {
  // Column order is presentation only (reverseColumns changes it), so compare
  // field labels and values without depending on the order they appeared in.
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function dataColumns(headers) {
  const columns = {};
  headers.forEach((header, position) => {
    const label = header.trim();
    if (label && label !== '详情') columns[label] = position;
  });
  return columns;
}

function mapRow(cells, columns, headers) {
  if (Object.keys(columns).length === 0) {
    throw new NavigationLost(`无法从可见表头 ${headers.join(' / ')} 定位字段`);
  }
  const raw = {};
  for (const [label, position] of Object.entries(columns)) {
    if (cells[position] === undefined) {
      throw new NavigationLost(`可见单元格数量与表头 ${headers.join(' / ')} 不一致`);
    }
    raw[label] = cells[position];
  }
  return raw;
}

async function workspaceVisible(page) {
  try {
    return await page.locator('#workspace').isVisible({ timeout: 200 });
  } catch {
    return false;
  }
}

async function formVisible(page) {
  try {
    return await page.locator('#login').isVisible({ timeout: 200 });
  } catch {
    return false;
  }
}

async function loginThroughForm(page, credentials) {
  if (!(await formVisible(page))) {
    if (await workspaceVisible(page)) return false;
    throw new SessionUnrecoverable('登录表单不可用，无法恢复会话');
  }
  const form = page.locator('#login');
  await form.locator('input[name=username]').fill(credentials.username);
  await form.locator('input[name=password]').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await workspaceVisible(page)) return true;
    const message = await page.locator('#message').innerText().catch(() => '');
    if (/登录失败/.test(message)) throw new SessionUnrecoverable('重新登录失败，该批次无法恢复');
    await sleep(25);
  }
  throw new SessionUnrecoverable('重新登录后工作区仍未出现，该批次无法恢复');
}

async function waitForFilterScreen(page, filter, settleMs, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let candidate = null;
  let stableSince = 0;
  let lastIdentity = null;
  let targetSeen = false;
  while (Date.now() < deadline) {
    if (!(await workspaceVisible(page))) throw new SessionExpired();
    const identity = await readCurrentIdentity(page);
    lastIdentity = identity;
    if (identity && identity.filter === filter && identity.start === 0) {
      targetSeen = true;
      if (!candidate || !sameIdentity(candidate, identity)) {
        candidate = identity;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settleMs) {
        return identity;
      }
    } else if (identity && targetSeen) {
      // The target screen was already shown and has now been replaced by a
      // screen for another filter: only an overdue response can do that.
      throw new Contaminated(identity.filter, filter);
    } else {
      // Still waiting for the new selection's first response; the previous
      // filter's screen may legitimately still be visible.
      candidate = null;
      stableSince = 0;
    }
    const message = await page.locator('#message').innerText().catch(() => '');
    if (/过期|重新登录/.test(message) && !identity) throw new SessionExpired();
    await sleep(25);
  }
  if (lastIdentity && lastIdentity.filter !== filter) throw new Contaminated(lastIdentity.filter, filter);
  throw new NavigationLost(
    `选择筛选 ${filter} 后界面身份未能稳定确认` +
      (lastIdentity ? `（最后显示筛选 ${lastIdentity.filter}、起始 ${lastIdentity.start}）` : '')
  );
}

async function chooseFilter(page, filter, settleMs, attempts = 3, onRetry = null) {
  if (!(await workspaceVisible(page))) throw new SessionExpired();
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(150);
    if (!(await workspaceVisible(page))) throw new SessionExpired();
    await page.locator('#filter').selectOption(filter);
    try {
      return await waitForFilterScreen(page, filter, settleMs);
    } catch (error) {
      // A response for the previously selected filter can land after the new
      // filter's screen and overwrite it.  Selecting the target again issues a
      // fresh, uncontaminated request; the result is accepted only after the
      // identity has stayed on the target for the whole settle window.
      if (!(error instanceof Contaminated)) throw error;
      lastError = error;
      if (onRetry) await onRetry(error, attempt + 1);
    }
  }
  throw lastError;
}

async function readFrame(page) {
  return page.evaluate(() => {
    const workspace = document.querySelector('#workspace');
    const read = selector => document.querySelector(selector)?.textContent ?? '';
    return {
      workspaceVisible: Boolean(workspace) && !workspace.hidden,
      identityText: read('#identity'),
      headers: Array.from(document.querySelectorAll('#viewport #headers th'))
        .map(node => node.textContent.trim()),
      rows: Array.from(document.querySelectorAll('#viewport #rows tr')).flatMap((row, domIndex) => {
        const box = row.getBoundingClientRect();
        const view = document.querySelector('#viewport').getBoundingClientRect();
        const style = getComputedStyle(row);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
          box.height > 0 && box.bottom > view.top + 1 && box.top < view.bottom - 1;
        if (!visible) return [];
        return [{
          domIndex,
          visible: true,
          cells: Array.from(row.cells).map(cell => cell.textContent.trim()),
        }];
      }),
      endText: read('#end'),
    };
  });
}

async function readStableFrame(page, { quietMs, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let signature = null;
  let stableSince = 0;
  let last = null;
  while (Date.now() < deadline) {
    const frame = await readFrame(page);
    if (!frame.workspaceVisible) throw new SessionExpired();
    const identity = parseIdentity(frame.identityText);
    if (!identity) {
      const message = await page.locator('#message').innerText().catch(() => '');
      if (/过期|重新登录/.test(message)) throw new SessionExpired();
      signature = null;
      stableSince = 0;
      await sleep(25);
      continue;
    }
    const current = JSON.stringify([frame.identityText, frame.headers, frame.rows, frame.endText]);
    last = { ...frame, identity };
    if (current === signature) {
      if (Date.now() - stableSince >= quietMs) return last;
    } else {
      signature = current;
      stableSince = Date.now();
    }
    await sleep(25);
  }
  if (last) return last;
  throw new NavigationLost('界面内容在限定时间内未能稳定显示');
}

function sameIdentity(a, b) {
  return Boolean(
    a && b && a.filter === b.filter && a.version === b.version &&
      a.total === b.total && a.start === b.start
  );
}

async function readCurrentIdentity(page) {
  return parseIdentity(await page.locator('#identity').innerText().catch(() => ''));
}

async function scrollBy(page, pixels) {
  await page.locator('#viewport').hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, pixels);
}

async function advanceToNextScreen(page, previous, options) {
  const step = await page.locator('#viewport').evaluate(node => Math.max(1, node.clientHeight));
  const deadline = Date.now() + options.navigationTimeout;
  let attempts = 0;
  while (Date.now() < deadline) {
    await scrollBy(page, step);
    attempts += 1;
    const settled = await waitForStartChange(page, previous, 900);
    if (settled.moved) return settled.identity;
    if (settled.ended) return null;
    if (attempts >= 6) break;
  }
  throw new NavigationLost(`滚动 ${attempts} 次后仍停留在起始 ${previous.start}，无法继续采集`);
}

async function waitForStartChange(page, previous, timeout) {
  const deadline = Date.now() + timeout;
  let last = previous;
  while (Date.now() < deadline) {
    if (!(await workspaceVisible(page))) throw new SessionExpired();
    const identity = await readCurrentIdentity(page);
    if (!identity) {
      await sleep(25);
      continue;
    }
    last = identity;
    if (identity.filter !== previous.filter) throw new Contaminated(identity.filter, previous.filter);
    if (identity.version !== previous.version) throw new VersionChanged(previous.version, identity.version);
    if (identity.start !== previous.start) return { moved: true, identity };
    const endText = await page.locator('#end').innerText().catch(() => '');
    if (endSeenFrom(endText)) return { moved: false, ended: true, identity };
    await sleep(25);
  }
  return { moved: false, ended: false, identity: last };
}

async function restoreScreen(page, expected) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const identity = await readCurrentIdentity(page);
    if (!identity) throw new SessionExpired();
    if (identity.filter !== expected.filter) throw new Contaminated(identity.filter, expected.filter);
    if (identity.version !== expected.version) throw new VersionChanged(expected.version, identity.version);
    if (identity.start === expected.start) return identity;
    // Clicking a row button that is only partly inside the viewport makes the
    // browser scroll it fully into view.  Reverse that with one sub-screen
    // wheel notch; the page's virtual-list handler only reloads at screen
    // boundaries, so a few pixels never replace the rows being read.
    const above = identity.start > expected.start;
    await scrollBy(page, above ? -1 : 1);
    await sleep(60);
  }
  throw new NavigationLost(
    `展开详情后屏幕未能回到起始 ${expected.start}，已偏离到起始 ${(await readCurrentIdentity(page))?.start}`
  );
}

async function clickWithoutScrolling(page, locator) {
  // Playwright's click first scrolls the target fully into view.  For a button
  // on the last row that scroll is enough to cross into the next virtual
  // screen, which would replace the row we are reading.  Click with the mouse
  // at a point that is inside both the button and the visible viewport instead.
  const button = await locator.boundingBox();
  const viewport = await page.locator('#viewport').boundingBox();
  if (!button || !viewport) throw new NavigationLost('无法定位展开详情按钮或滚动容器');
  const x = button.x + button.width / 2;
  const top = Math.max(button.y, viewport.y);
  const bottom = Math.min(button.y + button.height, viewport.y + viewport.height);
  if (bottom - top < 8) throw new NavigationLost('展开详情按钮不在可见区域内');
  const y = (top + bottom) / 2;
  await page.mouse.click(x, y);
}

async function waitForDetailUpdate(page, timeout = 8000) {
  // Resolve on a mutation of the detail panel, but also notice a session
  // expiry immediately: the page hides the workspace and shows the login form
  // instead of updating the panel, so a plain mutation wait would hang.
  return page.evaluate(limit => new Promise(resolve => {
    const panel = document.querySelector('#detail');
    const workspace = document.querySelector('#workspace');
    if (!panel) return resolve('missing');
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => finish('updated'));
    observer.observe(panel, { childList: true, subtree: true, characterData: true });
    const poll = setInterval(() => {
      if (!workspace || workspace.hidden) finish('expired');
    }, 25);
    const timer = setTimeout(() => finish('timeout'), limit);
  }), timeout);
}

async function expandDetail(page, domIndex, expected) {
  const row = page.locator('#viewport #rows tr').nth(domIndex).getByRole('button', { name: '展开详情' });
  const update = waitForDetailUpdate(page);
  try {
    await clickWithoutScrolling(page, row);
  } catch (error) {
    await update;
    if (!(await workspaceVisible(page))) throw new SessionExpired();
    throw new NavigationLost(`可见行 ${domIndex + 1} 的展开详情按钮不可用：${error.message}`);
  }
  const seen = await update;
  if (seen === 'expired' || !(await workspaceVisible(page))) throw new SessionExpired();
  if (seen !== 'updated') throw new NavigationLost(`展开可见行 ${domIndex + 1} 的详情后界面未更新`);
  const deadline = Date.now() + 5000;
  let text = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await page.locator('#detail').innerText().catch(() => '');
    if (current === text) {
      if (Date.now() - stableSince >= 40) break;
    } else {
      text = current;
      stableSince = Date.now();
    }
    await sleep(20);
  }
  const parsed = parseDetail(text);
  if (!parsed.id) throw new NavigationLost('详情面板没有显示材料编号');
  if (parsed.filter && parsed.filter !== expected.filter) throw new Contaminated(parsed.filter, expected.filter);
  if (parsed.version && parsed.version !== expected.version) {
    throw new VersionChanged(expected.version, parsed.version);
  }
  return { text, parsed };
}

function checkpoint(state) {
  return {
    filter: state.filter,
    version: state.version,
    complete: false,
    total: state.total,
    endSeen: state.endSeen,
    rows: state.rows,
    reason: `采集进行中（检查点），已保存 ${state.rows.length} 条唯一材料，未取得完整证据`,
    evidence: evidenceBlock(state),
  };
}

function evidenceBlock(state) {
  return {
    source: state.url,
    identitySelector: '#identity',
    viewportSelector: '#viewport',
    detailSelector: '#detail',
    loginSelector: '#login',
    filterSelector: '#filter',
    screens: state.screens,
    uniqueRows: state.ids.size,
    sessionRenewals: state.sessionRenewals,
    restarts: state.restarts,
    attempts: state.attempts,
  };
}

async function writeJson(filename, value) {
  if (!filename) return;
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.part`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, filename);
}

async function settleBatch(state, frame) {
  const { identity } = frame;
  if (identity.filter !== state.filter) throw new Contaminated(identity.filter, state.filter);
  if (state.version === null) {
    state.version = identity.version;
    state.total = identity.total;
    state.attempts.push({ at: new Date().toISOString(), type: 'batch-fixed', version: state.version, total: state.total });
    return;
  }
  if (identity.version !== state.version) throw new VersionChanged(state.version, identity.version);
  if (identity.total !== state.total) throw new TotalChanged(state.total, identity.total);
}

async function processScreen(page, state, frame, options) {
  const { identity } = frame;
  const columns = dataColumns(frame.headers);
  const visibleRows = frame.rows.filter(row => row.visible);
  if (visibleRows.length === 0) throw new NavigationLost(`起始 ${identity.start} 的屏幕没有可见行`);
  const rawRows = visibleRows.map(row => ({
    ...row,
    raw: mapRow(row.cells, columns, frame.headers),
  }));
  const screenRecord = {
    filter: identity.filter,
    version: identity.version,
    start: identity.start,
    rowCount: rawRows.length,
    headers: frame.headers,
    endText: frame.endText,
    endSeen: endSeenFrom(frame.endText),
  };
  const seenScreen = state.screens.find(
    record => record.start === screenRecord.start && record.version === screenRecord.version
  );
  if (!seenScreen) state.screens.push(screenRecord);
  state.attempts.push({ at: new Date().toISOString(), type: 'screen', start: identity.start, rows: rawRows.length });

  for (let position = 0; position < rawRows.length; position += 1) {
    if (options.signal?.aborted) throw new CollectionAborted();
    const row = rawRows[position];
    const detail = await expandDetail(page, row.domIndex, identity);
    await restoreScreen(page, identity);
    const after = await readStableFrame(page, { quietMs: options.quietMs });
    if (after.identity.start !== identity.start) {
      throw new NavigationLost(`展开详情后屏幕由起始 ${identity.start} 变为 ${after.identity.start}`);
    }
    if (after.identity.filter !== identity.filter) throw new Contaminated(after.identity.filter, identity.filter);
    if (after.identity.version !== identity.version) throw new VersionChanged(identity.version, after.identity.version);
    if (after.identity.total !== identity.total) throw new TotalChanged(identity.total, after.identity.total);
    const verified = after.rows.find(candidate => candidate.domIndex === row.domIndex);
    if (!verified) throw new NavigationLost('展开详情后该可见行消失，原文无法复核');
    const afterRaw = mapRow(verified.cells, dataColumns(after.headers), after.headers);
    if (!sameRaw(afterRaw, row.raw)) throw new NavigationLost('展开详情前后可见行原文不一致');
    const observation = {
      id: detail.parsed.id,
      raw: row.raw,
      detail: detail.text,
      evidence: {
        locator: {
          identity: '#identity',
          viewport: '#viewport',
          row: `#viewport #rows tr:nth-child(${row.domIndex + 1})`,
          expand: `#viewport #rows tr:nth-child(${row.domIndex + 1}) button`,
          detail: '#detail',
        },
        identityText: frame.identityText,
        filter: identity.filter,
        version: identity.version,
        screenStart: identity.start,
        rowPosition: position,
        domIndex: row.domIndex,
        visibleHeaders: frame.headers,
        visibleCells: row.cells,
        endText: frame.endText,
        detailText: detail.text,
        capturedAt: new Date().toISOString(),
      },
    };
    const existing = state.ids.get(observation.id);
    if (existing) {
      if (!sameRaw(existing.raw, observation.raw)) {
        throw new NavigationLost(`材料 ${observation.id} 以不同字段内容重复出现，无法安全去重`);
      }
      existing.evidence.duplicateScreens = existing.evidence.duplicateScreens || [
        { start: existing.evidence.screenStart, position: existing.evidence.rowPosition },
      ];
      existing.evidence.duplicateScreens.push({ start: identity.start, position });
    } else {
      state.ids.set(observation.id, observation);
      state.rows.push(observation);
    }
    if (options.onRow) await options.onRow({ id: observation.id, duplicate: Boolean(existing), uniqueRows: state.ids.size });
  }
}

async function scan(page, state, options) {
  let previousStart = null;
  let screens = 0;
  const maximumScreens = 1000;
  while (screens <= maximumScreens) {
    if (options.signal?.aborted) throw new CollectionAborted();
    const frame = await readStableFrame(page, { quietMs: options.quietMs });
    await settleBatch(state, frame);
    const { identity } = frame;
    if (identity.start === previousStart) {
      throw new NavigationLost(`屏幕停留在起始 ${identity.start}，无法继续前进`);
    }
    screens += 1;
    await processScreen(page, state, frame, options);
    if (options.onScreen) {
      await options.onScreen({
        screen: screens,
        start: identity.start,
        rows: frame.rows.length,
        uniqueRows: state.ids.size,
        total: state.total,
        endSeen: endSeenFrom(frame.endText),
      });
    }
    if (state.checkpointPath) await writeJson(state.checkpointPath, checkpoint(state));
    if (endSeenFrom(frame.endText)) {
      state.endSeen = true;
      return;
    }
    previousStart = identity.start;
    if (await advanceToNextScreen(page, identity, options) === null) {
      state.endSeen = true;
      return;
    }
  }
  throw new NavigationLost('超过允许的屏幕数量仍未到达界面末尾');
}

function classifyFailure(error, state) {
  const reason = error instanceof CollectorFailure ? error.message : `未知错误：${error?.message || error}`;
  const incomplete = {
    complete: false,
    reason: `采集未完成：${reason}`,
  };
  if (state && state.ids.size > 0) {
    incomplete.reason += `；已保留 ${state.ids.size} 条唯一材料进度，未声明完整`;
  }
  if (error instanceof VersionChanged) {
    incomplete.reason = `站点版本在采集过程中由 ${error.previous} 变为 ${error.current}，本批次失去完整性结论，需按新版本重新规划`;
    incomplete.replan = { required: true, previousVersion: error.previous, observedVersion: error.current };
  } else if (error instanceof TotalChanged) {
    incomplete.reason = `界面总数在采集过程中由 ${error.previous} 变为 ${error.current}，本批次无法按原总数声明完整`;
    incomplete.replan = { required: true, previousTotal: error.previous, observedTotal: error.current };
  } else if (error instanceof Contaminated) {
    incomplete.reason = `筛选条件受到迟到响应的污染（页面报告 ${error.observed}，目标 ${error.expected}），本批次不得与其它筛选结果合并`;
  } else if (error instanceof SessionExpired) {
    incomplete.reason = '会话过期且未能在允许的次数内重新登录并重新确认筛选与版本，本批次未完成';
  } else if (error instanceof CollectionAborted) {
    incomplete.reason = '采集被中止，已保存的进度仅供人工续采参考，未声明完整';
  }
  return incomplete;
}

function completed(state) {
  if (state.version === null || state.total === null) {
    return { complete: false, reason: '采集未取得界面版本或总数，不能声明完整' };
  }
  if (!state.endSeen) {
    return { complete: false, reason: '采集未观察到界面末尾标志，不能声明完整' };
  }
  if (state.ids.size !== state.total) {
    return {
      complete: false,
      reason: `界面已到末尾，但唯一材料 ${state.ids.size} 条与界面总数 ${state.total} 条不一致（可能重复显示或缺行）`,
    };
  }
  const unique = new Set(state.rows.map(row => row.id));
  if (unique.size !== state.rows.length) {
    return { complete: false, reason: '输出中存在重复材料编号，不能声明完整' };
  }
  return { complete: true };
}

function finalize(state, outcome) {
  const value = {
    filter: state.filter,
    version: state.version,
    complete: outcome.complete,
    total: state.total,
    endSeen: state.endSeen,
    rows: state.rows,
    evidence: evidenceBlock(state),
  };
  if (!outcome.complete) {
    value.reason = outcome.reason;
    if (outcome.replan) value.replan = outcome.replan;
    value.evidence.progress = { uniqueRows: state.ids.size, total: state.total };
  }
  return value;
}

async function recover(page, state, options) {
  state.sessionRenewals += 1;
  state.attempts.push({ at: new Date().toISOString(), type: 'relogin', uniqueRows: state.ids.size });
  if (await formVisible(page)) await loginThroughForm(page, options.credentials);
  const identity = await chooseFilter(page, state.filter, options.settleMs);
  if (state.version !== null && identity.version !== state.version) {
    throw new VersionChanged(state.version, identity.version);
  }
  if (state.total !== null && identity.total !== state.total) {
    throw new TotalChanged(state.total, identity.total);
  }
  return identity;
}

export async function collectObservations({
  url,
  filter = 'grain',
  credentials = { username: 'reader', password: 'local-reader' },
  output = null,
  checkpointEnabled = Boolean(output),
  browserType = chromium,
  launchOptions = { headless: true },
  quietMs = 120,
  settleMs = 400,
  navigationTimeout = 15000,
  maxSessions = 3,
  maxRecoveries = 3,
  signal = null,
  beforeFilter = null,
  onFilterRetry = null,
  onScreen = null,
  onRow = null,
} = {}) {
  if (!['grain', 'tip'].includes(filter)) throw new Error('筛选条件必须是 grain 或 tip');
  if (!url) throw new Error('必须提供演练站地址');
  const state = {
    url,
    filter,
    version: null,
    total: null,
    endSeen: false,
    rows: [],
    ids: new Map(),
    screens: [],
    sessionRenewals: 0,
    restarts: 0,
    attempts: [],
    checkpointPath: checkpointEnabled ? output : null,
  };
  const options = {
    credentials, quietMs, settleMs, navigationTimeout, signal, onRow, onScreen,
  };
  let browser = null;
  let page = null;
  let outcome = null;
  try {
    try {
      browser = await browserType.launch(launchOptions);
    } catch (error) {
      // Browser binaries are installed during preparation; collection must
      // never download them on the fly.
      throw new SessionUnrecoverable(
        `无法启动 Chromium（${error.message.split('\n')[0]}）。请先在准备阶段安装浏览器，运行阶段不下载依赖`);
    }
    page = await browser.newPage();
    await page.goto(url);
    let sessions = 0;
    let recoveries = 0;
    let prepared = false;
    while (outcome === null) {
      try {
        if (!prepared) {
          if (options.signal?.aborted) throw new CollectionAborted();
          await loginThroughForm(page, credentials);
          if (beforeFilter) await beforeFilter(page);
          await chooseFilter(page, filter, settleMs, 3, async (error, attempt) => {
            state.restarts += 1;
            state.attempts.push({
              at: new Date().toISOString(),
              type: 'filter-retry',
              attempt,
              observedFilter: error.observed,
              uniqueRows: state.ids.size,
            });
            if (onFilterRetry) await onFilterRetry({ error, attempt });
          });
          state.attempts.push({ at: new Date().toISOString(), type: 'filter-selected', filter });
          prepared = true;
        }
        await scan(page, state, options);
        outcome = completed(state);
      } catch (error) {
        if (options.signal?.aborted) {
          outcome = classifyFailure(new CollectionAborted(), state);
          break;
        }
        if (error instanceof SessionExpired && sessions < maxSessions - 1) {
          sessions += 1;
          prepared = false;
          try {
            await recover(page, state, options);
            prepared = true;
          } catch (recoveryError) {
            if (recoveryError instanceof SessionExpired) continue;
            outcome = classifyFailure(recoveryError, state);
          }
          continue;
        }
        if (error instanceof Contaminated && recoveries < maxRecoveries) {
          // The contaminated response is not merged into the batch.  Verified
          // rows are kept; navigation restarts from screen 0 after the filter
          // is re-selected, which issues a request that cannot be overtaken by
          // the old one.
          recoveries += 1;
          state.restarts += 1;
          state.attempts.push({ at: new Date().toISOString(), type: 'restart-after-contamination', uniqueRows: state.ids.size });
          try {
            await chooseFilter(page, filter, settleMs);
            const identity = await readCurrentIdentity(page);
            if (state.version !== null && identity?.version !== state.version) {
              throw new VersionChanged(state.version, identity?.version);
            }
            if (state.total !== null && identity?.total !== state.total) {
              throw new TotalChanged(state.total, identity?.total);
            }
          } catch (restartError) {
            outcome = classifyFailure(restartError, state);
            continue;
          }
          continue;
        }
        outcome = classifyFailure(error, state);
      }
    }
  } catch (error) {
    outcome = classifyFailure(options.signal?.aborted ? new CollectionAborted() : error, state);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  if (outcome.complete === undefined) outcome = classifyFailure(new Error('采集未产生结论'), state);
  const result = finalize(state, outcome);
  if (output) await writeJson(output, result);
  return result;
}
