import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { SessionPresentationService } from '../session/session-presentation-service.js';
import type {
  AccountControlExecutionServices,
  ControlExecutionRuntimeCallbacks,
  SessionControlRuntimeCallbacks,
  TaskExecutionApplicationCallbacks,
} from './account-control-execution-services.js';

export interface ConversationExecutionBinding {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly persistenceService: SessionPersistenceService;
  readonly presentation: SessionPresentationService;
  readonly kernelExecutionCallbacks: ControlExecutionRuntimeCallbacks;
  readonly taskExecutionCallbacks: TaskExecutionApplicationCallbacks;
  readonly sessionControlCallbacks: SessionControlRuntimeCallbacks;
}

export interface AccountConversationExecutionBinder {
  runWith<T>(input: ConversationExecutionBinding, operation: () => Promise<T>): Promise<T>;
  currentSessionId(): string | null;
  routedPersistenceService(): SessionPersistenceService;
  routedControlCallbacks(): ControlExecutionRuntimeCallbacks;
  routedTaskCallbacks(): TaskExecutionApplicationCallbacks;
  routedSessionControlCallbacks(): SessionControlRuntimeCallbacks;
  bindSharedServices(services: AccountControlExecutionServices): void;
}

export function createAccountConversationExecutionBinder(): AccountConversationExecutionBinder {
  const storage = new AsyncLocalStorage<ConversationExecutionBinding>();
  let shared: AccountControlExecutionServices | null = null;
  const current = (): ConversationExecutionBinding => {
    const binding = storage.getStore();
    if (!binding) throw new Error('account execution is not bound to a Conversation');
    return binding;
  };
  const routedPersistence = {
    recordInteraction: input => current().persistenceService.recordInteraction({
      ...input,
      sessionId: current().sessionId,
    }),
  } as SessionPersistenceService;
  const routedControlCallbacks = routeCallbacks(
    storage,
    binding => binding.kernelExecutionCallbacks,
  );
  const routedTaskCallbacks = routeCallbacks(
    storage,
    binding => binding.taskExecutionCallbacks,
  );
  const routedSessionControlCallbacks = routeCallbacks(
    storage,
    binding => binding.sessionControlCallbacks,
  );

  return {
    bindSharedServices(services) {
      if (shared) throw new Error('account execution services are already bound');
      shared = services;
    },
    runWith: (input, operation) => storage.run(input, operation),
    currentSessionId: () => storage.getStore()?.sessionId ?? null,
    routedPersistenceService: () => routedPersistence,
    routedControlCallbacks: () => routedControlCallbacks,
    routedTaskCallbacks: () => routedTaskCallbacks,
    routedSessionControlCallbacks: () => routedSessionControlCallbacks,
  };
}

/** Callbacks a binding may legitimately omit; calling them is a no-op. */
const OPTIONAL_CALLBACKS = new Set<string | symbol>(['onWaitingForUser']);

function routeCallbacks<T extends object>(
  storage: AsyncLocalStorage<ConversationExecutionBinding>,
  select: (binding: ConversationExecutionBinding) => T,
): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const binding = storage.getStore();
        if (!binding) throw new Error('account execution callback has no Conversation context');
        const callbacks = select(binding);
        const value = Reflect.get(callbacks, property);
        if (typeof value !== 'function') {
          if (OPTIONAL_CALLBACKS.has(property)) return undefined;
          throw new Error(`Conversation execution callback is unavailable: ${String(property)}`);
        }
        return Reflect.apply(value, callbacks, args);
      };
    },
  });
}
