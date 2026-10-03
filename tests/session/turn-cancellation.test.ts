import { describe, expect, it, vi } from 'vitest';
import { deferred, sessionWith } from '../helpers/conversation-control.js';

describe('turn cancellation', () => {
  it('aborts the Planner run, marks the turn cancelled and drops the late proposal', async () => {
    const plannerRun = deferred<void>();
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    let lateProposal: { status: string; issues?: string[] } | null = null;
    const { session, trace, cancelPlannerTurn, submitKernel, cancelTask } = sessionWith({
      planning: {
        submit: async (_context: unknown, submitter: { submit: (plan: unknown) => Promise<unknown> }) => {
          await plannerRun.promise;
          // The Planner keeps working after the abort and submits late.
          lateProposal = await submitter.submit(workGraphPlan({ goal: 'late work' })) as never;
          return lateProposal as never;
        },
      } as never,
    });

    // Drives the real command path, which is what registers the turn identity
    // the Client cancels by.
    const planning = session.executeGatewayCommand(
      { kind: 'user_message', text: '帮我做一个很长的任务' },
      { interactionTurnId: 'turn_cancel_1' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true);
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_cancel_1' });

    expect(cancelPlannerTurn).toHaveBeenCalledWith('planner_cancel');
    expect(cancelTask).toHaveBeenCalledWith('task_x', '用户取消了当前轮');

    // The aborted Planner run submits afterwards; the latch must drop it.
    plannerRun.resolve();
    await planning;

    expect(lateProposal).toMatchObject({ status: 'rejected', issues: ['turn cancelled by user'] });
    expect(submitKernel).not.toHaveBeenCalled();
    const snapshot = trace.getSnapshot();
    expect(snapshot?.status).toBe('cancelled');
    expect(snapshot?.events.some(event => event.kind === 'turn_cancelled')).toBe(true);
  });

  it('refuses to cancel a turn that is not the active one', async () => {
    const plannerRun = deferred<never>();
    const { session, trace, cancelPlannerTurn } = sessionWith({
      planning: { submit: async () => plannerRun.promise } as never,
    });

    const planning = session.executeGatewayCommand(
      { kind: 'user_message', text: '任务' },
      { interactionTurnId: 'turn_cancel_2' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true);
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_other' });
    expect(cancelPlannerTurn).not.toHaveBeenCalled();

    plannerRun.reject(new Error('test cleanup'));
    await planning;
  });

  it('does not redirect a stale Turn cancellation to a background Task', async () => {
    const { session, cancelPlannerTurn, cancelTask } = sessionWith({
      planning: { submit: async () => ({ status: 'accepted' }) as never } as never,
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_gone' });

    expect(cancelPlannerTurn).not.toHaveBeenCalled();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('cancels only the explicit background Task after checking scope and generation', async () => {
    const { session, cancelTask } = sessionWith({ planning: null, queries: {
      findTask: id => ({ id, accountId: 'local-default', conversationId: id === 'foreign' ? 'conv_other' : 'conv_cancel' }) as never,
      findActiveWorkGraphRevision: () => ({ generationId: 'generation_current' }) as never,
    } });
    await expect(session.executeGatewayCommand({ kind: 'cancel_task', taskId: 'old_background', expectedExecutionGeneration: 'stale' }))
      .rejects.toThrow('task_generation_conflict');
    await expect(session.executeGatewayCommand({ kind: 'cancel_task', taskId: 'foreign', expectedExecutionGeneration: 'generation_current' }))
      .rejects.toThrow('task_scope_mismatch');
    expect(cancelTask).not.toHaveBeenCalled();
    await session.executeGatewayCommand({ kind: 'cancel_task', taskId: 'old_background', expectedExecutionGeneration: 'generation_current' });
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledWith('old_background', '用户请求停止此任务');
  });

  it('closes the active Turn as soon as Task cancellation is accepted', async () => {
    const plannerRun = deferred<void>();
    const { session, trace } = sessionWith({
      planning: {
        submit: async () => {
          await plannerRun.promise;
          return { status: 'accepted' } as never;
        },
      } as never,
    });

    const planning = session.executeGatewayCommand(
      { kind: 'user_message', text: '继续执行当前任务' },
      { interactionTurnId: 'turn_cancel_3' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true);
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_cancel_3' });

    expect(trace.getSnapshot()).toMatchObject({
      turnId: 'turn_cancel_3',
      status: 'cancelled',
      completedAt: expect.any(String),
    });

    plannerRun.resolve();
    await planning;
  });
});
