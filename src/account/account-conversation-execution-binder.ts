import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { SessionPresentationService } from '../session/session-presentation-service.js';
import type {
  AccountKernelExecutionServices,
  KernelExecutionRuntimeCallbacks,
  SessionKernelRuntimeCallbacks,
  TaskExecutionApplicationCallbacks,
} from './account-kernel-execution-services.js';

export interface ConversationExecutionBinding {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly persistenceService: SessionPersistenceService;
  readonly presentation: SessionPresentationService;
  readonly kernelExecutionCallbacks: KernelExecutionRuntimeCallbacks;
  readonly taskExecutionCallbacks: TaskExecutionApplicationCallbacks;
  readonly sessionKernelCallbacks: SessionKernelRuntimeCallbacks;
}

export interface AccountConversationExecutionBinder {
  bind(input: ConversationExecutionBinding): AccountKernelExecutionServices;
  runWith<T>(input: ConversationExecutionBinding, operation: () => Promise<T>): Promise<T>;
  currentSessionId(): string | null;
  routedPersistenceService(): SessionPersistenceService;
  routedKernelCallbacks(): KernelExecutionRuntimeCallbacks;
  routedTaskCallbacks(): TaskExecutionApplicationCallbacks;
  routedSessionKernelCallbacks(): SessionKernelRuntimeCallbacks;
  bindSharedServices(services: AccountKernelExecutionServices): void;
}

export function createAccountConversationExecutionBinder(): AccountConversationExecutionBinder {
  const storage = new AsyncLocalStorage<ConversationExecutionBinding>();
  let shared: AccountKernelExecutionServices | null = null;
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
  const routedKernelCallbacks = routeCallbacks(
    storage,
    binding => binding.kernelExecutionCallbacks,
  );
  const routedTaskCallbacks = routeCallbacks(
    storage,
    binding => binding.taskExecutionCallbacks,
  );
  const routedSessionKernelCallbacks = routeCallbacks(
    storage,
    binding => binding.sessionKernelCallbacks,
  );

  return {
    bindSharedServices(services) {
      if (shared) throw new Error('account execution services are already bound');
      shared = services;
    },
    bind(input) {
      if (!shared) throw new Error('account execution services are unavailable');
      return {
        kernelExecutionRuntime: bindObject(storage, input, shared.kernelExecutionRuntime),
        taskExecutionApplicationService: bindObject(
          storage,
          input,
          shared.taskExecutionApplicationService,
        ),
        sessionKernelRuntime: {
          forInput(userInput?: string, conversationId?: string) {
            const runtime = shared!.sessionKernelRuntime.forInput(
              userInput,
              conversationId ?? input.conversationId ?? input.sessionId,
            );
            return {
              apply: decision => storage.run(input, () => runtime.apply(decision)),
            };
          },
        } as AccountKernelExecutionServices['sessionKernelRuntime'],
      };
    },
    runWith: (input, operation) => storage.run(input, operation),
    currentSessionId: () => storage.getStore()?.sessionId ?? null,
    routedPersistenceService: () => routedPersistence,
    routedKernelCallbacks: () => routedKernelCallbacks,
    routedTaskCallbacks: () => routedTaskCallbacks,
    routedSessionKernelCallbacks: () => routedSessionKernelCallbacks,
  };
}

function bindObject<T extends object>(
  storage: AsyncLocalStorage<ConversationExecutionBinding>,
  input: ConversationExecutionBinding,
  target: T,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => storage.run(
        input,
        () => Reflect.apply(value, object, args),
      );
    },
  });
}

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
          throw new Error(`Conversation execution callback is unavailable: ${String(property)}`);
        }
        return Reflect.apply(value, callbacks, args);
      };
    },
  });
}
