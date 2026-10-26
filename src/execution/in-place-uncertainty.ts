/**
 * Thrown when an in-place Attempt may have written the user's Workspace but no
 * receipt was persisted. Recovery must observe and fence instead of replaying
 * the Executor, because the user's bytes may already be the ones they see.
 */
export class InPlaceWriteUncertaintyError extends Error {
  readonly code = 'in_place_write_uncertain';
  readonly stage = 'post_write';
  readonly retryable = false;
  readonly attemptStarted = true;
  readonly externalSideEffect = true;
  readonly userAction =
    '就地执行已写入工作区但未产生完成凭证。请检查改动后选择继续或取消，系统不会自动重放。';

  constructor(
    message: string,
    readonly facts: {
      attemptId: string;
      changedPaths: number;
      capturedPaths: number;
      changeRecordId: string | null;
    },
  ) {
    super(message);
    this.name = 'InPlaceWriteUncertaintyError';
  }
}
