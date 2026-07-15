# Feishu task scope output anchor debt

- Status: collected for later fix
- Date: 2026-07-15
- Scope: record the regression risk, root cause, code locations, and missing tests only. Do not fix implementation in this document.

## Summary

TUI-OUTPUT-002 removed or hid several user-visible MetaClaw task lifecycle lines. One removed line was also being used as a Feishu reply scoping anchor:

```text
任务 #task_x 已创建：{title}
```

Feishu currently infers the task that a reply belongs to by parsing `SessionSnapshot.output` strings. For the common "create new task and execute immediately" path, removing the task-created line can leave Feishu without a target task id. When that happens, Feishu falls back to unscoped output lines, which can mix unrelated task output or lose the intended task boundary in preemption, resume, queue, or multi-task scenarios.

## Confirmed Behavior

`extractFeishuReplyTargetTaskId` currently recognizes only these anchors:

```text
任务 #task_x 已创建：...
→ 关联到任务 #task_x
→ 命中上次任务指针 #task_x
→ 任务 #task_x 已进入待执行队列
```

For a newly created task that is immediately admitted for execution:

- `KernelDecisionApplier.createAndPrepareTask` creates the task and calls `prepareTaskExecution(task.id, ...)`;
- it no longer appends `任务 #task_x 已创建：...`;
- `SessionTaskExecutionApplicationService.submitScheduledTask` only appends `→ 任务 #task_x 已进入待执行队列` when `result.action === 'queued'`;
- reference-binding anchors only appear in referenced-task or last-task-pointer scenarios;
- therefore the immediate execution path can produce no recognized Feishu target-task anchor.

Executor final-result blocks do contain the task id:

```text
【Executor: codex-cli｜最终结果｜#task_x / #subtask_y】
...
```

However, `extractFeishuReplyTargetTaskId` does not currently parse this block. `filterFeishuOutputLinesForTask` can filter executor final-result blocks by task id, but only after the caller already knows the target task id.

## Code Locations

| Location | Current role and issue |
| --- | --- |
| `src/integrations/feishu-app.ts`: `handleFeishuMessageEvent` | Uses `extractFeishuReplyTargetTaskId` before calling `filterFeishuOutputLinesForTask` for streaming and final replies. If extraction returns `null`, the reply uses unscoped output lines. |
| `src/integrations/feishu-app.ts`: `waitForFeishuReplyOutputLines` | Maintains `targetTaskId` from output parsing during subscribed session updates. Without an anchor, terminal settling also finishes with unscoped lines. |
| `src/integrations/feishu-app.ts`: `extractFeishuReplyTargetTaskId` | Still depends on the removed task-created line plus queued/reference fallbacks. It does not parse the new executor final-result block. |
| `src/integrations/feishu-app.ts`: `filterFeishuOutputLinesForTask` | Can recognize executor final-result blocks and task-output lines, but only when a target task id was already supplied. |
| `src/session/kernel-decision-applier.ts`: `createAndPrepareTask` | Creates a new task and immediately calls `prepareTaskExecution`; no longer emits a stable task-created anchor. |
| `src/session/session-task-execution-application-service.ts`: `submitScheduledTask` | Emits the queued anchor only for `result.action === 'queued'`; immediate execution does not emit it. |
| `src/session/session-presentation-service.ts`: `formatExecutorFinalResult` | Produces final-result blocks that include `#task_id`, but this id is not yet used by Feishu target extraction. |
| `tests/integrations/feishu-app.test.ts` | Covers formatting of already scoped or simplified output, but does not cover the full Feishu scoping chain after the task-created anchor is absent. |

## Impact

- Final Feishu replies can include output from the wrong task when another task is preempted, resumed, auto-continued, or emits output in the same session window.
- Streaming Feishu progress can be sent before the target task is known, so unrelated progress lines may leak into the current chat reply.
- The simplified TUI output protocol appears correct in TUI, but the same shared `SessionSnapshot.output` still acts as an implicit API for Feishu.
- Existing tests can pass because `formatFeishuReply` extracts executor final-result text from raw lines directly, bypassing the task-id extraction and filtering path.

## Test Gap

The current regression tests exercise helpers such as:

- `formatFeishuProgressReply`
- `formatFeishuStreamingProgressReplies`
- `formatFeishuReply`

Those tests prove that final-result blocks can be rendered cleanly. They do not prove that `handleFeishuMessageEvent` or `waitForFeishuReplyOutputLines` can locate the submitted task when `任务 #task_x 已创建：...` is missing.

Missing coverage should include:

- a subscribed Feishu session where a new task executes immediately without a task-created line;
- a final-result block for the submitted task plus unrelated task output in the same output window;
- verification that the final Feishu reply includes only the submitted task result;
- verification that streaming progress does not emit unrelated task progress before the final-result block appears;
- a queued-path control case proving the old queued anchor still scopes correctly;
- a preemption or resume case proving task output does not cross between urgent and resumed tasks.

## Non-binding Fix Directions

Possible follow-up fixes:

1. Minimal: update `extractFeishuReplyTargetTaskId` to parse `【Executor: ...｜最终结果｜#task_id / #subtask_id】`.
2. Safer: emit a stable task-created event that Feishu can consume while keeping it hidden from TUI user-visible projection.
3. Better long-term: stop using `SessionSnapshot.output` string parsing for Feishu task scoping. Use structured task/session events instead.

The long-term direction is preferable because the current bug comes from treating user-visible text as both UI projection and integration protocol.

## Future Acceptance Criteria

- Feishu can determine the submitted task id for "new task + immediate execution" without relying on a visible `任务 #id 已创建：...` line.
- Feishu final replies are scoped to the submitted task when multiple task ids appear in the same session output window.
- Feishu streaming progress does not send unrelated task progress while the submitted task is still running.
- Existing queued, referenced-task, last-task-pointer, preemption, and resume behavior remains scoped.
- TUI can keep simplified output without reintroducing internal task lifecycle diagnostics solely for Feishu parsing.
- Tests cover the real `handleFeishuMessageEvent` / `waitForFeishuReplyOutputLines` path, not only standalone formatting helpers.
