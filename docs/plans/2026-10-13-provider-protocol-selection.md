# Provider 协议选择与 GPT Responses 切换

- 日期：2026-10-13。
- 状态：已实施；用户明确要求 GPT / Code CLI 改 Responses，并自行跟进真实任务测试。
- 范围：Provider 协议配置、Pi/Planner runtime、设置页、目录探测和本机安装更新。

## 所有权与边界

Configuration 拥有协议类型、验证、运行文件生成和凭据绑定；Management/Web 只传递
草稿并调用既有严格空闲激活事务。Pi 使用对应原生 API；Kernel 策略与完成认证不变。
不新增路由器、协议自动猜测、执行兜底或隐藏付费测试。无新增跨层依赖与临时例外。
公开配置增加 `openai-responses`，保留既有 Chat 值；Anthropic 选项接通原生 Messages。
Codex 继续使用 Responses，拒绝 Anthropic 绑定。已修改 ADR-0033 和当前契约文档。

## 交付内容

1. 新增/编辑 Provider 显式选择 Chat Completions、Responses 或 Anthropic Messages。
2. 协议保存到 revision 并投影到 Pi/Planner models.json，不仅改变 UI 文案。
3. 目录发现/凭据验证使用协议对应路径与头；连接去重纳入协议。
4. 本机只将 `code-cli.protocol` 改为 `openai-responses`，不改模型、Key、BaseURL、
   AgentClass 绑定、OpenRouter/Drex 决策模型或其策略。Images API 不受文本 adapter 影响。
5. 保留旧安装包与 revision，使用正式签名内部包更新和配置激活入口。

## 验证与限制

已完成类型检查、构建、66 个配置/管理回归测试（533 tests）、浏览器新增 Provider 协议保存测试和本机 revision/runtime 核查。
用户选择在隔离测试未完成的情况下先切换；不再进行付费 GPT 任务试验，不宣称执行问题已解决。
不连接 Windows 远程桌面，不恢复旧失败任务。Claude 生产配置本轮不变。

- 完成日期：2026-10-13。
- 收尾提交：未提交；保留工作区其他既有修改。安装包已通过正式本地签名更新流程部署。
