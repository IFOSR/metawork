# 当前 Provider 协议核对与隔离测试

- 日期：2026-10-13。
- 状态：诊断已完成；Provider 协议选择、运行时投影和 GPT Responses 切换已在 2026-10-13 实施。真实 GPT 任务验收由用户后续执行。
- 用户目标：调整已有 Provider，验证能否解决不执行的问题，并澄清 OpenAI-compatible 与 Chat Completions 的关系。
- 实施前配置：`revision-7e67849d-7a07-43f9-8485-d085f61ebe21`。实施后已激活 revision `revision-c2f9e56d-4d14-4d37-9a1c-f3c47476dc87`，仅将 Code CLI Provider 切换为 `openai-responses`。
- 安装更新 / 程序实现：已完成；真实 GPT 任务仍待用户验收。

## 协议名称的澄清

MetaWork 现有 `openai-compatible` 配置会被渲染为 Pi 的 `openai-completions`，请求 Chat Completions。它们是配置层与执行器层对同一路径的命名，不是切换后便能启用工具的两种模式。

Responses 是另一套 API。模型、服务和执行器必须同时支持选择的协议。OpenAI 的 function-calling 文档目前明确指出 GPT-6 Astra 等模型的官方工具调用需要 Responses；第三方服务是否转换、如何路由仍需单独验证，配置模型名称不等于已证明的上游身份。

官方参考：<https://developers.openai.com/api/docs/guides/function-calling>。本轮已获取正文核对，文档列出 Chat Completions 与 Responses 示例及适用模型条件。

## 隔离实测

使用当前安装包内置 Pi 1.0.0，临时 HOME/工作目录、原有凭据与模型、read/bash/edit/write 工具。测试读取随机内容的 input.txt，原样写入 output.txt 并读回；测试端比较真实字节。每次最多运行 120 秒，保留所有失败记录。

| Provider | 模型与配置 | 结果 | 配置处理结论 |
| --- | --- | --- | --- |
| Code CLI / GPT | gpt-6-astra，现有 Chat Completions | 已调用 read，后续多次服务器 overloaded，120 秒终止；无 output.txt | 不能声称不支持工具，也不能声称通过；未证明改 BaseURL 能解决 |
| Code CLI / GPT | 同模型，同 BaseURL，隔离切为 Responses | 已调用 read，120 秒内未完成后续操作；无 output.txt | 候选协议尚未完成验收，不激活未经验证的切换 |
| GLM | glm-5.3-flash，现有 Chat Completions | 经限流/超时重试后实际完成，主动修复多余换行 | 保留协议；限流需与工具协议区分 |
| GLM | glm-5.3-flashx，现有 Chat Completions | 429 / 1311：订阅不包含 FlashX | 修改协议不能授予订阅权限；不擅自购买或更换默认模型 |
| Code CLI Anthropic | claude-opus-5，候选 Anthropic Messages | 实际读、写、读回成功；一次并行读早于写而报缺失，随后读回成功 | 候选协议有效；Sonnet 已在上一轮相同模型对照中验证通过 |
| local-server-ornith | Ornith GGUF，现有 Chat Completions | 实际完成，文件字节一致 | 保留现有协议及 BaseURL |
| drex-decision | Drex GGUF，现有 Chat Completions | 实际完成，文件字节一致 | 保留现有协议及 BaseURL；不能仅按连接名字推断无工具能力 |
| openrouter | inception/mercury-decide:free，现有 Chat Completions | 400：decisions model，要求 /api/alpha/decisions | 该模型不是此聊天执行链的模型，不能仅改为 Responses/Anthropic 解决 |
| DeepSeek | deepseek-flash，现有 Chat Completions | 实际读写与校验成功 | 保留现有协议及 BaseURL |

共 9 次本轮 CLI 实验。Claude Sonnet 的既有验证见[执行器一致性原则与范围](2026-10-15-task-execution-reliability-unified-plan.md#1-根本判断)。gpt-image-2 属于图像生成能力，本轮没有执行付费图像生成或将它当作文件操作聊天模型测试；不能因 GPT 文本模型需求而对整个多模态连接盲目切换。

这些结果来自隔离 Executor 环境，不是已更改生产配置后的 Gateway 验收。进程零退出码并不等于成功；表中按实际文件结果和工具错误区分。

## 已交付的具体修改

Provider 协议现在由用户显式选择：`openai-compatible`（Chat Completions）、`openai-responses`（Responses）或 `anthropic`（Messages）。Pi/Planner 运行时会生成对应 adapter；Codex/Anthropic 绑定在配置校验阶段拒绝。新增和编辑 Provider 的协议会随统一 revision 激活保存，模型目录探测使用对应协议。

GPT / Code CLI 已按用户要求切至 Responses；未修改 OpenRouter Mercury 或本地 Drex 决策配置，也未运行新的付费 GPT 任务。

历史诊断中的 Claude Provider `custom-model-4` 候选修改：

| 字段 | 当前值 | 已验证候选值 |
| --- | --- | --- |
| protocol | openai-compatible | anthropic |
| baseUrl | https://code-cli.cn/v1/ | https://code-cli.cn |
| Pi api（由程序生成） | openai-completions | anthropic-messages |

候选保留模型和凭据。问题是当前程序的 runtime renderer 只生成 openai-compatible Provider，private binding resolver 还会拒绝 anthropic。直接激活上述配置可能造成无效运行配置，不能绕过 revision/激活机制手改生成文件。

该候选未激活；本次只接通能力并按用户明确要求切换 GPT Provider。其余通过的连接保持现状；订阅、服务过载和专用模型接入各自记录，不能用统一协议修改掩盖。

后续若用户授权程序修复，应先完成实现和隔离验证，再经正式配置激活流程应用候选并测试真实任务；不得把本轮候选测试冒充生产修复。

## 证据

- [候选配置差异](../../.tmp/provider-audit-20261013/provider-change-candidate.json)：不含密钥，尚未应用。
- [9 次测试汇总](../../.tmp/provider-audit-20261013/audit-results.json)：结果、错误、临时工作区与实际文件核查。
- 同目录 `*-events.jsonl` / `*-result.json`：原始 Pi 事件及每次结果。
- 诊断脚本 `check.mjs`：凭据仅在进程环境中使用，临时 models.json 使用环境变量引用；落盘记录经实际凭据字符串检查，无密钥泄漏。

本轮未更改决策模型选择、订阅、远程服务或原远程桌面任务。
