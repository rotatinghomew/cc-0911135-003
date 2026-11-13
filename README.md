# phenotype-grid-reader

用于共享材料查阅的浏览器门户，具备登录、筛选、虚拟列表及行内详情。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。
准备浏览器环境时执行 `npx playwright install chromium`，或复用已安装且版本相符的 Chromium。运行阶段不下载浏览器。
浏览器页面回归：`npm run test:browser`。

```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

演练账号 reader / local-reader 是纯本地固定值。采集入口应通过网页上显示的控件操作，不以隐藏的 /api/rows 或 /api/detail 作为采集接口。源码中的内部接口仅服务门户自身。

每种筛选有 30 条材料，单屏复用六行 DOM；材料编号只在详情面板显示。滚动容器 #viewport 每 240 像素更新一屏，界面提供展示筛选、版本、总数和末尾提示。站点版本由 version 控制。

控制参数：late=true 让籽粒筛选响应迟到；expireAfter=N 令一个会话读 N 次后过期一次；reverseColumns=true 改列表头顺序；duplicate=true 在每个非首屏显示上一屏末条以演练不完整检测。刷新按钮可重新读取本屏。浏览器测试仅验证门户功能，不实现整表采集。

observations.json：filter、version、complete 布尔值、total、rows 数组（id、raw、detail、evidence），未完成时含 reason。同一批次所有行需同筛选同版本；complete=true 时唯一行数应等于 total，且有 endSeen=true 的页面证据。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- observations.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
