import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCompletionProtocol, COMPLETION_MARKER_V1 } from '../../src/execution/completion-protocol.js';
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

function response(envelope: Record<string, unknown>, body = 'Completed cleanly.'): string {
  return `${body}\n\n${COMPLETION_MARKER_V1}\n${JSON.stringify(envelope)}`;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    subtaskId: 'task_a',
    acceptanceEvidence: [{ key: 'done', evidence: ['verified result'] }],
    artifacts: [],
    handoffs: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Completion Protocol v1', () => {
  it('strips a strict terminal envelope', () => {
    const result = validateCompletionProtocol({ rawResponse: response(envelope()), subtask: subtask(), outgoingHandoffs: [], targetPaths: [] });
    expect(result).toMatchObject({ ok: true, body: 'Completed cleanly.', warnings: [] });
  });

  it('rejects duplicate markers, trailing text, and mismatched acceptance', () => {
    expect(validateCompletionProtocol({
      rawResponse: `${response(envelope())}\n${COMPLETION_MARKER_V1}`,
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    }).ok).toBe(false);
    expect(validateCompletionProtocol({
      rawResponse: `${response(envelope())}\ntrailing`,
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    }).ok).toBe(false);
    const mismatch = validateCompletionProtocol({
      rawResponse: response(envelope({ acceptanceEvidence: [{ key: 'extra', evidence: ['x'] }] })),
      subtask: subtask(), outgoingHandoffs: [], targetPaths: [],
    });
    expect(mismatch.ok ? [] : mismatch.violations.map(item => item.code)).toContain('completion_acceptance_mismatch');
  });

  it('requires exact outgoing handoff items and types', () => {
    const contract = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const valid = envelope({ handoffs: [{ toSubtaskId: 'task_b', items: [{ key: 'summary', type: 'text', value: 'A result' }] }] });
    expect(validateCompletionProtocol({ rawResponse: response(valid), subtask: subtask(), outgoingHandoffs: contract, targetPaths: [] }).ok).toBe(true);
    const invalid = envelope({ handoffs: [{ toSubtaskId: 'task_b', items: [{ key: 'summary', type: 'artifact', paths: [] }] }] });
    expect(validateCompletionProtocol({ rawResponse: response(invalid), subtask: subtask(), outgoingHandoffs: contract, targetPaths: [] }).ok).toBe(false);
  });

  it('enforces aggregate incoming budgets at a downstream node', () => {
    const contract = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const result = validateCompletionProtocol({
      rawResponse: response(envelope({
        handoffs: [{ toSubtaskId: 'task_b', items: [{ key: 'summary', type: 'text', value: 'x'.repeat(4_000) }] }],
      })),
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
      rawResponse: response(envelope()), subtask: subtask({ expectedOutput: 'patch' }), outgoingHandoffs: [], targetPaths: [],
    });
    expect(patchResult.ok ? [] : patchResult.violations.map(item => item.code)).toContain('completion_patch_evidence_missing');
    const artifactResult = validateCompletionProtocol({
      rawResponse: response(envelope()), subtask: subtask({ expectedOutput: 'artifact' }), outgoingHandoffs: [], targetPaths: [],
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
      rawResponse: response(envelope({ artifacts: [artifact] })), subtask: subtask(), outgoingHandoffs: [], targetPaths: [target],
    });
    expect(valid).toMatchObject({ ok: true, normalizedArtifacts: [artifact] });

    for (const invalidPath of [escaped, link]) {
      const invalid = validateCompletionProtocol({
        rawResponse: response(envelope({ artifacts: [invalidPath] })), subtask: subtask(), outgoingHandoffs: [], targetPaths: [target],
      });
      expect(invalid.ok ? [] : invalid.violations.map(item => item.code)).toContain('completion_artifact_invalid');
    }
  });

  it('rejects handoff artifacts that are not registered in top-level artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
    roots.push(root);
    const artifact = join(root, 'report.md');
    writeFileSync(artifact, 'report');
    const result = validateCompletionProtocol({
      rawResponse: response(envelope({
        handoffs: [{ toSubtaskId: 'task_b', items: [{ key: 'report', type: 'artifact', paths: [artifact] }] }],
      })),
      subtask: subtask(),
      outgoingHandoffs: [{
        toSubtaskId: 'task_b', requiredItems: [{ key: 'report', type: 'artifact', description: 'report' }],
      }],
      targetPaths: [root],
    });
    expect(result.ok ? [] : result.violations.map(item => item.code)).toContain('completion_artifact_invalid');
  });
});
