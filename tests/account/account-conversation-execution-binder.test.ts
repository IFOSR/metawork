import { describe, expect, it } from 'vitest';
import {
  createAccountConversationExecutionBinder,
  type ConversationExecutionBinding,
} from '../../src/account/account-conversation-execution-binder.js';

describe('AccountConversationExecutionBinder', () => {
  it('keeps concurrent Conversation callbacks and session identities isolated', async () => {
    const binder = createAccountConversationExecutionBinder();
    const observations: string[] = [];
    const shared = {
      kernelExecutionRuntime: {
        async observe(label: string, delayMs: number) {
          const before = binder.currentSessionId();
          await new Promise(resolve => setTimeout(resolve, delayMs));
          const after = binder.currentSessionId();
          binder.routedKernelCallbacks().appendOutput(`${label}:${before}:${after}`);
          binder.routedPersistenceService().recordInteraction({
            taskId: null,
            sessionId: 'shared-default',
            userInput: label,
            systemOutput: label,
            executorUsed: 'test',
          });
        },
      },
      taskExecutionApplicationService: {},
      sessionKernelRuntime: {
        forInput() {
          return { apply: async () => null };
        },
      },
    };
    binder.bindSharedServices(shared as never);

    const first = binder.bind(binding('conversation_a', observations));
    const second = binder.bind(binding('conversation_b', observations));
    await Promise.all([
      (first.kernelExecutionRuntime as never as {
        observe(label: string, delayMs: number): Promise<void>;
      }).observe('first', 20),
      (second.kernelExecutionRuntime as never as {
        observe(label: string, delayMs: number): Promise<void>;
      }).observe('second', 0),
    ]);

    expect(observations.sort()).toEqual([
      'output:conversation_a:first:conversation_a:conversation_a',
      'output:conversation_b:second:conversation_b:conversation_b',
      'persist:conversation_a:first',
      'persist:conversation_b:second',
    ]);
  });
});

function binding(
  sessionId: string,
  observations: string[],
): ConversationExecutionBinding {
  return {
    sessionId,
    persistenceService: {
      recordInteraction(input) {
        observations.push(`persist:${input.sessionId}:${input.userInput}`);
      },
    } as never,
    presentation: {} as never,
    kernelExecutionCallbacks: {
      appendOutput(line: string) {
        observations.push(`output:${sessionId}:${line}`);
      },
    } as never,
    taskExecutionCallbacks: {} as never,
    sessionKernelCallbacks: {} as never,
  };
}
