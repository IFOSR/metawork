import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCompletionProtocol, COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import type { Subtask } from '../../src/core/types.js';
import type { WorkspaceDelta, WorkspaceDeltaEntry } from '../../src/execution/workspace-change-tracker.js';

const roots: string[] = [];

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  const now = new Date().toISOString();
  return {
    id: 'task_a', taskId: 'task', title: 'A', goal: 'Do A', status: 'running',
    dependencies: [], contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low', result: '', artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function response(report: Record<string, unknown>, body = 'Completed cleanly.'): string {
  return `${body}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify(report)}`;
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { evidence: ['verified result'], noChangeReason: null, ...overrides };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
  roots.push(value);
  return value;
}

function delta(changed: WorkspaceDeltaEntry[] = [], overrides: Partial<WorkspaceDelta> = {}): WorkspaceDelta {
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: false,
    finalTruncated: false,
    ...overrides,
  };
}

function validate(input: {
  rawResponse?: string;
  current?: Subtask;
  workspaceRoot?: string;
  workspaceDelta?: unknown;
  outgoingHandoffs?: Parameters<typeof validateCompletionProtocol>[0]['outgoingHandoffs'];
  incomingUsageByTarget?: Parameters<typeof validateCompletionProtocol>[0]['incomingUsageByTarget'];
}) {
  return validateCompletionProtocol({
    rawResponse: input.rawResponse ?? response(report()),
    subtask: input.current ?? subtask(),
    outgoingHandoffs: input.outgoingHandoffs ?? [],
    workspaceRoot: input.workspaceRoot ?? root(),
    workspaceDelta: Object.hasOwn(input, 'workspaceDelta') ? input.workspaceDelta : delta(),
    incomingUsageByTarget: input.incomingUsageByTarget,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Completion Protocol result-first assessment', () => {
  it('injects authoritative identities, acceptance keys, and handoff identities', () => {
    const current = subtask({
      id: 'bound-subtask',
      acceptance: [
        { key: 'file_created', description: 'file exists', requiredEvidence: [] },
        { key: 'output_verified', description: 'output verified', requiredEvidence: [] },
      ],
    });
    const evidence = ['hello.py 已创建', '运行 python3 后输出 Hello world'];
    const result = validate({
      rawResponse: response(report({ evidence })),
      current,
      outgoingHandoffs: [{
        toSubtaskId: 'bound-downstream',
        requiredItems: [{ key: 'summary', type: 'text', description: 'execution summary' }],
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      envelope: {
        schemaVersion: 4,
        status: 'completed',
        subtaskId: 'bound-subtask',
        acceptanceEvidence: [
          { key: 'file_created', evidence },
          { key: 'output_verified', evidence },
        ],
        handoffs: [{
          toSubtaskId: 'bound-downstream',
          items: [{ key: 'summary', type: 'text', value: evidence.join('\n') }],
        }],
      },
    });
  });

  it('delivers the body when the terminal metadata is malformed or contains forged fields', () => {
    expect(validate({}).ok).toBe(true);
    expect(validate({ rawResponse: `${response(report())}\n${COMPLETION_MARKER_V4}` }).ok).toBe(true);
    expect(validate({ rawResponse: `${response(report())}\ntrailing` }).ok).toBe(true);
    for (const payload of [
      { ...report(), schemaVersion: 2, status: 'completed', subtaskId: 'task_a' },
      { ...report(), workUnitId: 'forged', acceptanceEvidence: [{ key: 'done', evidence: ['forged'] }] },
      { ...report(), artifacts: ['/workspace/forged'] },
    ]) {
      const result = validate({ rawResponse: response(payload) });
      expect(result.ok).toBe(true);
      expect(result.assessment.certification.status).toBe('uncertified');
    }
  });

  it('accepts only the controlled Executor failure taxonomy without requiring a delta', () => {
    const failed = validateCompletionProtocol({
      rawResponse: response({
        failure: { kind: 'capability_mismatch', code: 'missing_browser', summary: 'This class cannot browse.' },
      }, 'Unable to complete this Subtask.'),
      subtask: subtask(), outgoingHandoffs: [], workspaceRoot: '/missing', workspaceDelta: null,
    });
    expect(failed).toMatchObject({
      ok: true,
      envelope: { schemaVersion: 4, status: 'failed', failure: { kind: 'capability_mismatch' } },
    });
    expect(validate({ rawResponse: response({
      failure: { kind: 'network', code: 'network', summary: 'network down' },
    }) }).ok).toBe(true);
  });

  it('does not turn aggregate handoff size into a completion rejection rule', () => {
    const outgoingHandoffs = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const result = validate({
      rawResponse: response(report({ evidence: [
        'x'.repeat(1_000), 'x'.repeat(1_000), 'x'.repeat(1_000), 'x'.repeat(997),
      ] })),
      outgoingHandoffs,
      incomingUsageByTarget: new Map([['task_b', { textCharacters: 21_000, artifactPaths: 0 }]]),
    });
    expect(result).toMatchObject({
      ok: true,
      assessment: {
        certification: { status: 'certified', violations: [] },
      },
    });
  });

  it.each([
    ['created', { path: 'new.md', beforeHash: null, afterHash: 'new' }],
    ['modified', { path: 'existing.md', beforeHash: 'old', afterHash: 'new' }],
    ['deleted', { path: 'removed.md', beforeHash: 'old', afterHash: null }],
  ] as const)('rejects report delivery when a file is %s', (_label, change) => {
    const result = validate({ workspaceDelta: delta([change]) });
    expect(result.ok ? [] : result.violations.map(item => item.code))
      .toContain('completion_report_workspace_changed');
  });

  it('requires report noChangeReason to be null', () => {
    const result = validate({ rawResponse: response(report({ noChangeReason: 'nothing needed' })) });
    expect(result.assessment.certification.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
  });

  it('derives edit artifacts from created and modified files while retaining deletion only in the delta', () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'nested'));
    writeFileSync(join(workspaceRoot, 'created.md'), 'created');
    writeFileSync(join(workspaceRoot, 'nested', 'modified.md'), 'modified');
    const workspaceDelta = delta([
      { path: 'created.md', beforeHash: null, afterHash: 'created-hash' },
      { path: 'nested/modified.md', beforeHash: 'old-hash', afterHash: 'new-hash' },
      { path: 'deleted.md', beforeHash: 'old-hash', afterHash: null },
    ]);
    const result = validate({
      current: subtask({ deliveryKind: 'edit' }), workspaceRoot, workspaceDelta,
      outgoingHandoffs: [{
        toSubtaskId: 'task_b',
        requiredItems: [{ key: 'files', type: 'artifact', description: 'changed files' }],
      }],
    });
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    expect(result).toMatchObject({
      ok: true,
      normalizedArtifacts: [
        join(realWorkspaceRoot, 'created.md'),
        join(realWorkspaceRoot, 'nested', 'modified.md'),
      ],
      envelope: {
        handoffs: [{
          toSubtaskId: 'task_b',
          items: [{
            key: 'files', type: 'artifact',
            paths: [
              join(realWorkspaceRoot, 'created.md'),
              join(realWorkspaceRoot, 'nested', 'modified.md'),
            ],
          }],
        }],
      },
    });
  });

  it('allows a zero-delta edit only with a non-empty no-change reason', () => {
    const current = subtask({ deliveryKind: 'edit' });
    const rejected = validate({ current });
    expect(rejected.assessment.certification.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
    expect(validate({
      current,
      rawResponse: response(report({ noChangeReason: 'The requested state was already present.' })),
    }).ok).toBe(true);
  });

  it('rejects a no-change reason when an edit changed files', () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'changed.md'), 'changed');
    const result = validate({
      current: subtask({ deliveryKind: 'edit' }),
      workspaceRoot,
      workspaceDelta: delta([{ path: 'changed.md', beforeHash: null, afterHash: 'hash' }]),
      rawResponse: response(report({ noChangeReason: 'not applicable' })),
    });
    expect(result.assessment.certification.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
  });

  it('fails closed for missing, malformed, or truncated workspace deltas', () => {
    for (const workspaceDelta of [null, {}, delta([], { baselineTruncated: true }), delta([], { finalTruncated: true })]) {
      const result = validate({ workspaceDelta });
      expect(result.assessment.certification.violations.map(item => item.code))
        .toContain('completion_workspace_delta_uncertain');
    }
  });

  it('certifies a safe report when evidence exceeds former count and length limits', () => {
    const result = validate({
      rawResponse: response(report({
        evidence: ['one', 'two', 'three', 'four', 'five', 'x'.repeat(8_000)],
      })),
    });

    expect(result).toMatchObject({
      ok: true,
      body: 'Completed cleanly.',
      assessment: {
        certification: { status: 'certified', violations: [] },
      },
    });
  });

  it('delivers a safe body when the completion marker is missing', () => {
    const result = validate({
      rawResponse: 'Completed without the internal completion trailer.',
    });

    expect(result).toMatchObject({
      ok: true,
      body: 'Completed without the internal completion trailer.',
    });
  });

  it('delivers a safe report body when the metadata trailer is invalid', () => {
    const result = validate({
      rawResponse: `Completed with invalid metadata.\n\n${COMPLETION_MARKER_V4}\n{"evidence": [}`,
    });

    expect(result).toMatchObject({
      ok: true,
      body: 'Completed with invalid metadata.',
    });
  });

  it('does not suppress a safe report body when workspace facts are unavailable', () => {
    const result = validate({ workspaceDelta: null });

    expect(result).toMatchObject({
      ok: true,
      body: 'Completed cleanly.',
    });
  });
});
