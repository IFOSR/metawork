/**
 * Execution limits that are product behaviour, not user configuration.
 *
 * These live in Core so Configuration and Execution can share one number
 * without either owning the other's module (ADR-0020).
 */

/**
 * Attempts a single Task may run at the same time.
 *
 * Independent Subtasks — including shared-read research roots — run side by
 * side, so this is a fan-out budget rather than a sequence. It is deliberately
 * not a setting: only per-Workspace Conversation concurrency is user-facing,
 * and there is no account-wide Attempt ceiling.
 */
export const ATTEMPTS_PER_TASK_BUDGET = 10;
