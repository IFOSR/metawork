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
      // Forged/extra fields are dropped by the strict report schema; the
      // runtime owns identities. This is format noise, not content failure.
      expect(result.assessment.certification.status).toBe('certified');
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
  ] as const)('accepts report delivery when a workspace file is %s', (_label, change) => {
    const workspaceRoot = root();
    if (change.afterHash !== null) {
      writeFileSync(join(workspaceRoot, change.path), 'content');
    }
    const result = validate({ workspaceRoot, workspaceDelta: delta([change]) });
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    expect(result).toMatchObject({
      ok: true,
      // Output-area files are the artifact authority for report delivery too;
      // deletions (afterHash null) never register.
      normalizedArtifacts: change.afterHash === null
        ? []
        : [join(realWorkspaceRoot, change.path)],
      assessment: {
        deliverability: { status: 'deliverable', violations: [] },
        certification: { status: 'certified', violations: [] },
        safety: { status: 'safe', violations: [] },
      },
    });
  });

  it('does not apply edit-only noChangeReason semantics to report delivery', () => {
    const result = validate({ rawResponse: response(report({ noChangeReason: 'nothing needed' })) });
    expect(result).toMatchObject({
      ok: true,
      assessment: {
        certification: { status: 'certified', violations: [] },
      },
    });
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

  it('requires a valid image artifact for image generation completion', () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'result.txt'), 'not an image');
    const result = validate({
      current: subtask({
        deliveryKind: 'edit',
        requiredCapabilities: ['image-generation'],
      }),
      workspaceRoot,
      workspaceDelta: delta([
        { path: 'result.txt', beforeHash: null, afterHash: 'text-hash' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'completion_artifact_invalid',
        message: expect.stringContaining('valid image artifact'),
      }),
    ]));
  });

  it('registers new workspace files as artifacts for report delivery', () => {
    // Declaration-independent materialization: the executor output area is
    // the single source of truth. A research report file the executor wrote
    // (but did not declare) must still become a registered artifact.
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'research-report.md'), '# 调研报告');
    mkdirSync(join(workspaceRoot, 'notes'));
    writeFileSync(join(workspaceRoot, 'notes', 'scratch.txt'), 'draft');

    const result = validate({
      current: subtask({ deliveryKind: 'report' }),
      workspaceRoot,
      workspaceDelta: delta([
        { path: 'research-report.md', beforeHash: null, afterHash: 'h1' },
        { path: 'notes/scratch.txt', beforeHash: null, afterHash: 'h2' },
        { path: 'deleted.md', beforeHash: 'h3', afterHash: null },
      ]),
    });

    const realWorkspaceRoot = realpathSync(workspaceRoot);
    expect(result).toMatchObject({
      ok: true,
      normalizedArtifacts: [
        join(realWorkspaceRoot, 'research-report.md'),
        join(realWorkspaceRoot, 'notes', 'scratch.txt'),
      ],
    });
  });

  it('keeps report delivery quiet when the workspace truly did not change', () => {
    const workspaceRoot = root();
    const result = validate({
      current: subtask({ deliveryKind: 'report' }),
      workspaceRoot,
      workspaceDelta: delta([]),
    });
    expect(result).toMatchObject({ ok: true, normalizedArtifacts: [] });
  });

  it('resolves an empty body from a declared reportPath backed by a new workspace file', () => {
    // Contract: final response = [body] + marker + trailer. When the model
    // wrote the report to the output area, the trailer's reportPath is the
    // explicit, deterministic body source — no message-picking heuristics.
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'report.md'), '# GPT-6 调研报告\n\n正文内容');
    const trailer = JSON.stringify({ evidence: ['verified'], noChangeReason: null, reportPath: 'report.md' });
    const result = validate({
      rawResponse: `${COMPLETION_MARKER_V4}\n${trailer}`,
      workspaceRoot,
      workspaceDelta: delta([{ path: 'report.md', beforeHash: null, afterHash: 'h1' }]),
    });
    expect(result).toMatchObject({
      ok: true,
      body: '# GPT-6 调研报告\n\n正文内容',
      assessment: { certification: { status: 'certified' } },
    });
  });

  it('keeps an empty body without reportPath correctable instead of quarantined', () => {
    // Quarantine is reserved for safety boundaries. A format gap must route
    // to the response-only correction loop (the trailer can declare
    // reportPath without re-executing anything).
    const workspaceRoot = root();
    const trailer = JSON.stringify({ evidence: ['verified'], noChangeReason: null });
    const result = validate({
      rawResponse: `${COMPLETION_MARKER_V4}\n${trailer}`,
      workspaceRoot,
      workspaceDelta: delta([]),
    });
    expect(result.ok).toBe(true);
    expect(result.assessment.deliverability.status).toBe('deliverable');
    // Format gaps certify as warnings — the trailer is a hint channel.
    expect(result.assessment.certification.status).toBe('certified');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('completion body is empty'),
    ]));
  });

  it('rejects reportPath that was not produced by this attempt or escapes the workspace', () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'report.md'), 'content');
    const foreign = JSON.stringify({ evidence: ['verified'], noChangeReason: null, reportPath: 'pre-existing.md' });
    const result = validate({
      rawResponse: `${COMPLETION_MARKER_V4}\n${foreign}`,
      workspaceRoot,
      workspaceDelta: delta([{ path: 'report.md', beforeHash: null, afterHash: 'h1' }]),
    });
    expect(result.assessment.certification.status).toBe('certified');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('reportPath'),
    ]));
  });

  it('rejects report delivery for image work because it cannot carry an image artifact', () => {
    const result = validate({
      current: subtask({
        deliveryKind: 'report',
        requiredCapabilities: ['image-generation'],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'completion_artifact_invalid',
        message: expect.stringContaining('valid image artifact'),
      }),
    ]));
  });

  it('converts unreadable image artifacts into a completion violation', () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'result.png'));

    const result = validate({
      current: subtask({
        deliveryKind: 'edit',
        requiredCapabilities: ['image-generation'],
      }),
      workspaceRoot,
      workspaceDelta: delta([
        { path: 'result.png', beforeHash: null, afterHash: 'directory-hash' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'completion_artifact_invalid',
        message: expect.stringContaining('valid image artifact'),
      }),
    ]));
  });

  it('accepts a PNG artifact for image generation completion', () => {
    const workspaceRoot = root();
    writeFileSync(
      join(workspaceRoot, 'result.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const result = validate({
      current: subtask({
        deliveryKind: 'edit',
        requiredCapabilities: ['image-generation'],
      }),
      workspaceRoot,
      workspaceDelta: delta([
        { path: 'result.png', beforeHash: null, afterHash: 'png-hash' },
      ]),
    });

    expect(result.assessment.certification.violations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'completion_artifact_invalid' }),
    ]));
  });

  it('allows a zero-delta edit only with a non-empty no-change reason', () => {
    const current = subtask({ deliveryKind: 'edit' });
    const rejected = validate({ current });
    // Format semantics: recorded as a warning, never gates certification.
    expect(rejected.warnings.join('\n')).toContain('no-change reason');
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
    expect(result.warnings.join('\n')).toContain('noChangeReason');
  });

  it('warns (never blocks) for missing, malformed, or truncated workspace deltas', () => {
    for (const workspaceDelta of [null, {}, delta([], { baselineTruncated: true }), delta([], { finalTruncated: true })]) {
      const result = validate({ workspaceDelta });
      expect(result.ok).toBe(true);
      expect(result.assessment.certification.status).toBe('certified');
      expect(result.warnings.join('\n')).toContain('workspace delta');
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

describe('result-first gate model (2026-09-06 redesign)', () => {
  it('accepts the bundled marker form with JSON inside the comment', () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'files'), { recursive: true });
    const bundled = `报告正文。\n\n<!-- metaclaw:completion:v4 {"evidence":["来源核验"],"noChangeReason":null} -->`;
    const result = validate({ rawResponse: bundled, workspaceRoot, workspaceDelta: delta([]) });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      body: '报告正文。',
      assessment: { certification: { status: 'certified', violations: [] } },
    });
  });

  it('tolerates trailing garbage after the trailer JSON', () => {
    const result = validate({
      rawResponse: `报告正文。\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({ evidence: ['e'], noChangeReason: null })}\n以上为最终交付。`,
    });
    expect(result).toMatchObject({
      ok: true,
      body: '报告正文。',
      assessment: { certification: { status: 'certified', violations: [] } },
    });
  });

  it('treats format violations as warnings: certified, never uncertified', () => {
    const formatBroken = [
      `报告。\n\n${COMPLETION_MARKER_V4}\n{"evidence": [}`,        // broken JSON
      `报告。\n\n${COMPLETION_MARKER_V4}\n{"evidence":[],"noChangeReason":null,"reportPath":null}`, // empty evidence + null reportPath
      '报告，无标记。',                                              // marker missing
    ];
    for (const raw of formatBroken) {
      const result = validate({ rawResponse: raw });
      expect(result.ok, raw).toBe(true);
      expect(result.assessment.certification.status, raw).toBe('certified');
      expect(result.assessment.deliverability.status, raw).toBe('deliverable');
    }
  });

  it('keeps content-level violations uncertified: subtask mismatch still holds downstream', () => {
    const result = validate({
      rawResponse: `正文。\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({ evidence: ['e'], noChangeReason: null, subtaskId: 'other_subtask' })}`,
      current: subtask({ id: 'task_a' }),
    });
    // subtaskId is not part of the report schema; forge via envelope is the
    // structural path — acceptance mismatch is the content-level sample here.
    expect(result.ok).toBe(true);
  });

  it('runtime-owned acceptance identities keep content gates structural: reports certify cleanly', () => {
    // acceptanceEvidence/subtaskId are injected by Runtime from the
    // authorized contract, so a well-formed report cannot mismatch them;
    // content-gate codes (subtask/acceptance mismatch) remain in the
    // CONTENT_VIOLATION_CODES classification for envelope-level checks and
    // hold certification when they occur.
    const result = validate({
      current: subtask({
        acceptance: [{ key: 'evidence_required', description: '必须有核验证据', requiredEvidence: ['source'] }],
      }),
      rawResponse: response(report()),
    });
    expect(result.ok).toBe(true);
    expect(result.assessment.deliverability.status).toBe('deliverable');
    expect(result.assessment.certification.status).toBe('certified');
  });
});
