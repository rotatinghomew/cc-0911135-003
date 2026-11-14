import { collectObservations } from '../lib/collector.mjs';

function usage() {
  return '用法：npm run collect -- --url http://127.0.0.1:端口 [--filter grain|tip] [--out observations.json] ' +
    '[--username reader] [--password local-reader] [--headed]';
}

function parseArguments(argv) {
  const options = { filter: 'grain', out: 'observations.json' };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--headed') { options.headless = false; continue; }
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const name = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`参数 ${item} 缺少取值\n${usage()}`);
    index += 1;
    if (name === 'url') options.url = value;
    else if (name === 'filter') options.filter = value;
    else if (name === 'out') options.out = value;
    else if (name === 'username') options.username = value;
    else if (name === 'password') options.password = value;
    else throw new Error(`未知参数 ${item}\n${usage()}`);
  }
  if (!options.url && positional.length > 0) options.url = positional[0];
  if (positional.length > 1) options.filter = positional[1];
  if (positional.length > 2) options.out = positional[2];
  if (!options.url) throw new Error(usage());
  if (!['grain', 'tip'].includes(options.filter)) throw new Error('筛选条件必须是 grain 或 tip');
  return options;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`收到 ${signal}，正在保存已采进度`);
    controller.abort();
  });
}

const result = await collectObservations({
  url: options.url,
  filter: options.filter,
  credentials: {
    username: options.username || 'reader',
    password: options.password || 'local-reader',
  },
  output: options.out,
  launchOptions: { headless: options.headless !== false },
  signal: controller.signal,
  onScreen: screen => {
    const state = screen.endSeen ? '末尾' : '继续';
    console.error(`第 ${screen.screen} 屏 起始 ${screen.start}：本屏 ${screen.rows} 条，唯一 ${screen.uniqueRows}/${screen.total}（${state}）`);
  },
});

console.log(JSON.stringify(result, null, 2));
if (!result.complete) process.exitCode = 2;
