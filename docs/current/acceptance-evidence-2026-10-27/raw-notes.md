# Raw acceptance notes (server pid 80292, local HEAD 36233dd1)

## Env
- Server started from repo dist (local latest), port 8788, install root ~/.metawork
- Login admin@163.com OK (official account, internal_perpetual entitlement)
- New workspace /Users/yuanjubian/metawork-acceptance-20261027

## A1 PASS
- "在当前 Workspace 创建 hello.py，内容输出 Hello World"
- First needed an extra clarification ("是否可以直接覆盖原文件") even though dir was empty.
- Then: 1 subtask completed, hello.py = print("Hello World"), no 接受并交付 button.

## A2 FAIL (blocking)
- "把 Hello World 改成 See you later" -> Kernel request_clarification
- planner_proposal_submissions.result_json: outcome=clarification_requested
  reason: "unqualified context refs: interaction:turn_6d7ee4a1:user"
- Root cause evidence: interactions table has 0 rows with id LIKE 'turn_%';
  planner referenced a *turn id* where an *interaction id* (int_*) is required ->
  readAuthorizedInteraction throws interaction_source_missing -> ref ineligible.
- UI text: 计划引用了当前任务不可用的上下文（历史会话）。请重新说明需求…

## A3a FAIL (same-conversation follow-up)
- "运行这个程序并告诉我输出" -> Planner asked "原文件需要保留。请指定要创建的新文件路径后再继续。"
  plus "当前请求未通过执行校验，请调整请求后重试。"

## A3b PASS (fresh conversation, explicit instruction)
- "运行当前 Workspace 里的 hello.py，并告诉我 stdout、stderr 和退出码"
- Needed extra "请确认是否可以直接覆盖目标工作区中的原文件" clarification (spurious for read-only run)
- Result: stdout Hello World (12 bytes), stderr empty, exit code 0, no file change. PASS

## A4 PASS (test failure auto-repair)
- prompt: calculator.py + test_calculator.py with assert add(1,2)==4, run pytest, fix until green
- Executor created venv (/tmp/calcvenv), first pytest FAILED:
  "E assert 3 == 4 ... 1 failed in 0.01s"
- then fixed to assert add(1, 2) == 3, second pytest "1 passed in 0.00s" - all inside ONE attempt
- final files verified: test_calculator.py has == 3
- source evidence: attempts/a_attempt_disp_57d7762b/home/.pi/agent/sessions/2026-10-27T13-38-43-504Z_*.jsonl

## A5 PASS (service start failure auto-repair)
- prompt: server.js on 9345, start with `node servr.js` (wrong), self-repair from stderr
- session evidence: Cannot find module '/Users/.../servr.js' (MODULE_NOT_FOUND) then fixed to node server.js
- managed_local_services: service_id=node-health-service-9345 state=healthy, health_message=健康检查通过
- live curl http://127.0.0.1:9345/health -> 200 {"status":"ok"}
- UI showed stale line "Task #task_... 尚未完成：系统正在执行任务。。" while task=succeeded (see defects)

## A17 FAIL (run contract serviceIntent missing in production)
- same real service task: executor_attempt_runtime.progress_json.diagnostics.runContract
  has taskId/generationId/subtaskId/attemptId/workUnitId/workspaceId/accessMode/targetPathCount/
  acceptanceCount/fileOutputs/configurationRevision/bindingFingerprint — NO serviceIntent
- repo-wide: select count(*) from executor_attempt_runtime where progress_json like '%serviceIntent%' = 0
- service exists: managed_local_services.specification_revision = service_revision_ed64d15df1565486214b7d744d27d0da
- code: src/execution/execution-runtime.ts:497 projectRunContract({context, executionBinding}) — no serviceIntent

## A6 PARTIAL/PASS (health 503 must not be success)
- prompt: server503.js on 9346 with /health always 503
- service row: server503 state=unhealthy health_message="服务已启动，健康检查返回 503" (503 retained)
- after ~3.5 min silent wait the task failed: "service_health_timeout，serviceId=server503，state=failed，进程已退出，健康检查=503"
- surfaced 重试未完成部分 / 取消任务 buttons; 3 service_repair continuation attempts existed in kernel_dispatch_items
- A9 relevance: no explicit "已尝试 N 轮" count shown to user

## A2 root cause (detailed)
- kernel_decisions: action=request_clarification reason="unqualified context refs: interaction:turn_6d7ee4a1:user"
- interaction id namespace mismatch: interactions table has int_* ids; 0 rows with id like 'turn_%'
- decision_json carries only a text question (no structured issues array) -> A13 partially fails
