# Incomplete response resume and command result repair

- Plan date: 2026-09-24
- Status: Implemented and live-validated
- Closing commit: Not created (existing mixed working tree retained)

## Confirmed cause

The GLM attempt ended with `Stream ended without finish_reason`. The immutable
receipt classified it as `unknown_executor_failure`, so two explicit Resume
requests produced `block_work` without a new attempt. The blocked result body
was a short process fragment, not a report. Gateway preferred that re-delivered
partial body over the control command explanation.

## Changes

1. Give the exact incomplete-response error a distinct `model_response_incomplete`
   code while retaining conservative unknown-kind automatic recovery policy.
2. During explicit Resume, normalize the latest receipt summary and submit the
   recognized failure as `retry`. Keep receipts immutable and Kernel authoritative.
   Preserve material, contract, orphan and external-effect blockers. Kernel rejects
   retry when the recovery capabilities cannot prove external-effect safety.
3. Keep the control command result authoritative; deliver safe partial output with
   uncertified metadata. Select the newest result and failure, matching repository
   ordering, and explicitly label partial output as not task completion.
4. Say that Resume is authorized and awaiting dispatch; actual process start belongs
   to the execution trace. Keep revision-pinned routing identity unchanged.
5. Verify recovery, result delivery, slot cleanup and queue promotion through existing
   owning seams, then install and resume the real research task through Gateway.
6. Keep OpenAI-compatible GLM/Z.ai models on Pi's endpoint-based compatibility
   detection. Do not emit an explicit `supportsReasoningEffort: true` override,
   which causes GLM requests to receive the wrong OpenAI `reasoning_effort` field
   instead of the provider's `thinking` field.

## Validation

- Seven new regression assertions failed before the first implementation.
- Initial focused run: 135 tests passed.
- User journey and slot/recovery/context run: 21 tests passed, including a complete
  incomplete-response -> explicit Resume -> certified report flow and immutable
  original receipt assertion.
- TypeScript check passed.
- Newest-receipt regression reproduced selecting the oldest partial output; fixed.
- Live preflight: research-only capability, no pending external effects, no uncertain
  applications, no active leases, no running tasks. The blocked task still owns its
  Conversation slot by contract; no manual database status changes are allowed.
- GLM configuration regression: generated `models.json` now preserves endpoint
  auto-detection for `open.bigmodel.cn` and `api.z.ai`; the fallback materializer
  follows the same rule.
- Focused configuration and fallback tests: 12 passed.
- Vendored Pi GLM/tool compatibility tests: 41 passed.
- Native macOS installation completed and activated release
  `1.2.0-preview.5-build-3723377-1790269310147`.
- Live Server is ready on that release; generated GLM config contains
  `api: openai-completions` and no `supportsReasoningEffort` override.
- Live GLM request returned `stop` with `OK`, `thinking: { type: "enabled" }`,
  no `reasoning_effort`, and valid usage counters.
- Recovery, Gateway result delivery, billing and blocked-task journey tests:
  105 passed; `npm run lint` passed.
- The historical research Task remains `blocked` and historical incomplete bills
  remain `pending_reconciliation`; neither was mutated during preflight.
- A live explicit Resume was then submitted through the current Gateway for the
  original Task. Kernel authorization succeeded, the Task and its research
  Subtask entered `running`, and the new GLM Executor process remained active
  through the validation window without producing a new incomplete-response
  receipt. No certified report had been emitted when the bounded observation
  window ended; the Task was left running for normal completion and was not
  force-completed or manually changed.
