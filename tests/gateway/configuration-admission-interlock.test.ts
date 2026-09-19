/**
 * 配置事务与新工作接收的对称互斥（ADR-0033 2026-09-19 修正案）。
 *
 * - 配置事务先开始：新业务命令被拒绝并返回 configuration_updating，
 *   查询/历史/权限决议/取消不受影响。
 * - 工作先被接收：reservation 从接收连续持有到执行完成，期间配置写入被拒绝。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRuntime } from '../../src/account/account-runtime.js';
import type { AccountRuntimeHandle } from '../../src/account/account-runtime-ports.js';
import type { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { GatewayCommand } from '../../src/gateway/client-protocol.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import type { ConversationSession } from '../../src/session/conversation-session.js';
import type { Task, TaskStatus } from '../../src/core/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('configuration admission interlock', () => {
  it('rejects new business work while a configuration transaction is active', async () => {
    const fixture = createFixture();
    await fixture.accountRuntime.initialize();
    let release!: () => void;
    const activation = fixture.accountRuntime.withConfigurationActivation(
      async () => new Promise<void>(resolve => { release = resolve; }),
    );
    await waitFor(() => fixture.accountRuntime.getConfigurationActivationFacts
      && fixture.activating());

    const receipt = await fixture.submit('conv_1', 'req_1', 'idem_1', userMessage('hello'));
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'configuration_updating' });
    await expect(receipt.completion).resolves.toEqual({
      status: 'failed',
      reason: 'configuration_updating',
    });
    expect(fixture.executions).toEqual([]);

    release();
    await activation;
    const retry = await fixture.submit('conv_1', 'req_2', 'idem_2', userMessage('hello'));
    expect(retry.status).toBe('accepted');
    await waitFor(() => fixture.executions.length === 1);
  });

  it('keeps cancellation, permission resolution and history available during activation', async () => {
    const fixture = createFixture();
    await fixture.accountRuntime.initialize();
    let release!: () => void;
    const activation = fixture.accountRuntime.withConfigurationActivation(
      async () => new Promise<void>(resolve => { release = resolve; }),
    );
    await waitFor(() => fixture.activating());

    const cancel = await fixture.submit('conv_1', 'req_c', 'idem_c', {
      kind: 'cancel_turn',
      turnId: 'turn_x',
    });
    expect(cancel.status).toBe('accepted');
    const permission = await fixture.submit('conv_1', 'req_p', 'idem_p', {
      kind: 'permission_resolution',
      requestId: 'perm_1',
      resolution: 'approve',
    });
    expect(permission.status).toBe('accepted');

    release();
    await activation;
  });

  it('blocks configuration activation from admission until execution completes', async () => {
    const turn = deferred<void>();
    const fixture = createFixture(async (conversationId, command, session) => {
      fixture.executions.push(`${conversationId}:run`);
      await turn.promise;
      session.output.push('done');
    });
    await fixture.accountRuntime.initialize();

    const receipt = await fixture.submit('conv_1', 'req_1', 'idem_1', userMessage('slow'));
    expect(receipt.status).toBe('accepted');
    // 命令已接收但尚未开始执行：reservation 必须已经阻塞配置写入。
    await expect(fixture.accountRuntime.withConfigurationActivation(async () => undefined))
      .rejects.toThrow(/工作请求|Planner/);
    expect(fixture.accountRuntime.getConfigurationActivationStatus().blockingReasons
      .map(reason => reason.code)).toContain('work_request_pending');

    turn.resolve();
    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    await waitFor(() => fixture.accountRuntime.getConfigurationActivationStatus().activationAllowed);
    await expect(fixture.accountRuntime.withConfigurationActivation(async () => 'ok'))
      .resolves.toBe('ok');
  });

  it('releases the reservation when admission is rejected by the conversation', async () => {
    const fixture = createFixture();
    await fixture.accountRuntime.initialize();
    fixture.rejectNextSubmission = 'test_rejection';

    const receipt = await fixture.submit('conv_1', 'req_1', 'idem_1', userMessage('hello'));
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'test_rejection' });
    await waitFor(() => fixture.accountRuntime.getConfigurationActivationStatus().activationAllowed);
    expect(fixture.accountRuntime.getConfigurationActivationFacts().pendingWorkRequestCount)
      .toBe(0);
  });

  it('does not reserve work twice for duplicate submissions', async () => {
    const turn = deferred<void>();
    const fixture = createFixture(async (conversationId, command, session) => {
      fixture.executions.push(`${conversationId}:run`);
      await turn.promise;
      session.output.push('done');
    });
    await fixture.accountRuntime.initialize();

    const [first, duplicate] = await Promise.all([
      fixture.submit('conv_1', 'req_1', 'idem_1', userMessage('hello')),
      fixture.submit('conv_1', 'req_2', 'idem_1', userMessage('hello')),
    ]);
    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    expect(fixture.accountRuntime.getConfigurationActivationFacts().pendingWorkRequestCount)
      .toBe(1);

    turn.resolve();
    await first.completion;
    await waitFor(() => fixture.accountRuntime.getConfigurationActivationStatus().activationAllowed);
  });
});

function userMessage(text: string): GatewayCommand {
  return { kind: 'user_message', text, attachments: [] };
}

function makeMockCoordinator(): AccountKernelCoordinator {
  return {
    submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
    recover: async () => ({
      decisions: [],
      quiescent: true,
      pendingRecovery: 0,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
    }),
  };
}

function createFixture(
  execute?: (
    conversationId: string,
    command: GatewayCommand,
    session: FakeConversationSession,
  ) => Promise<unknown>,
) {
  const root = mkdtempSync(join(tmpdir(), 'metawork-admission-interlock-'));
  roots.push(root);
  const journal = new FileEventJournal(root);
  const subscriptions = new GatewaySubscriptions();
  const conversations = new ConversationRegistry();
  const tasks: Task[] = [];
  const accountRuntime = new AccountRuntime({
    accountId: 'local-default',
    kernelCoordinator: makeMockCoordinator(),
    kernelServices: {
      kernelDecisionRepo: { listByTask: () => [] },
    } as never,
    repositories: {
      conversationTaskSchedulerRepo: { listSlots: () => [] },
      workGraphRevisionRepo: { findActive: () => null },
    } as never,
    workspaceServices: {
      attemptExecutionRepository: { listActive: () => [] },
    } as never,
    runtimeExecutionServices: {
      dispatchItemRepo: { listBlocking: () => [] },
      resourceLeaseService: { findActive: () => [] },
      publicationRepo: { hasAnyBlockingResidue: () => false },
    } as never,
    taskServices: {
      taskRuntimeService: {
        listTasks: () => tasks,
        listTasksByStatus: (status: TaskStatus) => tasks.filter(task => task.status === status),
        findTask: (taskId: string) => tasks.find(task => task.id === taskId) ?? null,
      },
    } as never,
    recoverDurableStartup: async () => undefined,
  });
  const fixture = {
    executions: [] as string[],
    rejectNextSubmission: null as string | null,
    accountRuntime,
    activating(): boolean {
      return accountRuntime.getConfigurationActivationStatus().status === 'activating';
    },
    registry: {
      getOrActivate: async () => accountRuntime as unknown as AccountRuntimeHandle,
      getIfLoaded: () => accountRuntime as unknown as AccountRuntimeHandle,
    } as unknown as RuntimeRegistry,
    runtime: null as unknown as ConversationGatewayRuntime,
    submit(
      conversationId: string,
      requestId: string,
      idempotencyKey: string,
      command: GatewayCommand,
    ): ReturnType<ConversationGatewayRuntime['submit']> {
      return fixture.runtime.submit(conversationId, requestId, idempotencyKey, command);
    },
  };
  const operation = execute ?? (async (
    conversationId: string,
    _command: GatewayCommand,
    session: FakeConversationSession,
  ) => {
    fixture.executions.push(`${conversationId}:run`);
    session.output.push('done');
  });
  fixture.runtime = new ConversationGatewayRuntime({
    accountId: 'local-default',
    registry: fixture.registry,
    conversations,
    conversationFactory: conversationId => {
      const session = new FakeConversationSession(
        conversationId,
        command => operation(conversationId, command, session),
        () => fixture.rejectNextSubmission,
      );
      return session as unknown as ConversationSession;
    },
    journal,
    subscriptions,
    createId: prefix => `${prefix}_${Math.random().toString(36).slice(2)}`,
  });
  return fixture;
}

class FakeConversationSession {
  readonly output: string[] = [];
  private readonly mailbox: ConversationInputMailbox;

  constructor(
    readonly conversationId: string,
    private readonly execute: (command: GatewayCommand) => Promise<unknown>,
    private readonly rejection: () => string | null,
  ) {
    this.mailbox = new ConversationInputMailbox({ execute: async () => undefined });
  }

  bindMailboxExecutor(execute: (command: MailboxCommand) => Promise<void>): void {
    this.mailbox.bindExecutor(execute);
  }

  submitCommand(command: MailboxCommand): MailboxReceipt {
    const reason = this.rejection();
    if (reason) {
      return {
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        status: 'rejected',
        reason,
      };
    }
    return this.mailbox.submit(command);
  }

  async executeGatewayCommand(command: GatewayCommand): Promise<unknown> {
    return this.execute(command);
  }

  getOutput(): string[] {
    return [...this.output];
  }

  getResultDeliveries(): [] {
    return [];
  }

  hasBackgroundWork(): boolean {
    return false;
  }

  async getWorkspace(): Promise<null> {
    return null;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  subscribeInteractionTrace(): () => void {
    return () => undefined;
  }

  attachClient(): void {}

  detachClient(): void {}
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
