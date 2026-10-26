# MetaWork 斜杠指令

这是当前唯一的斜杠指令参考。`/help` 和自动补全都从同一份命令树生成；其他文档只描述运行机制，不再维护第二份指令清单。

## Desktop / Web 指令联想

在会话输入框输入 `/`，即可看到常用指令；继续输入会筛选子命令和参数。任务候选来自当前会话，高级命令在输入对应前缀后显示，或通过 `/help advanced` 查看。

- `↑` / `↓` 选择，`Tab` / `Enter` 补入，鼠标点击也可补入；选择候选不会执行命令。
- 补入后继续填写参数；查询结束且没有候选时按 `Enter` 发送，`Ctrl/Cmd+Enter` 可直接发送。
- `Esc` 收起，`Shift+Enter` 换行；输入法确认候选词不会发送消息。
- 断线或查询失败时不补入旧结果，不影响保留草稿；重新编辑可再次查询。

Desktop 与 Web 共用输入组件，通过 Gateway 的 `complete_command` 只读查询读取服务端命令树，不维护客户端副本。新建、历史和运行中的会话使用相同目录；补全不启动 Planner，不创建任务，也不进入会话历史。输入超过 8 KiB 或包含换行时不触发联想。

## 日常指令

这些指令面向普通使用。任务状态统一按“等待中、执行中、需要处理、已结束”展示。

```text
/task list [all|waiting|executing|needs-action|finished]
/task show <taskId>
/task pause <taskId>
/task resume <taskId> [材料路径...]
/task cancel <taskId>
/task accept-result <taskId>
/task retry-result <taskId>
/task retry <failedTaskId>

/help
/help <命令路径>
/exit
```

长期记忆通过设置页的“记忆”开关与抽取模型选择管理；`/memory`、`/learning`
和 profile preference 指令已退役，解析器会把它们当作未知指令，不写入任何记忆存储。

`/task resume` 是继续未终结任务的日常入口；需要补材料时直接把路径放在同一条指令后面。旧的 `/task unblock` 仍可识别，但只作为兼容入口，不再出现在常用帮助中。`/task block` 同样只保留兼容和诊断用途。

结果出现“接受结果”或“重新执行”时，分别使用 `/task accept-result` 或 `/task retry-result`。接受只进行发布与交付检查，不会重跑 Executor；重新执行会保留历史结果并创建新的 Attempt。

确定交付或服务启动失败后，使用 `/task retry <failedTaskId>` 创建关联任务，只补未完成的交付/服务，原任务保留失败结论。重复提交不会创建多个后续任务。若没有可核实的已集成成果，需重新规划，不能直接重放未知工作。

## 高级指令

输入 `/help advanced` 查看本组完整列表。它们用于诊断、恢复、索引、服务和治理：

```text
/task dashboard
/task block <taskId> <原因...>
/task unblock <taskId> [材料路径...]
/task clear [all|parked|blocked]
/task subtask-cancel <taskId> <subtaskId...>
/task accept-partial <taskId>
/task search <query...>
/task recovery <taskId>
/task recover <taskId> <recoveryItemId> <assume-applied|retry>
/task attach <taskId> <resource...>
/task history <taskId>
/task index rebuild
/task index search <query...>

/executor list
/executor show <name>
/executor refresh [name|all]
/executor feedback <taskId>

/profile executor <name>

/service start <taskId>
/service status <serviceId>
/service logs <serviceId>
/service stop <serviceId>
/service restart <serviceId>
/config
```

## 其他入口的指令

客户端导航不是 MetaWork 任务指令，单独处理：

- Native TUI：`/workspace <absolute-path>`、`/conversations`、`/conversation [id|new]`、`/latest`、`/cancel`。
- Feishu 导航：`/workspace <path>`、`/conversations`、`/conversation <id>`、`/history [limit]`、`/follow`、`/unfollow <routeId>`、`/following`、`/tasks`。
- TUI 的权限和停止控制：`/approve`、`/deny`、`/stop-turn`、`/stop-task`。它们是 Gateway 控制协议，不进入任务命令树。
- Pi 编辑器自身的 `/settings`、`/session`、`/new`、`/resume`、`/quit` 等只在 Pi 编辑器层生效，不是 MetaWork 指令。

同名命令只在所属入口解释一次。任务命令不会改变 Workspace 导航，客户端导航也不会绕过 Gateway、Kernel 或任务控制链。
