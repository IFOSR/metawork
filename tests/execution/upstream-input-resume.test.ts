import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';

const binding = { agentClassRef: 'custom-reviewer', harnessRef: 'pi-cli', providerRef: 'provider',
  modelRef: 'model', permissionProfileRef: 'standard-agent', configurationRevision: 'revision' };
const fingerprint = authorizedExecutorBindingFingerprint(binding);

function fixture() {
  const source = { id: 'source', taskId: 'task', generationId: 'gen', graphRevision: 1,
    status: 'done', dependencies: [], executorBindings: [binding], requiredCapabilities: [] };
  const target = { ...source, id: 'target', status: 'awaiting_decision',
    dependencies: [{ fromSubtaskId: 'source', requiredItems: [{ key: 'draft', type: 'text' }] }] };
  const receipt = { taskId: 'task', subtaskId: 'target', generationId: 'gen', graphRevision: 1,
    attemptId: 'failed-attempt', authorizedBinding: binding, configurationRevision: 'revision',
    bindingFingerprint: fingerprint, attemptKind: 'primary', terminalState: 'executor_failed',
    errorCode: 'missing_upstream_input', failure: { kind: 'task_failed', code: 'missing_upstream_input' },
    verification: { violations: [] }, completedAt: '2026-10-17T00:00:00Z' };
  const reference = { referenceId: 'ref', taskId: 'task', generationId: 'gen',
    sourceSubtaskId: 'source', targetSubtaskId: 'target', resultId: 'result' };
  const deps = {
    taskRuntimeService: { findTask: () => ({ id: 'task', status: 'blocked', dependencies: [
      { type: 'manual', status: 'waiting', description: 'startup recovery found running work without authorized dispatch' },
    ] }) },
    workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1, configurationRevision: 'revision' }), countAutomaticReplans: () => 0 },
    subtaskRepo: { listActiveByTask: () => [source, target] },
    subtaskHandoffRepo: { listByTask: () => [{ fromSubtaskId: 'source', toSubtaskId: 'target',
      resultReference: reference, items: [{ type: 'result_reference', referenceId: 'ref' }] }] },
    resultObjectRepo: { findObject: () => ({ resultId: 'result' }), findReference: () => reference },
    workspaceRepository: { findByIdentity: () => ({ status: 'active', rootUri: pathToFileURL(process.cwd()).href }) },
    attemptReceiptRepo: { listByTask: () => [receipt] },
    dispatchItemRepo: { listByTask: () => [] },
    publicationRepo: { unfinishedDeliveries: () => [], hasBlockingResidue: () => false },
    cancellationCoordinator: { completionBlockedReasons: () => [] },
    generationReplanRepo: { findLatestOpen: () => null },
    kernelWorkflowStore: { listRecoveryItems: () => [] },
    attemptRunner: { supportsEvidenceTools: vi.fn(() => true) },
    callbacks: {}, maxConcurrentAttempts: 4,
  };
  const snapshot = () => new KernelExecutionRuntime(deps as never)['buildDispatchSnapshot']('task', 'ready', {
    executorStatuses: [], correctionSupportedAgentClasses: [], nativeContinuationAgentClasses: ['custom-reviewer'],
  });
  return { deps, snapshot, receipt, target, source, reference };
}

describe('restored upstream input resume facts', () => {
  it('keeps the completed source and revalidates the custom binding before offering packet recovery', () => {
    const f = fixture(); const snapshot = f.snapshot();
    expect(snapshot).toMatchObject({ type: 'dispatch', upstreamInputResume: { rejectedReplanRequestId: null },
      resumeRecoveryCandidates: [{ subtaskId: 'target', sourceAttemptId: 'failed-attempt',
        reason: 'upstream_input_restored', recoveryMode: 'recovery_packet' }] });
    expect(f.source.status).toBe('done');
    expect(f.deps.attemptRunner.supportsEvidenceTools).toHaveBeenCalledWith(binding);
  });

  it.each(['driver', 'handoff', 'result', 'identity', 'workspace', 'other-failure', 'stale-receipt', 'live-attempt'])(
    'does not propose upstream recovery with %s unavailable or invalid', problem => {
      const f = fixture();
      if (problem === 'driver') f.deps.attemptRunner.supportsEvidenceTools.mockReturnValue(false);
      if (problem === 'handoff') f.deps.subtaskHandoffRepo.listByTask = () => [];
      if (problem === 'result') f.deps.resultObjectRepo.findObject = () => null as never;
      if (problem === 'identity') f.reference.targetSubtaskId = 'other';
      if (problem === 'workspace') f.deps.workspaceRepository.findByIdentity = () => null as never;
      if (problem === 'other-failure') f.receipt.errorCode = 'other';
      if (problem === 'stale-receipt') f.receipt.configurationRevision = 'other';
      if (problem === 'live-attempt') f.deps.dispatchItemRepo.listByTask = () => [{ subtaskId: 'target', status: 'running' }] as never;
      expect(f.snapshot()).toMatchObject({ resumeRecoveryCandidates: undefined, upstreamInputResume: undefined });
    },
  );

  it('does not supersede genuine manual or uncertain-application blockers', () => {
    const f = fixture();
    f.deps.taskRuntimeService.findTask = () => ({ id: 'task', status: 'blocked', dependencies: [
      { type: 'manual', status: 'waiting', description: 'user approval required' },
    ] });
    expect(f.snapshot()).toMatchObject({ upstreamInputResume: undefined });
    const g = fixture();
    g.deps.kernelWorkflowStore.listRecoveryItems = () => [{ status: 'uncertain' }] as never;
    expect(g.snapshot()).toMatchObject({ upstreamInputResume: undefined });
  });
});
