import { readFile } from 'node:fs/promises';
import { serve, json, text, body } from '../lib/http.mjs';
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
export async function createSite(port = 0) {
  const sessions = new Map();
  let nextSession = 0;
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/') { text(response, 200, html, { 'content-type': 'text/html; charset=utf-8' }); return true; }
    if (url.pathname === '/app.js') { text(response, 200, script, { 'content-type': 'text/javascript' }); return true; }
    if (url.pathname === '/login' && request.method === 'POST') {
      const credentials = await body(request);
      if (credentials.username !== 'reader' || credentials.password !== 'local-reader') {
        json(response, 403, { error: '演练账号不正确' }); return true;
      }
      const session = `grid-${++nextSession}`;
      sessions.set(session, { reads: 0 });
      json(response, 200, { ok: true }, { 'set-cookie': `session=${session}; HttpOnly; SameSite=Strict; Path=/` });
      return true;
    }
    if (url.pathname !== '/api/rows' && url.pathname !== '/api/detail') return false;
    const session = sessions.get(/session=([^;]+)/.exec(request.headers.cookie || '')?.[1]);
    if (!session || state.expireAfter > 0 && ++session.reads > state.expireAfter && !state.expired) {
      if (session) { state.expired = true; sessions.clear(); }
      json(response, 401, { error: '会话过期，请重新登录' }); return true;
    }
    const filter = url.searchParams.get('filter');
    if (!['grain', 'tip'].includes(filter)) throw new Error('未知样本部位');
    if (url.pathname === '/api/detail') {
      const index = Number(url.searchParams.get('index'));
      json(response, 200, { accession: `${filter === 'grain' ? 'G' : 'T'}-${String(index + 1).padStart(3, '0')}`,
        detail: `部位=${filter}; 材料组=${index % 3}; 状态=可共享`, version: state.version, filter });
      return true;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset >= 30) throw new Error('偏移超出范围');
    if (state.late && filter === 'grain') await new Promise(resolve => setTimeout(resolve, 80));
    const indices = Array.from({ length: Math.min(6, 30 - offset) }, (_, position) => offset + position);
    if (state.duplicate && offset > 0) indices[0] = offset - 1;
    json(response, 200, { filter, version: state.version, total: 30, offset,
      columns: state.reverseColumns ? ['状态', '材料名称'] : ['材料名称', '状态'],
      rows: indices.map(index => ({ index, name: `共享材料 ${index + 1}`, status: index % 2 ? '有效' : '待复核' })),
      end: offset + 6 >= 30 });
    return true;
  }, { version: 'grid-v1', expireAfter: 0, expired: false, late: false, duplicate: false, reverseColumns: false }, port);
}
