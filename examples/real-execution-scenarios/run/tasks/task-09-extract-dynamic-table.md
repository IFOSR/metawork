# 任务 09：提取动态渲染的表格

附件：`attachments/task-09/dynamic.html`

页面数据由 JS 在加载约 500ms 后注入表格，直接抓取 HTML 拿不到行数据。

用真实浏览器打开它（file:// 或自行起本地服务均可），等渲染完成后，
把表格数据提取为 `products.json`：

- 数组，每项含 `sku`、`name`、`stock`、`price` 四个字段
- `stock` 为整数，`price` 为数值（不是字符串）
