import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCompletionProtocol, COMPLETION_MARKER_V2 } from '../../src/execution/completion-protocol.js';
import type { Subtask } from '../../src/core/types.js';

const roots: string[] = [];

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  const now = new Date().toISOString();
  return {
    id: 'task_a', taskId: 'task', title: 'A', goal: 'Do A', status: 'running',
    dependencies: [], contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'summary',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low', result: '', artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function response(report: Record<string, unknown>, body = 'Completed cleanly.'): string {
  return `${body}\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify(report)}`;
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    evidence: ['verified result'],
    artifacts: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Completion Protocol v2', () => {
  it('materializes authoritative identities and contract keys from an identity-free Executor report', () => {
    const current = subtask({
      id: 'bound-subtask',
      acceptance: [
        { key: 'file_created', description: 'file exists', requiredEvidence: [] },
        { key: 'output_verified', description: 'output verified', requiredEvidence: [] },
      ],
    });
    const result = validateCompletionProtocol({
      rawResponse: response({
        evidence: ['hello.py 已创建', '运行 python3 后输出 Hello world'],
        artifacts: [],
      }),
      subtask: current,
      outgoingHandoffs: [{
        toSubtaskId: 'bound-downstream',
        requiredItems: [{ key: 'summary', type: 'text', description: 'execution summary' }],
      }],
      targetPaths: [],
    });

    expect(result).toMatchObject({
      ok: true,
      envelope: {
        schemaVersion: 2,
        status: 'completed',
        subtaskId: 'bound-subtask',
        acceptanceEvidence: [
          { key: 'file_created', evidence: ['hello.py 已创建', '运行 python3 后输出 Hello world'] },
          { key: 'output_verified', evidence: ['hello.py 已创建', '运行 python3 后输出 Hello world'] },
        ],
        handoffs: [{
          toSubtaskId: 'bound-downstream',
          items: [{ key: 'summary', type: 'text', value: 'hello.py 已创建\n运行 python3 后输出 Hello world' }],
        }],
      },
    });
  });

  it('strips a strict terminal report', () => {
    const result = validateCompletionProtocol({ rawResponse: response(report()), subtask: subtask(), outgoingHandoffs: [], targetPaths: [] });
    expect(result).toMatchObject({ ok: true, body: 'Completed cleanly.', warnings: [] });
  });

  it('rejects duplicate markers, trailing text, and the legacy identity-bearing envelope', () => {
    expect(validateCompletionProtocol({
      rawResponse: `${response(report())}\n${COMPLETION_MARKER_V2}`,
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    }).ok).toBe(false);
    expect(validateCompletionProtocol({
      rawResponse: `${response(report())}\ntrailing`,
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    }).ok).toBe(false);
    const legacy = validateCompletionProtocol({
      rawResponse: response({
        schemaVersion: 2,
        status: 'completed',
        subtaskId: 'task_a',
        acceptanceEvidence: [{ key: 'done', evidence: ['verified result'] }],
        artifacts: [],
        handoffs: [],
      }),
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    });
    expect(legacy.ok ? [] : legacy.violations.map(item => item.code)).toContain('completion_malformed');
  });

  it('rejects model-supplied internal identities or acceptance keys', () => {
    const result = validateCompletionProtocol({
      rawResponse: response(report({
        workUnitId: 'work-unit',
        subtaskId: 'subtask',
        attemptId: 'attempt',
        acceptanceEvidence: [{ key: 'done', evidence: ['forged'] }],
      })),
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    });
    expect(result.ok ? [] : result.violations.map(item => item.code)).toContain('completion_malformed');
  });

  it('accepts only the controlled Executor failure taxonomy', () => {
    const failed = validateCompletionProtocol({
      rawResponse: response({
        failure: { kind: 'capability_mismatch', code: 'missing_browser', summary: 'This class cannot browse.' },
      }, 'Unable to complete this Subtask.'),
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    });
    expect(failed).toMatchObject({
      ok: true,
      envelope: { status: 'failed', failure: { kind: 'capability_mismatch' } },
    });
    expect(validateCompletionProtocol({
      rawResponse: response({
        failure: { kind: 'network', code: 'network', summary: 'network down' },
      }),
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    }).ok).toBe(false);
  });

  it('materializes exact outgoing handoff items and types from the authorized contract', () => {
    const contract = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const result = validateCompletionProtocol({
      rawResponse: response(report({ evidence: ['A result'] })),
      subtask: subtask(), outgoingHandoffs: contract, targetPaths: [],
    });
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        handoffs: [{
          toSubtaskId: 'task_b',
          items: [{ key: 'summary', type: 'text', value: 'A result' }],
        }],
      },
    });
  });

  it('enforces aggregate incoming budgets at a downstream node', () => {
    const contract = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const result = validateCompletionProtocol({
      rawResponse: response(report({ evidence: [
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(997),
      ] })),
      subtask: subtask(),
      outgoingHandoffs: contract,
      targetPaths: [],
      incomingUsageByTarget: new Map([['task_b', { textCharacters: 21_000, artifactPaths: 0 }]]),
    });
    expect(result.ok ? [] : result.violations).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded',
      path: 'handoffs.0.toSubtaskId',
    }));
  });

  it('requires patch test evidence and artifact outputs', () => {
    const patchResult = validateCompletionProtocol({
      rawResponse: response(report()), subtask: subtask({ expectedOutput: 'patch' }), outgoingHandoffs: [], targetPaths: [],
    });
    expect(patchResult.ok ? [] : patchResult.violations.map(item => item.code)).toContain('completion_patch_evidence_missing');
    const artifactResult = validateCompletionProtocol({
      rawResponse: response(report()), subtask: subtask({ expectedOutput: 'artifact' }), outgoingHandoffs: [], targetPaths: [],
    });
    expect(artifactResult.ok ? [] : artifactResult.violations.map(item => item.code)).toContain('completion_artifact_required');
  });

  it('accepts existing in-target artifacts and rejects outside or symlink-escaped paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
    roots.push(root);
    const target = join(root, 'target');
    const outside = join(root, 'outside');
    mkdirSync(target);
    mkdirSync(outside);
    const artifact = join(target, 'report.md');
    const escaped = join(outside, 'secret.md');
    const link = join(target, 'escaped-link.md');
    writeFileSync(artifact, 'report');
    writeFileSync(escaped, 'secret');
    symlinkSync(escaped, link);

    const valid = validateCompletionProtocol({
      rawResponse: response(report({ artifacts: [artifact] })), subtask: subtask(), outgoingHandoffs: [], targetPaths: [target],
    });
    expect(valid).toMatchObject({ ok: true, normalizedArtifacts: [artifact] });

    for (const invalidPath of [escaped, link]) {
      const invalid = validateCompletionProtocol({
        rawResponse: response(report({ artifacts: [invalidPath] })), subtask: subtask(), outgoingHandoffs: [], targetPaths: [target],
      });
      expect(invalid.ok ? [] : invalid.violations.map(item => item.code)).toContain('completion_artifact_invalid');
    }
  });

  it('materializes artifact handoffs from the Runtime-validated top-level artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
    roots.push(root);
    const artifact = join(root, 'report.md');
    writeFileSync(artifact, 'report');
    const result = validateCompletionProtocol({
      rawResponse: response(report({ artifacts: [artifact] })),
      subtask: subtask(),
      outgoingHandoffs: [{
        toSubtaskId: 'task_b', requiredItems: [{ key: 'report', type: 'artifact', description: 'report' }],
      }],
      targetPaths: [root],
    });
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        artifacts: [artifact],
        handoffs: [{
          toSubtaskId: 'task_b',
          items: [{ key: 'report', type: 'artifact', paths: [artifact] }],
        }],
      },
    });
  });
});
