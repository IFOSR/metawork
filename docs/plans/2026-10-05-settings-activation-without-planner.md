# 设置激活去除 Planner 依赖

- 日期：2026-10-05
- 状态：已完成并部署本机；用户已明确要求
- 完成日期：2026-10-05
- 收口提交：`15197ec`（随 v0.1.4 同步至 GitHub）

## 问题与交付边界

保存链路仍通过 ExecutorManualPlanner.compileAll 串行调用用户的 Planner，
每次最多等待 60 秒。2026-10-05 14:48 的两次配置会话分别等待约 25、35 秒。
这违背 ADR-0044 的内部 LLM 独立性，也违背自然语言职责直接参与路由的设计。

Configuration 拥有确定性的校验、画像编译与持久化。移除生产保存入口的
compileAll 和 ExecutorManualPlanner，替换旧说明书预览 API 为纯配置预览。
预览保留用户原文；原文变更后不套用旧语义 assertions，不从原文授予能力或权限。
已有未修改的历史 assertions 保持兼容，ConfigurationService 的防伪校验不取消。
激活继续执行原子切换、revision 固定、回滚、凭证校验和热生效通知。

AI 改写、能力更新和 OpenRouter 信息整理仍由独立 InternalLlmService 提供，
用户点击相应 AI 操作才生成内容；保存不新增任何 LLM 请求。Planner 只处理面向
用户的意图理解、任务拆解和编排；热切换 Planner 配置不等于调用 Planner 模型。

依赖方向：Management → Configuration；内部 AI → InternalLlmService；
Configuration 不再依赖 PlannerRunner / PlannerHostBridge。删除旧配置语义
提示词、解析及串行编译分支。不改存储 schema，不新增语义路由，无临时例外。

## 验证计划

无 Planner/内部 LLM 依赖时，多智能体职责编辑可保存；前后自然语言职责一致；
未改的历史 assertions 保留、改后不复用；伪造 assertions 仍不能激活；错误版本
与回滚/凭证补偿继续有效。运行配置、管理 API、内部 LLM、路由回归、类型检查和
构建。升级后实测保存耗时及 configuration Planner 会话数，记录结果。


## 保存成功后的展示等待

前端成功处理原来会再次调用配置补全（包含 OpenRouter 目录请求）。调整为只读取
已保存的本地配置与凭证状态，复用公开目录缓存；成员与模型事实以新 revision 为准，
不能通过缓存恢复已删除 Provider 或旧模型数据。页面刷新失败单独提示，不把已提交
的激活误报为失败。新增 Chrome 回归将第二次目录请求永久挂起，验证保存仍能结束。


## 交付与验证

- 删除旧 ExecutorManualPlanner（含 PlannerRunner/Host 依赖、配置提示词、输出解析和 compileAll），新增只依赖 ConfigurationService 的 ExecutorManualPreviewService。既有 analyze/compile 路径仅返回 source-preserved 预览，不触发任何模型生成。
- 保存入口只调整凭证引用；保留语义 assertions 防伪校验、revision/idle gate、回滚和热生效机制。未更改 Planner 的任务规划行为或内部 LLM 配置。
- 44 个配置、管理 API、路由及热激活测试文件共 369 项通过；新增依赖边界断言验证 Configuration 不依赖 Planning/TUI bridge。新增服务测试验证无 Planner/内置 LLM 的多职责保存、原文保留、旧 assertions 兼容、变更后清理及客户端伪造不能成为权威。
- 2 项 Chrome 回归通过：成功保存无需再次获取公开目录，以及 AI 操作状态/并发编辑保护；该文件 5 项无关用例未运行。
- `npm run lint`、Web TypeScript、完整构建、最终 Web 构建和 `git diff --check` 通过。
- 本机最终发布 `0.1.3-settings-save-no-planner-20261005-1791184004146`，服务 ready。部署前无活动 Task；部署前后 Provider 凭证、内部 LLM 配置/凭证和 active YAML 逐字节一致。
- 真实 API：编辑职责预览 12ms，返回 source-preserved 和空 assertions；保持现有配置值的激活 98ms，配置值/密钥不变，新 Planner 配置会话数为 0。
- 最终真实浏览器：点击“保存并激活”到按钮恢复约 204ms，其中后端激活 99ms，额外公开目录请求 0，新增 Planner 配置会话 0。为避免验证改写用户配置，请求保持当时已保存配置值，正常创建新 revision；多职责变更由独立配置集成测试验证。以上是本机单次实测，不作为所有环境的固定时延保证。
