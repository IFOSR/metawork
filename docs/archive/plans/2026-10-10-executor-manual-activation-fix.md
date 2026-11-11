# 能力手册长度导致激活失败修复

- 日期：2026-10-10
- 状态：本地修复与验证完成，待更新客户端试用
- 完成日期：2026-10-10
- 提交：按用户要求，不提交 Git 或推送 GitHub

## 原因与交付

本机 `buildExecutorCapabilityManual` 对生成的 Markdown 设有 24000 字节上限。
手册合并职责、模型优势/局限、任务偏好等信息，且部分模型信息在不同章节复用。
正常通过配置校验的中文资料也能在编译阶段抛出用户看到的
`Executor capability manual exceeds 24000-byte limit: pi-research`。
这与官方 AI 请求、模型输出 token 预算无关。

删除该字节长度阻断，以及后续 `get_planning_context` 的 60000 字节总量阻断。
完整保留手册及尾部限制说明，沿用配置版本、能力证据、排序与执行授权契约。
同步 ADR-0015、CONTEXT 和当前技术总览。

## 验证

先通过合法中文模型资料重现同样的 `pi-research` 编译错误，
并重现第二个 Planner 手册总量错误。修复后：

- 真实配置服务完成校验→编译→探测→激活→手册落盘，生成内容超过 24000 字节。
  检查所有模型优势、尾部限制和路由说明仍完整，落盘结果与 Planner 投影一致。
- 超过 60000 字节的多手册上下文完整返回，排序、版本及 `truncated: false` 保留。
- 配置服务、运行时渲染、能力手册、Planner MCP 共 64 项测试通过。
- `npm run lint`、`npm run build`、`git diff --check` 通过。
- 构建日志：`.tmp/executor-manual-activation-build.log`。

用户正式安装、官方 Server 均未修改。用户随后要求重新打包，本修复已纳入
`0.1.9-internal-local20261010b` 试用 DMG，见[打包及联合验收记录](2026-10-10-report-manual-trial-dmg.md)。
安装新包并完成更新后生效，旧客户端单独重启不会加载工作区构建。
Closing commit：无，遵循用户暂不提交的要求。
