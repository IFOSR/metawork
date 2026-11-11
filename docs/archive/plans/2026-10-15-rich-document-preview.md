# 富文档预览实施记录

- 日期：2026-10-15
- 状态：本地实施、浏览器与 macOS arm64 安装包验收完成；未正式发布
- 完成日期：2026-10-15
- 目标：Web/Desktop 的既有预览抽屉支持 HTML、Word（DOCX）、PowerPoint（PPTX）、Excel（XLSX/XLS/CSV）及 PDF；产物和当前会话附件共用阅读器，保留原文件下载。

## 边界与实施

1. Delivery 提供纯格式识别；Storage/Management 在读取投影时派生 `documentFormat`，不更改已落盘 `preview_kind` 枚举或历史记录，不新增数据库迁移。历史 octet-stream 文件按名称识别。
2. Management 保持现有 Account/Task/Conversation 授权和路径约束，返回受大小约束的文件内容；附件使用既有授权读取端点。浏览器本地解析，文件不发送给第三方服务，Planner/Kernel/Runtime 不参与文档展示。
3. 共用隔离预览页承载本地阅读器。HTML 禁止脚本；Office 阅读器运行在不具备同源权限的 sandbox iframe 中，CSP 禁止文档网络请求和表单提交。浏览器消息核对窗口身份；重选、关闭、切换会话时旧内容不得覆盖新文件。
4. DOCX 保留文档样式/表格/图片，PPTX 展示幻灯片，Excel 工作表切换并展示单元格值，PDF 分页渲染。复杂 Office 特性不承诺与原生 Office 像素一致；旧二进制 DOC/PPT 暂提供原文件下载和转为 DOCX/PPTX 的提示。
5. 检查格式识别、历史投影、权限/路径/大小边界、损坏文件反馈、下载保留和真实 Chrome 预览。用包含中文、图片、表格和多页/多工作表的文件验收，检查 HTML 脚本不能影响应用及联网。

允许依赖：Web → 纯格式类型/函数、浏览器渲染依赖；Management → Delivery/已有授权文件服务；Storage → 纯投影分类。禁止 Web 访问数据库/私有路径、预览触发 Executor、服务器执行 Office 宏或外传原文件。没有新的调度、恢复或持久化协议。

## 验证与 review

已交付以上七类格式预览；历史 `unsupported`/octet-stream 文件在读取时识别，未新增 SQLite schema 或修改历史产物。产物、消息附件及输入框已上传附件共用抽屉。保留原文件下载，Desktop 附件保存通过受限 ID IPC、原生保存对话框和已有原子写入逻辑。

验证：

- 6 文件 99 项定向测试通过：授权、路径/大小边界、历史投影、发布、加载、下载与 iframe 权限；根 lint/bundle、Web build 通过。渲染库按格式懒加载，大分块只在预览时加载；构建包含第三方许可证。
- Desktop lint/build 和 7 文件 17 项测试通过。真实 Electron 原生保存冒烟通过：产物 Markdown/PDF 与中文名附件、取消、非法 ID 拒绝、重连/渲染崩溃恢复；对话框和下载 HTTP 使用测试替身。测试 Server 已显式停止。
- 真实 production Server + Chrome 端到端通过：HTML 样式/内嵌图片/同目录图片与脚本隔离、DOCX 中文/表格/图片/两页、PPTX 三页及翻页、XLSX 合并/填色/货币格式/缓存公式值/工作表切换、XLS、中文 CSV、PDF、损坏文件错误与原始下载、附件上传后预览、匿名访问拒绝。无 pageerror；恶意 HTML 外部图片触发预期 CSP 拦截。验收发现并修正 Word 窄窗口裁切、CSV UTF-8 乱码；货币样例使用标准带引号的字面货币格式。
- macOS DMG 只读挂载后运行隔离首次安装与包内阅读器：Word、PPT、Excel、PDF 均通过；iframe 无父 DOM/原生 bridge 权限。用户之前实际产出的“MetaWork-企业主权AI-算力盒子-三页商业宣讲.pptx”经只读哈希核验后，在隔离包内阅读器验证全部三页有内容且可切换；原文件未改写、未外传，也未放入发布包。这是本地预览验收，不是重新登录或重新执行用户任务。

安装包：`Release/MetaWork-0.1.15-internal-rich-preview-20261015-darwin-arm64.dmg`，449,260,506 bytes；release ID `0.1.15-internal-rich-preview-20261015`。`hdiutil verify`、ad-hoc `codesign --verify --strict`、包内 38,767 文件清单校验通过；首次安装、设置激活/失败保留、菜单、退出后 Server 存活通过。测试 Server 已停止，DMG 已卸载，未替换用户现有安装。

SHA-256：`a0c3d157782ea2b7bcd632e1332217b1fbd496930cfedfe73306724a0b71230b`。证据位于 `Release/rich-preview-20261015-evidence/`；用户原始 PPT 的临时副本仅在忽略的本地测试目录中。

Review：读取授权仍由现有 Server 服务负责，格式识别与浏览器渲染不进入 Kernel/Runtime，不重新发布或重写历史文件。旧二进制 DOC/PPT、Office 宏/动画/部分嵌入对象和复杂图表不在本期保真范围；单文件 32 MiB、ZIP 展开总量 96 MiB、工作表前 1000 行/100 列有明确上限。没有声称与原生 Office 像素级一致。内部 arm64 试用包未 Apple 公证、未对外发布；整个任务可靠性计划的其他平台验收未因此关闭。

收尾提交：未创建。工作区含用户既有修改，不创建混合提交。源码、验证与内部安装包已保留供审阅。
