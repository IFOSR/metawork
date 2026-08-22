import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Subtask } from '../core/types.js';
import type { WorkGraphRequiredItem } from '../work-graph/index.js';
import { parseWorkspaceDelta, type WorkspaceDelta } from './workspace-change-tracker.js';

export const COMPLETION_MARKER_V4 = '<!-- metaclaw:completion:v4 -->';
export const COMPLETION_MARKER_V3 = COMPLETION_MARKER_V4;

const TextItemSchema = z.object({
  key: z.string(),
  type: z.literal('text'),
  value: z.string(),
}).strict();
const ArtifactItemSchema = z.object({
  key: z.string(),
  type: z.literal('artifact'),
  paths: z.array(z.string()),
}).strict();
const FailureSchema = z.object({
  kind: z.enum(['capability_mismatch', 'task_failed', 'quality_failed']),
  code: z.string().trim().min(1).max(96),
  summary: z.string().trim().min(1).max(320),
}).strict();
const CompletedEnvelopeSchema = z.object({
  schemaVersion: z.literal(4),
  status: z.literal('completed'),
  subtaskId: z.string(),
  acceptanceEvidence: z.array(z.object({
    key: z.string(),
    evidence: z.array(z.string()),
  }).strict()),
  artifacts: z.array(z.string()),
  handoffs: z.array(z.object({
    toSubtaskId: z.string(),
    items: z.array(z.discriminatedUnion('type', [TextItemSchema, ArtifactItemSchema])),
  }).strict()),
}).strict();
const FailedEnvelopeSchema = z.object({
  schemaVersion: z.literal(4),
  status: z.literal('failed'),
  subtaskId: z.string(),
  failure: FailureSchema,
}).strict();
const CompletionEnvelopeSchema = z.discriminatedUnion('status', [CompletedEnvelopeSchema, FailedEnvelopeSchema]);
const CompletedReportSchema = z.object({
  evidence: z.array(z.string().trim().min(1)).min(1),
  noChangeReason: z.string().trim().min(1).nullable(),
}).strict();
const FailedReportSchema = z.object({ failure: FailureSchema }).strict();
const CompletionReportSchema = z.union([CompletedReportSchema, FailedReportSchema]);

export type CompletionEnvelopeV4 = z.infer<typeof CompletionEnvelopeSchema>;
export type CompletedEnvelopeV4 = z.infer<typeof CompletedEnvelopeSchema>;
export type CompletionHandoffV4 = CompletedEnvelopeV4['handoffs'][number];
export type CompletionEnvelopeV3 = CompletionEnvelopeV4;
export type CompletedEnvelopeV3 = CompletedEnvelopeV4;
export type CompletionHandoffV3 = CompletionHandoffV4;
type CompletionReport = z.infer<typeof CompletionReportSchema>;
type CompletedReport = z.infer<typeof CompletedReportSchema>;
type FailedReport = z.infer<typeof FailedReportSchema>;
type FailedEnvelopeV3 = z.infer<typeof FailedEnvelopeSchema>;

export type CompletionContractErrorCode =
  | 'completion_acceptance_mismatch'
  | 'completion_artifact_invalid'
  | 'completion_budget_exceeded'
  | 'completion_handoff_mismatch'
  | 'completion_malformed'
  | 'completion_no_change_reason_mismatch'
  | 'completion_report_workspace_changed'
  | 'completion_subtask_mismatch'
  | 'completion_workspace_delta_uncertain';

export interface CompletionContractViolation {
  code: CompletionContractErrorCode;
  path: string;
  message: string;
}

export interface CompletionAssessment {
  result: {
    kind: 'complete' | 'partial' | 'failure' | 'none';
  };
  deliverability: {
    status: 'deliverable' | 'quarantined';
    violations: CompletionContractViolation[];
  };
  certification: {
    status: 'certified' | 'uncertified';
    violations: CompletionContractViolation[];
  };
  safety: {
    status: 'safe' | 'safety_blocked';
    violations: CompletionContractViolation[];
  };
}

export type CompletionProtocolResult =
  | {
    ok: true;
    body: string;
    envelope: CompletionEnvelopeV3 | null;
    normalizedArtifacts: string[];
    warnings: string[];
    assessment: CompletionAssessment;
  }
  | {
    ok: false;
    body: string | null;
    envelope: CompletionEnvelopeV3 | null;
    violations: CompletionContractViolation[];
    assessment: CompletionAssessment;
  };

export interface OutgoingHandoffContract {
  toSubtaskId: string;
  requiredItems: WorkGraphRequiredItem[];
}

export interface IncomingHandoffUsage {
  textCharacters: number;
  artifactPaths: number;
}

type ParsedCompletionReportResult =
  | {
    ok: true;
    body: string;
    report: CompletionReport | null;
    violations: CompletionContractViolation[];
  }
  | Extract<CompletionProtocolResult, { ok: false }>;
type CompletionProtocolFailure = Extract<CompletionProtocolResult, { ok: false }>;

/** Parses, strips and deterministically assesses the v4 completion trailer. */
export function validateCompletionProtocol(input: {
  rawResponse: string;
  subtask: Subtask;
  outgoingHandoffs: OutgoingHandoffContract[];
  workspaceRoot: string;
  workspaceDelta: unknown;
  incomingUsageByTarget?: ReadonlyMap<string, IncomingHandoffUsage>;
}): CompletionProtocolResult {
  const parsed = parseCompletion(input.rawResponse);
  if (!parsed.ok) return parsed;

  const violations: CompletionContractViolation[] = [...parsed.violations];
  const { body } = parsed;
  const metadataViolations = [...parsed.violations];
  const safetyViolations: CompletionContractViolation[] = [];
  const certificationViolations: CompletionContractViolation[] = [...parsed.violations];
  const assessmentBase = {
    result: { kind: 'partial' as const },
    deliverability: { status: 'deliverable' as const, violations: [] },
    certification: { status: 'uncertified' as const, violations: certificationViolations },
    safety: { status: 'safe' as const, violations: safetyViolations },
  };
  if (!parsed.report) {
    return {
      ok: true,
      body,
      envelope: null,
      normalizedArtifacts: [],
      warnings: metadataViolations.map(formatViolation),
      assessment: assessmentBase,
    };
  }
  if ('failure' in parsed.report) {
    const envelope = materializeCompletionEnvelope(parsed.report, input.subtask, input.outgoingHandoffs, []);
    return {
      ok: true,
      body,
      envelope,
      normalizedArtifacts: [],
      warnings: [],
      assessment: {
        ...assessmentBase,
        result: { kind: 'failure' },
        certification: { status: 'certified', violations: [] },
      },
    };
  }
  const workspaceDelta = parseWorkspaceDelta(input.workspaceDelta);
  const normalizedArtifacts = workspaceDelta
    ? validateWorkspaceDelivery(
      input.subtask,
      parsed.report.noChangeReason,
      workspaceDelta,
      input.workspaceRoot,
      violations,
    )
    : [];
  if (!workspaceDelta) {
    const deltaViolation = contractViolation(
      'completion_workspace_delta_uncertain',
      'workspaceDelta',
      'workspace delta is missing or malformed',
    );
    violations.push(deltaViolation);
  }
  const envelope = materializeCompletionEnvelope(
    parsed.report,
    input.subtask,
    input.outgoingHandoffs,
    normalizedArtifacts,
  );
  if (envelope.subtaskId !== input.subtask.id) {
    violations.push(contractViolation('completion_subtask_mismatch', 'subtaskId', `expected ${input.subtask.id}, received ${envelope.subtaskId}`));
  }
  if (envelope.status !== 'completed') {
    return {
      ok: true,
      body,
      envelope,
      normalizedArtifacts,
      warnings: [],
      assessment: {
        ...assessmentBase,
        result: { kind: 'failure' },
        certification: { status: 'certified', violations: [] },
      },
    };
  }
  validateAcceptance(input.subtask, envelope, violations);
  validateHandoffs(input.outgoingHandoffs, envelope, violations);

  const sortedViolations = violations.sort(compareViolation);
  const safety = sortedViolations.filter(isSafetyViolation);
  const certification = sortedViolations.filter(item => !isSafetyViolation(item));
  if (safety.length > 0) {
    return {
      ok: false,
      body: null,
      envelope,
      violations: sortedViolations,
      assessment: {
        result: { kind: 'none' },
        deliverability: { status: 'quarantined', violations: safety },
        certification: { status: 'uncertified', violations: certification },
        safety: { status: 'safety_blocked', violations: safety },
      },
    };
  }
  return {
    ok: true,
    body,
    envelope,
    normalizedArtifacts,
    warnings: certification.map(formatViolation),
    assessment: {
      result: { kind: certification.length > 0 ? 'partial' : 'complete' },
      deliverability: { status: 'deliverable', violations: [] },
      certification: {
        status: certification.length > 0 ? 'uncertified' : 'certified',
        violations: certification,
      },
      safety: { status: 'safe', violations: [] },
    },
  };
}

function parseCompletion(rawResponse: string): ParsedCompletionReportResult {
  const marker = COMPLETION_MARKER_V4;
  const markerMatches = [...rawResponse.matchAll(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const markerIndex = markerMatches.length > 0 ? markerMatches[0]!.index! : -1;
  const body = (markerIndex >= 0 ? rawResponse.slice(0, markerIndex) : rawResponse).trim();
  if (!body) {
    return failure('completion_malformed', 'body', 'completion body must be non-empty');
  }
  if (markerMatches.length === 0) {
    return {
      ok: true,
      body,
      report: null,
      violations: [contractViolation('completion_malformed', 'marker', 'completion marker is missing')],
    };
  }
  const rawReport = rawResponse.slice(markerIndex + marker.length).trimStart();
  const violations: CompletionContractViolation[] = [];
  if (markerMatches.length !== 1) {
    violations.push(contractViolation('completion_malformed', 'marker', `expected exactly one final completion marker, received ${markerMatches.length}`));
  }
  if (!rawReport) {
    violations.push(contractViolation('completion_malformed', 'report', 'completion report is empty'));
    return { ok: true, body, report: null, violations };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawReport);
  } catch (error) {
    violations.push(contractViolation('completion_malformed', 'report', `completion report is not strict JSON: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: true, body, report: null, violations };
  }
  const report = CompletionReportSchema.safeParse(candidate);
  if (!report.success) {
    violations.push(...report.error.issues.map(issue => contractViolation(
      'completion_malformed',
      issue.path.join('.') || 'report',
      issue.message,
    )));
    return {
      ok: true,
      body,
      report: null,
      violations,
    };
  }
  return { ok: true, body, report: report.data, violations };
}

function materializeCompletionEnvelope(
  report: CompletedReport,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): CompletedEnvelopeV3;
function materializeCompletionEnvelope(
  report: FailedReport,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): FailedEnvelopeV3;
function materializeCompletionEnvelope(
  report: CompletionReport,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): CompletionEnvelopeV3 {
  if ('failure' in report) {
    return {
      schemaVersion: 4,
      status: 'failed',
      subtaskId: subtask.id,
      failure: report.failure,
    };
  }
  const evidence = [...report.evidence];
  return {
    schemaVersion: 4,
    status: 'completed',
    subtaskId: subtask.id,
    acceptanceEvidence: subtask.acceptance.map(item => ({ key: item.key, evidence: [...evidence] })),
    artifacts,
    handoffs: outgoingHandoffs.map(contract => ({
      toSubtaskId: contract.toSubtaskId,
      items: contract.requiredItems.map(item => item.type === 'text'
        ? { key: item.key, type: 'text' as const, value: evidence.join('\n') }
        : { key: item.key, type: 'artifact' as const, paths: [...artifacts] }),
    })),
  };
}

function validateAcceptance(
  subtask: Subtask,
  envelope: CompletedEnvelopeV3,
  violations: CompletionContractViolation[],
): void {
  const expected = new Set(subtask.acceptance.map(item => item.key));
  const actual = new Set<string>();
  for (const [index, item] of envelope.acceptanceEvidence.entries()) {
    if (actual.has(item.key)) violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.key`, `duplicate acceptance key ${item.key}`));
    actual.add(item.key);
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      if (!evidence.trim()) {
        violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.evidence.${evidenceIndex}`, 'evidence must be non-empty'));
      }
    }
  }
  if (!sameSet(expected, actual)) {
    violations.push(contractViolation('completion_acceptance_mismatch', 'acceptanceEvidence', `acceptance keys must equal authorized keys: ${[...expected].sort().join(', ')}`));
  }
}

function validateHandoffs(
  contracts: OutgoingHandoffContract[],
  envelope: CompletedEnvelopeV3,
  violations: CompletionContractViolation[],
): void {
  const expectedByTarget = new Map(contracts.map(contract => [contract.toSubtaskId, contract.requiredItems]));
  const seenTargets = new Set<string>();
  for (const [handoffIndex, handoff] of envelope.handoffs.entries()) {
    if (seenTargets.has(handoff.toSubtaskId)) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.toSubtaskId`, `duplicate handoff target ${handoff.toSubtaskId}`));
    }
    seenTargets.add(handoff.toSubtaskId);
    const required = expectedByTarget.get(handoff.toSubtaskId);
    if (!required) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}`, `unauthorized handoff target ${handoff.toSubtaskId}`));
      continue;
    }
    const expectedItems = new Map(required.map(item => [item.key, item.type]));
    const actualItems = new Map<string, string>();
    for (const [itemIndex, item] of handoff.items.entries()) {
      if (actualItems.has(item.key)) violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.items.${itemIndex}.key`, `duplicate handoff item ${item.key}`));
      actualItems.set(item.key, item.type);
    }
    if (!sameMap(expectedItems, actualItems)) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.items`, `handoff items must exactly match contract for ${handoff.toSubtaskId}`));
    }
  }
  if (!sameSet(new Set(expectedByTarget.keys()), seenTargets)) {
    violations.push(contractViolation('completion_handoff_mismatch', 'handoffs', 'handoff targets must exactly match authorized outgoing edges'));
  }
}

function validateWorkspaceDelivery(
  subtask: Subtask,
  noChangeReason: string | null,
  delta: WorkspaceDelta,
  workspaceRoot: string,
  violations: CompletionContractViolation[],
): string[] {
  if (delta.baselineTruncated || delta.finalTruncated) {
    violations.push(contractViolation(
      'completion_workspace_delta_uncertain',
      'workspaceDelta',
      'workspace delta is truncated and cannot authorize completion',
    ));
    return [];
  }
  if (subtask.deliveryKind === 'report') {
    if (delta.changed.length > 0) {
      violations.push(contractViolation(
        'completion_report_workspace_changed',
        'workspaceDelta.changed',
        'report delivery must not change the workspace',
      ));
    }
    if (noChangeReason !== null) {
      violations.push(contractViolation(
        'completion_no_change_reason_mismatch',
        'noChangeReason',
        'report delivery requires noChangeReason to be null',
      ));
    }
    return [];
  }
  if (delta.changed.length === 0 && noChangeReason === null) {
    violations.push(contractViolation(
      'completion_no_change_reason_mismatch',
      'noChangeReason',
      'edit delivery without workspace changes requires a no-change reason',
    ));
  }
  if (delta.changed.length > 0 && noChangeReason !== null) {
    violations.push(contractViolation(
      'completion_no_change_reason_mismatch',
      'noChangeReason',
      'edit delivery with workspace changes requires noChangeReason to be null',
    ));
  }

  if (!existsSync(workspaceRoot)) {
    violations.push(contractViolation('completion_artifact_invalid', 'workspaceRoot', 'workspace root does not exist'));
    return [];
  }
  const realRoot = realpathSync(workspaceRoot);
  const artifacts: string[] = [];
  for (const [index, change] of delta.changed.entries()) {
    if (change.afterHash === null) continue;
    const candidate = resolve(workspaceRoot, change.path);
    if (!existsSync(candidate)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `workspaceDelta.changed.${index}.path`,
        `changed output does not exist: ${change.path}`,
      ));
      continue;
    }
    const real = realpathSync(candidate);
    if (!isWithin(realRoot, real)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `workspaceDelta.changed.${index}.path`,
        `changed output escapes the workspace: ${change.path}`,
      ));
      continue;
    }
    artifacts.push(real);
  }
  return artifacts;
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(normalizedParent);
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function sameMap(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function failure(code: CompletionContractErrorCode, path: string, message: string): CompletionProtocolFailure {
  const violation = contractViolation(code, path, message);
  return {
    ok: false,
    body: null,
    envelope: null,
    violations: [violation],
    assessment: {
      result: { kind: 'none' },
      deliverability: { status: 'quarantined', violations: [violation] },
      certification: { status: 'uncertified', violations: [violation] },
      safety: { status: 'safe', violations: [] },
    },
  };
}

function contractViolation(code: CompletionContractErrorCode, path: string, message: string): CompletionContractViolation {
  return { code, path, message };
}

function formatViolation(violation: CompletionContractViolation): string {
  return `${violation.code}:${violation.path}:${violation.message}`;
}

function isSafetyViolation(violation: CompletionContractViolation): boolean {
  return violation.code === 'completion_artifact_invalid'
    || violation.code === 'completion_report_workspace_changed';
}

function compareViolation(left: CompletionContractViolation, right: CompletionContractViolation): number {
  return left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}
