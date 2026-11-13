演练账号 reader / local-reader 是纯本地固定值。采集入口应通过网页上显示的控件操作，不以隐藏的 /api/rows 或 /api/detail 作为采集接口。源码中的内部接口仅服务门户自身。

每种筛选有 30 条材料，单屏复用六行 DOM；材料编号只在详情面板显示。滚动容器 #viewport 每 240 像素更新一屏，界面提供展示筛选、版本、总数和末尾提示。站点版本由 version 控制。

控制参数：late=true 让籽粒筛选响应迟到；expireAfter=N 令一个会话读 N 次后过期一次；reverseColumns=true 改列表头顺序；duplicate=true 在每个非首屏显示上一屏末条以演练不完整检测。刷新按钮可重新读取本屏。浏览器测试仅验证门户功能，不实现整表采集。

observations.json：filter、version、complete 布尔值、total、rows 数组（id、raw、detail、evidence），未完成时含 reason。同一批次所有行需同筛选同版本；complete=true 时唯一行数应等于 total，且有 endSeen=true 的页面证据。
