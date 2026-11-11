# 报告 Markdown / PDF 下载

- 日期：2026-10-10
- 状态：本地实施及专项验收完成，待用户试用
- 完成日期：2026-10-10
- 提交：按用户要求暂不提交或推送 GitHub

## 交付范围

Markdown 产物的预览下载菜单提供「Markdown（原文）」和「PDF 文档」。
PDF 在本机 Server 按需生成，复用 artifact ID 及现有账户/任务/发布文件读取检查。
不依赖官方 Server、内置 AI 或系统浏览器；不修改原始产物、存储模型或发布事实。
浏览器直接下载；Desktop 通过同一接口和原生保存对话框保存，可在 Finder 中显示。
非 Markdown 产物保留原文件下载。

## 实现

- `/api/artifacts/:id/download` 保持原始字节；`?format=pdf` 只接受 Markdown。
- `report-pdf.ts` 将 GFM 标题、段落、列表、引用、代码、链接、表格排成 A4，自动分页及重复表头。
- 随运行时分发 Noto Sans SC Regular/Bold 及 OFL 许可，PDF 子集嵌入字体，中文可复制/搜索。
- 可嵌入报告目录及子目录内的 PNG/JPEG；路径沿用发布根检查。
- 远程图片、目录外图片和不支持的图像格式显示替代文本/链接；不拉取远程资源。
  HTML 不执行，Mermaid/数学公式等扩展不额外渲染。
- PDF 生成错误可重试；取消原生对话框不报错。

## 验证

- `npm run lint`、`npm run build`、`npm run lint:desktop`、`npm run build:desktop` 通过。
- Management / PDF / 预览控制专项测试 71 项通过；Desktop 单元测试 16 项通过。
- PDF 用独立的 PDF.js 解析验证：中文全文、110 行跨页表格及重复表头、末行和末段、嵌套列表、代码、图片、空文档、页码。
- Chrome 实际下载验收通过：MD 原始字节、PDF 文件及中文文件名、错误重试、键盘 Tab/Escape、非 Markdown 下载、原生桥调用/取消/定位。
- 深色 1100px 与浅色 390px 菜单截图及四页中文 PDF 样张已目视检查。
- `npm run smoke:desktop` 通过：隔离开发安装内运行真实 Electron main/preload，验证两种格式的保存、PDF 扩展名与过滤器、取消及 Finder 定位；HTTP 和系统对话框使用测试替身。
- 构建后的 `dist/report-pdf-*.js` 已实际生成 PDF，确认 `dist/fonts` 打包路径可用。
- 证据：`.tmp/report-download/`（构建日志、菜单截图、四页 PDF 样张及页面截图）；`.tmp/desktop-development/evidence/electron-smoke.json`（原生 smoke）。

旧 `artifact-preview-and-ime` 综合浏览器夹具缺少当前 Conversation `/view` 接口，在历史加载阶段即 404；没有将其计为通过或修改该旧夹具。本次新增 `report-download` 专项浏览器夹具直接加载正式预览组件及样式，覆盖上述下载行为。

## 交付状态

未修改用户正式安装或官方 Server，也未发布版本或提交 Git。
用户随后要求重新打包，已纳入 `0.1.9-internal-local20261010b` 试用 DMG；
参见[打包及联合验收记录](2026-10-10-report-manual-trial-dmg.md)。
现有客户端需要安装新包并完成更新后才能使用。
Closing commit：无，按用户要求保留未提交状态。
