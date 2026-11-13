const login = document.querySelector('#login');
const workspace = document.querySelector('#workspace');
const viewport = document.querySelector('#viewport');
const filter = document.querySelector('#filter');
const message = document.querySelector('#message');
let shownOffset = -1;
let columns = [];
async function request(path) {
  const response = await fetch(path);
  if (response.status === 401) {
    login.hidden = false; workspace.hidden = true;
    throw new Error('会话过期，请重新登录');
  }
  if (!response.ok) throw new Error('读取失败');
  return response.json();
}
async function load(offset) {
  shownOffset = offset;
  const result = await request(`/api/rows?filter=${filter.value}&offset=${offset}`);
  columns = result.columns;
  document.querySelector('#identity').textContent = `展示筛选 ${result.filter}；版本 ${result.version}；总数 ${result.total}；起始 ${result.offset}`;
  document.querySelector('#headers').replaceChildren(...[...columns, '详情'].map(name => {
    const header = document.createElement('th'); header.textContent = name; return header;
  }));
  const body = document.querySelector('#rows');
  while (body.children.length < result.rows.length) body.append(document.createElement('tr'));
  while (body.children.length > result.rows.length) body.lastChild.remove();
  result.rows.forEach((row, position) => {
    const node = body.children[position];
    node.replaceChildren(...columns.map(column => {
      const cell = document.createElement('td'); cell.textContent = column === '材料名称' ? row.name : row.status; return cell;
    }));
    const cell = document.createElement('td');
    const button = document.createElement('button'); button.textContent = '展开详情';
    button.onclick = async () => {
      try {
        const detail = await request(`/api/detail?filter=${result.filter}&index=${row.index}`);
        document.querySelector('#detail').textContent = `材料编号 ${detail.accession}；${detail.detail}；版本 ${detail.version}`;
      } catch (error) { message.textContent = error.message; }
    };
    cell.append(button); node.append(cell);
  });
  document.querySelector('#end').textContent = result.end ? '本筛选已到末尾' : '继续滚动加载';
  document.querySelector('#space').style.height = '1440px';
  document.querySelector('#screen').style.transform = `translateY(${offset * 40}px)`;
  message.textContent = '已更新';
}
login.onsubmit = async event => {
  event.preventDefault();
  const response = await fetch('/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(login))) });
  if (!response.ok) { message.textContent = '登录失败'; return; }
  login.hidden = true; workspace.hidden = false;
  try { await load(Math.max(0, shownOffset)); } catch (error) { message.textContent = error.message; }
};
filter.onchange = () => { viewport.scrollTop = 0; document.querySelector('#detail').textContent = ''; load(0).catch(error => { message.textContent = error.message; }); };
viewport.onscroll = () => {
  const offset = Math.min(24, Math.floor(viewport.scrollTop / 240) * 6);
  if (offset !== shownOffset) load(offset).catch(error => { message.textContent = error.message; });
};
document.querySelector('#refresh').onclick = () => load(Math.max(0, shownOffset)).catch(error => { message.textContent = error.message; });
