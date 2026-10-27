import {
  closeSync,
  existsSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Subtask } from '../core/types.js';
import { isValidFileOutput, matchesFileOutput } from '../work-graph/file-outputs.js';
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
    evidence: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
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
  // Evidence items may be plain strings or structured citations (kind/
  // description/retrievedAt) — both are valid model output shapes.
  evidence: z.array(z.union([
    z.string().trim().min(1),
    z.record(z.string(), z.unknown()),
  ])),
  noChangeReason: z.string().trim().min(1).nullable(),
  /** Explicit body channel: a report file this attempt wrote to the output area. */
  reportPath: z.string().trim().min(1).max(500).nullable().optional(),
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
  | 'completion_file_output_missing'
  | 'completion_file_output_limit'
  | 'completion_budget_exceeded'
  | 'completion_handoff_mismatch'
  | 'completion_malformed'
  | 'completion_no_change_reason_mismatch'
  /** @deprecated Retained for historical receipt compatibility; never emitted for new attempts. */
  | 'completion_report_workspace_changed'
  | 'completion_subtask_mismatch'
  /** The authorized Workspace root itself is missing or unreadable: structural, not unsafe. */
  | 'completion_workspace_unavailable'
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

/** Structural completion facts gate downstream use, never visibility of safe text. */
const CONTENT_VIOLATION_CODES = new Set<CompletionContractErrorCode>([
  'completion_subtask_mismatch',
  'completion_acceptance_mismatch',
  'completion_malformed',
  'completion_handoff_mismatch',
  'completion_workspace_delta_uncertain',
  'completion_workspace_unavailable',
  'completion_artifact_invalid',
  'completion_file_output_missing',
  'completion_file_output_limit',
  'completion_no_change_reason_mismatch',
]);

function isContentViolation(violation: CompletionContractViolation): boolean {
  return CONTENT_VIOLATION_CODES.has(violation.code);
}

const COMPLETION_BODY_VIOLATION_PATH = 'body';
const EMPTY_BODY_MESSAGE = 'completion body is empty; provide Markdown before the marker or declare reportPath in the trailer';
const MAX_REPORT_PATH_BYTES = 8 * 1024 * 1024;

/**
 * Deterministic body resolution (contract v4):
 * 1. Markdown before the marker wins.
 * 2. Otherwise the trailer's reportPath — a file this attempt produced, or an
 *    existing file explicitly declared by Planner — is the body.
 * Everything else is a correctable format violation, never a safety
 * quarantine.
 */
function resolveCompletionBody(
  body: string,
  report: { reportPath?: string | null } | { failure: unknown } | null,
  workspaceRoot: string,
  delta: WorkspaceDelta | null,
  violations: CompletionContractViolation[],
  fileOutputs?: readonly string[],
): { body: string; resolved: boolean } {
  if (body) return { body, resolved: false };
  const reportPath = report && !('failure' in report) ? (report.reportPath ?? undefined) : undefined;
  if (!reportPath) return { body, resolved: false };
  const produced = delta?.changed.some(entry => entry.path === reportPath && entry.afterHash !== null);
  const declared = isValidFileOutput(reportPath)
    && fileOutputs?.some(output => isValidFileOutput(output) && matchesFileOutput(reportPath, output));
  if (!produced && !declared) {
    violations.push(contractViolation(
      'completion_malformed',
      'reportPath',
      'reportPath must reference a produced file or an existing Planner-declared file',
    ));
    return { body, resolved: false };
  }
  if (!existsSync(workspaceRoot)) {
    violations.push(contractViolation('completion_malformed', 'reportPath', 'workspace root does not exist'));
    return { body, resolved: false };
  }
  const realRoot = realpathSync(workspaceRoot);
  const candidate = resolve(workspaceRoot, reportPath);
  if (!existsSync(candidate) || !isWithin(realRoot, realpathSync(candidate))) {
    violations.push(contractViolation(
      'completion_malformed',
      'reportPath',
      'reportPath does not exist or escapes the workspace',
    ));
    return { body, resolved: false };
  }
  const size = statSync(candidate).size;
  if (size === 0 || size > MAX_REPORT_PATH_BYTES) {
    violations.push(contractViolation(
      'completion_malformed',
      'reportPath',
      `reportPath file size ${size} is out of bounds`,
    ));
    return { body, resolved: false };
  }
  return { body: readFileSync(candidate, 'utf8').trim(), resolved: true };
}

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

  const bodyViolations: CompletionContractViolation[] = [];
  const resolution = resolveCompletionBody(
    parsed.body,
    parsed.report,
    input.workspaceRoot,
    parseWorkspaceDelta(input.workspaceDelta),
    bodyViolations,
    input.subtask.fileOutputs,
  );
  const parsedViolations = [
    ...parsed.violations.filter(violation => !(
      resolution.resolved && violation.path === COMPLETION_BODY_VIOLATION_PATH
    )),
    ...bodyViolations,
  ];

  const violations: CompletionContractViolation[] = [...parsedViolations];
  const body = resolution.body;
  const metadataViolations = [...parsedViolations];
  const safetyViolations: CompletionContractViolation[] = [];
  const certificationViolations: CompletionContractViolation[] = [...parsedViolations];
  const assessmentBase = {
    result: { kind: 'partial' as const },
    deliverability: { status: 'deliverable' as const, violations: [] },
    certification: { status: 'uncertified' as const, violations: certificationViolations },
    safety: { status: 'safe' as const, violations: safetyViolations },
  };
  if (!parsed.report) {
    // Safe text remains visible, but absent metadata cannot authorize downstream work.
    return {
      ok: true, body, envelope: null, normalizedArtifacts: [],
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
  if (safety.length > 0) {
    return {
      ok: false,
      body: null,
      envelope,
      violations: sortedViolations,
      assessment: {
        result: { kind: 'none' },
        deliverability: { status: 'quarantined', violations: safety },
        certification: {
          status: 'uncertified',
          violations: sortedViolations.filter(item => !isSafetyViolation(item)),
        },
        safety: { status: 'safety_blocked', violations: safety },
      },
    };
  }
  // Safe output stays visible; incomplete structural facts hold certification.
  const contentViolations = sortedViolations.filter(isContentViolation);
  return {
    ok: true,
    body,
    envelope,
    normalizedArtifacts,
    warnings: sortedViolations.map(formatViolation),
    assessment: {
      result: { kind: contentViolations.length > 0 ? 'partial' : 'complete' },
      deliverability: { status: 'deliverable', violations: [] },
      certification: {
        status: contentViolations.length > 0 ? 'uncertified' : 'certified',
        violations: contentViolations,
      },
      safety: { status: 'safe', violations: [] },
    },
  };
}

const BUNDLED_MARKER_PREFIX = '<!-- metaclaw:completion:v4 ';
const BUNDLED_MARKER_SUFFIX = ' -->';

/** Extract the first complete JSON object from a trailer region (R1). */
function extractFirstJsonObject(raw: string): { ok: boolean; value?: unknown; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'completion report is empty' };
  const start = trimmed.indexOf('{');
  if (start < 0) return { ok: false, error: 'completion report is not strict JSON: no object found' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, index + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (error) {
          return {
            ok: false,
            error: `completion report is not strict JSON: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    }
  }
  return { ok: false, error: 'completion report is not strict JSON: unterminated object' };
}

function parseCompletion(rawResponse: string): ParsedCompletionReportResult {
  const marker = COMPLETION_MARKER_V4;
  const markerPattern = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  // R1: accept the bundled form `<!-- metaclaw:completion:v4 {...} -->` by
  // normalizing it to the exact marker + JSON layout before matching.
  let normalized = rawResponse;
  let bundledCount = 0;
  for (let searchFrom = 0; ;) {
    const bundledIndex = normalized.indexOf(BUNDLED_MARKER_PREFIX, searchFrom);
    if (bundledIndex < 0) break;
    const closing = normalized.indexOf(BUNDLED_MARKER_SUFFIX, bundledIndex + BUNDLED_MARKER_PREFIX.length);
    if (closing < 0) break;
    const inner = normalized.slice(bundledIndex + BUNDLED_MARKER_PREFIX.length, closing).trim();
    normalized = normalized.slice(0, bundledIndex) + marker + '\n' + inner + normalized.slice(closing + BUNDLED_MARKER_SUFFIX.length);
    bundledCount += 1;
    searchFrom = bundledIndex + marker.length + inner.length + 2;
  }

  const normalizedMatches = bundledCount > 0
    ? [...normalized.matchAll(markerPattern)]
    : [...rawResponse.matchAll(markerPattern)];

  const markerIndex = normalizedMatches.length > 0 ? normalizedMatches[0]!.index! : -1;
  const body = (markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized).trim();
  const violations: CompletionContractViolation[] = [];
  if (!body) {
    violations.push(contractViolation('completion_malformed', 'body', EMPTY_BODY_MESSAGE));
  }
  if (normalizedMatches.length === 0) {
    violations.push(contractViolation('completion_malformed', 'marker', 'completion marker is missing'));
    return { ok: true, body, report: null, violations };
  }
  const rawReport = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length).trimStart() : '';
  if (normalizedMatches.length !== 1) {
    violations.push(contractViolation('completion_malformed', 'marker', `expected exactly one final completion marker, received ${normalizedMatches.length}`));
  }
  if (!rawReport.trim()) {
    violations.push(contractViolation('completion_malformed', 'report', 'completion report is empty'));
    return { ok: true, body, report: null, violations };
  }
  const extracted = extractFirstJsonObject(rawReport);
  if (!extracted.ok) {
    violations.push(contractViolation('completion_malformed', 'report', extracted.error!));
    return { ok: true, body, report: null, violations };
  }
  const report = CompletionReportSchema.safeParse(extracted.value);
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
    if (item.evidence.length === 0) {
      violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.evidence`, 'authorized acceptance requires evidence'));
    }
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      const text = typeof evidence === 'string'
        ? evidence
        : JSON.stringify(evidence) ?? '';
      if (!text.trim()) {
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
      if ((item.type === 'artifact' && item.paths.length === 0)
        || (item.type === 'text' && !item.value.trim())) {
        violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.items.${itemIndex}`, 'required handoff has no readable result'));
      }
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
  if (subtask.deliveryKind !== 'report') {
    if (delta.changed.length === 0 && noChangeReason === null) {
      violations.push(contractViolation(
        'completion_no_change_reason_mismatch',
        'noChangeReason',
        'edit delivery without workspace changes requires a no-change reason',
      ));
    }
    // The Runtime's before/after observation is authoritative. A model may
    // carry over a stale explanation after it has edited a file; that metadata
    // cannot turn a real Workspace delta into a no-change result, so it is
    // treated as null by the completion contract instead of sending the
    // user through an avoidable acceptance or correction step.
  }

  // Only Planner-selected outputs become file deliveries. An absent contract
  // belongs to an already-authorized historical graph (schema 49 or earlier).
  const outputs = subtask.fileOutputs;
  if (outputs?.some(path => !isValidFileOutput(path))) {
    violations.push(contractViolation('completion_artifact_invalid', 'fileOutputs', 'invalid authorized file output path'));
    return [];
  }

  if (!existsSync(workspaceRoot)) {
    // A missing Workspace root is an environment/structural fact. Classifying it
    // as an artifact-path violation turned a deterministic contract failure into
    // a `safety_blocked` quarantine, which then blocked the Subtask as if the
    // Executor had produced unsafe content.
    violations.push(contractViolation('completion_workspace_unavailable', 'workspaceRoot', 'workspace root does not exist'));
    return [];
  }
  const realRoot = realpathSync(workspaceRoot);
  const artifacts: string[] = [];
  const deliveredPaths: string[] = [];
  const changedFiles = delta.changed.filter(change => change.afterHash !== null).map(change => change.path);
  // A declared file may already exist (for example a no-change edit or a
  // request to deliver an existing result). Presence, not rewriting, is required.
  const candidates = new Set(changedFiles);
  let visited = 0;
  const collectDeclared = (path: string): void => {
    if (++visited > 1000) return;
    const absolute = resolve(workspaceRoot, path);
    if (!existsSync(absolute)) return;
    const real = realpathSync(absolute);
    if (!isWithin(realRoot, real) || lstatSync(absolute).isSymbolicLink()) {
      violations.push(contractViolation('completion_artifact_invalid', 'fileOutputs', `declared output escapes the workspace or is a symlink: ${path}`));
      return;
    }
    if (lstatSync(absolute).isFile()) { candidates.add(path); return; }
    const directory = opendirSync(absolute);
    try {
      for (let entry = directory.readSync(); entry && visited <= 1000; entry = directory.readSync()) {
        const child = relative(workspaceRoot, resolve(absolute, entry.name)).split(sep).join('/');
        if (!isValidFileOutput(child)) { visited++; continue; }
        collectDeclared(child);
      }
    } finally { directory.closeSync(); }
  };
  for (const output of outputs ?? []) {
    try {
      const candidate = resolve(workspaceRoot, output);
      if (existsSync(candidate) && (output.endsWith('/') || !lstatSync(candidate).isDirectory())) {
        collectDeclared(output.endsWith('/') ? output.slice(0, -1) : output);
      }
    } catch {
      violations.push(contractViolation('completion_file_output_missing', 'fileOutputs', `declared output cannot be inspected: ${output}`));
    }
  }
  if (visited > 1000) violations.push(contractViolation('completion_file_output_limit', 'fileOutputs',
    'declared output directories exceed the bounded 1000-entry inspection limit'));
  for (const [index, path] of [...candidates].entries()) {
    const change = { path };
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
    if (outputs !== undefined && !outputs.some(output => matchesFileOutput(change.path, output))) continue;
    if (!lstatSync(candidate).isFile()) {
      violations.push(contractViolation('completion_artifact_invalid', `workspaceDelta.changed.${index}.path`,
        'file delivery must be a regular file, not a directory or symlink'));
      continue;
    }
    artifacts.push(real);
    deliveredPaths.push(change.path);
  }
  for (const [index, output] of (outputs ?? []).entries()) {
    if (!deliveredPaths.some(path => matchesFileOutput(path, output))) {
      violations.push(contractViolation('completion_file_output_missing', `fileOutputs.${index}`,
        `declared file output is missing: ${output}`));
    }
  }
  validateImageArtifactContract(subtask, artifacts, violations);
  return artifacts;
}

function validateImageArtifactContract(
  subtask: Subtask,
  artifacts: readonly string[],
  violations: CompletionContractViolation[],
): void {
  const requiresImageArtifact = subtask.requiredCapabilities.some(
    capability => capability === 'image-generation' || capability === 'image-editing',
  );
  if (!requiresImageArtifact) return;
  if (artifacts.some(isValidImageArtifact)) return;
  violations.push(contractViolation(
    'completion_artifact_invalid',
    'artifacts',
    'image generation or editing completion requires at least one valid image artifact',
  ));
}

function isValidImageArtifact(path: string): boolean {
  const extension = extname(path).toLocaleLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return false;
  const bytes = readImageSignature(path);
  if (!bytes) return false;
  if (extension === '.png') {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 3
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff;
  }
  if (extension === '.gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function readImageSignature(path: string): Buffer | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(12);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close cannot turn an untrusted artifact into a valid one.
      }
    }
  }
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

function contractViolation(code: CompletionContractErrorCode, path: string, message: string): CompletionContractViolation {
  return { code, path, message };
}

function formatViolation(violation: CompletionContractViolation): string {
  return `${violation.code}:${violation.path}:${violation.message}`;
}

function isSafetyViolation(violation: CompletionContractViolation): boolean {
  return violation.code === 'completion_artifact_invalid';
}

function compareViolation(left: CompletionContractViolation, right: CompletionContractViolation): number {
  return left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}
