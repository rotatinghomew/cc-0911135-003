演练账号 reader / local-reader 是纯本地固定值。采集入口应通过网页上显示的控件操作，不以隐藏的 /api/rows 或 /api/detail 作为采集接口。源码中的内部接口仅服务门户自身。

每种筛选有 30 条材料，单屏复用六行 DOM；材料编号只在详情面板显示。滚动容器 #viewport 每 240 像素更新一屏，界面提供展示筛选、版本、总数和末尾提示。站点版本由 version 控制。

控制参数：late=true 让籽粒筛选响应迟到；expireAfter=N 令一个会话读 N 次后过期一次；reverseColumns=true 改列表头顺序；duplicate=true 在每个非首屏显示上一屏末条以演练不完整检测。刷新按钮可重新读取本屏。

observations.json：filter、version、complete 布尔值、total、rows 数组（id、raw、detail、evidence），未完成时含 reason。同一批次所有行需同筛选同版本；complete=true 时唯一行数应等于 total，且有 endSeen=true 的页面证据。

采集入口 `npm run collect -- --url <门户地址>` 通过真实 Chromium 操作可见控件：登录表单、`#filter`、`#viewport` 滚动、行内“展开详情”。字段原文按当屏表头定位；`raw` 的键即可见表头文字，因此 `reverseColumns=true` 时键顺序随界面变化。`evidence` 每行记录 `#identity` 原文、表头、可见单元格、详情原文、当屏起始和采集时间，并带 `locator` 便于复核。

`complete` 只在界面总数、末尾标志与去重后材料编号数一致时为真。否则输出 `complete=false`、`reason` 和 `evidence.progress`（已保留的唯一数）。版本或总数中途变化时另带 `replan.required=true` 及前后值；此时同一输出不会混入两代数据。切换筛选后若目标屏被其它筛选的迟到响应覆盖，采集会重新选择目标筛选并记录 `filter-retry`，污染屏不写入结果。会话过期时重新登录并重新确认筛选与版本后才继续。输出在运行中原子写入检查点，被中止时保留已有进度与原因。
