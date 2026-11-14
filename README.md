# phenotype-grid-reader

用于共享材料查阅的浏览器门户，具备登录、筛选、虚拟列表及行内详情。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。
准备浏览器环境时执行 `npx playwright install chromium`，或复用已安装且版本相符的 Chromium。运行阶段不下载浏览器。
浏览器页面回归：`npm run test:browser`。

独立的 Linux 页面运行检查还使用 Python Playwright，其完整依赖固定在 `requirements-verification.txt`，不参与 Node.js 业务实现。准备阶段在检查器使用的 Python 虚拟环境中执行 `python3 -m pip install -r requirements-verification.txt`，并执行 `python3 -m playwright install chromium`；不能仅安装 npm 包而遗漏该虚拟环境。项目环境准备工具会按这些清单预装两套绑定及对应浏览器，运行构建、测试、服务或演练时不再安装依赖。

```bash
npm run build
npm test
npm run demo
npm start
npm run collect -- --url http://127.0.0.1:端口 --filter grain --out observations.json
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。
`npm run test:browser` 在真实 Chromium 中运行门户回归与采集入口的情景测试。

## 数据与运行边界

演练账号 reader / local-reader 是纯本地固定值。采集入口应通过网页上显示的控件操作，不以隐藏的 /api/rows 或 /api/detail 作为采集接口。源码中的内部接口仅服务门户自身。

每种筛选有 30 条材料，单屏复用六行 DOM；材料编号只在详情面板显示。滚动容器 #viewport 每 240 像素更新一屏，界面提供展示筛选、版本、总数和末尾提示。站点版本由 version 控制。

控制参数：late=true 让籽粒筛选响应迟到；expireAfter=N 令一个会话读 N 次后过期一次；reverseColumns=true 改列表头顺序；duplicate=true 在每个非首屏显示上一屏末条以演练不完整检测。刷新按钮可重新读取本屏。`npm run test:browser` 同时覆盖门户交互与采集入口在这些开关下的行为。

observations.json：filter、version、complete 布尔值、total、rows 数组（id、raw、detail、evidence），未完成时含 reason。同一批次所有行需同筛选同版本；complete=true 时唯一行数应等于 total，且有 endSeen=true 的页面证据。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

## 采集入口

`lib/collector.mjs` / `npm run collect` 通过真实 Chromium 打开门户，只操作页面上可见的控件：登录表单、`#filter` 下拉框、`#viewport` 滚动和每行的“展开详情”按钮。它不调用 `/api/rows` 或 `/api/detail`，也不读取页面脚本变量；字段原文按当屏可见表头定位，材料身份只取详情面板中的材料编号，不使用行号或位置。

采集以“筛选条件 + 站点数据版本”为固定批次：

- 首个屏幕确定批次的 filter/version/total，之后每屏、每次展开详情前后都重新核对；版本或总数变化即放弃该批次的完整性结论，输出 `complete=false` 与 `replan`，不混合两代数据。
- 切换筛选后必须看到目标筛选的屏幕连续稳定一个静默窗口才接受；若之前的目标屏被其它筛选覆盖，视为迟到响应污染，重新选择目标筛选并重新确认版本，污染屏不进入结果。
- 会话过期时通过登录表单重新登录，然后重新选择筛选并核对版本与总数，再从界面重新读取，而不是沿用旧 DOM。
- 完成依据是界面报告的总数、末尾标志和已见唯一材料编号三者一致；不以固定滚动次数或等待秒数收尾。
- 每个已取行都记录 DOM 定位、当时的 `#identity` 原文、表头/单元格原文、详情原文和采集时间；同一屏去重后唯一数不足 `total` 时输出 `complete=false` 和原因，并保留进度。
- 运行中会原子写入检查点（`.part` 后改名），Ctrl-C/SIGTERM 也会落盘未完成结果与原因。

浏览器（Playwright Chromium 与 Node/Python 绑定）只在准备阶段安装；运行、测试和演练阶段不会下载。

## 数据校验

`npm run verify -- observations.json` 检查本地结果的基本业务不变量（结构、唯一编号、单批次同筛选同版本、完整时唯一数等于总数且有末尾证据），缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
