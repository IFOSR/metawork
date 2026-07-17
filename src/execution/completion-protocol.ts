import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Subtask } from '../core/types.js';
import type { WorkGraphRequiredItem } from '../work-graph/index.js';

export const COMPLETION_MARKER_V1 = '<!-- metaclaw:completion:v1 -->';
const MAX_ENVELOPE_BYTES = 128 * 1024;

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
const CompletionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
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

export type CompletionEnvelopeV1 = z.infer<typeof CompletionEnvelopeSchema>;
export type CompletionHandoffV1 = CompletionEnvelopeV1['handoffs'][number];

export type CompletionContractErrorCode =
  | 'completion_acceptance_mismatch'
  | 'completion_artifact_invalid'
  | 'completion_artifact_required'
  | 'completion_budget_exceeded'
  | 'completion_handoff_mismatch'
  | 'completion_malformed'
  | 'completion_patch_evidence_missing'
  | 'completion_subtask_mismatch';

export interface CompletionContractViolation {
  code: CompletionContractErrorCode;
  path: string;
  message: string;
}

export type CompletionProtocolResult =
  | {
    ok: true;
    body: string;
    envelope: CompletionEnvelopeV1;
    normalizedArtifacts: string[];
    warnings: string[];
  }
  | {
    ok: false;
    body: string | null;
    envelope: CompletionEnvelopeV1 | null;
    violations: CompletionContractViolation[];
  };

export interface OutgoingHandoffContract {
  toSubtaskId: string;
  requiredItems: WorkGraphRequiredItem[];
}

export interface IncomingHandoffUsage {
  textCharacters: number;
  artifactPaths: number;
}

/** Parses, strips and deterministically verifies the exact v1 completion trailer. */
export function validateCompletionProtocol(input: {
  rawResponse: string;
  subtask: Subtask;
  outgoingHandoffs: OutgoingHandoffContract[];
  targetPaths: string[];
  cwd?: string;
  incomingUsageByTarget?: ReadonlyMap<string, IncomingHandoffUsage>;
}): CompletionProtocolResult {
  const parsed = parseCompletion(input.rawResponse);
  if (!parsed.ok) return parsed;

  const violations: CompletionContractViolation[] = [];
  const { body, envelope } = parsed;
  if (envelope.subtaskId !== input.subtask.id) {
    violations.push(contractViolation('completion_subtask_mismatch', 'subtaskId', `expected ${input.subtask.id}, received ${envelope.subtaskId}`));
  }
  validateAcceptance(input.subtask, envelope, violations);
  validateHandoffs(input.outgoingHandoffs, envelope, violations);
  validateBudgets(envelope, violations, input.incomingUsageByTarget);
  const normalizedArtifacts = validateArtifacts(envelope, input.targetPaths, input.cwd ?? process.cwd(), violations);
  validateExpectedOutput(input.subtask, envelope, violations);

  if (violations.length > 0) {
    return { ok: false, body, envelope, violations: violations.sort(compareViolation) };
  }
  return {
    ok: true,
    body,
    envelope,
    normalizedArtifacts,
    warnings: collectWarnings(input.subtask, body),
  };
}

function parseCompletion(rawResponse: string): CompletionProtocolResult {
  const markerMatches = [...rawResponse.matchAll(new RegExp(COMPLETION_MARKER_V1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (markerMatches.length !== 1) {
    return failure('completion_malformed', 'marker', `expected exactly one final completion marker, received ${markerMatches.length}`);
  }
  const markerIndex = markerMatches[0]!.index!;
  const body = rawResponse.slice(0, markerIndex).trim();
  const rawEnvelope = rawResponse.slice(markerIndex + COMPLETION_MARKER_V1.length).trimStart();
  if (!body) return failure('completion_malformed', 'body', 'completion body must be non-empty');
  if (!rawEnvelope || Buffer.byteLength(rawEnvelope, 'utf8') > MAX_ENVELOPE_BYTES) {
    return failure('completion_budget_exceeded', 'envelope', 'completion envelope is empty or exceeds 128 KiB');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawEnvelope);
  } catch (error) {
    return failure('completion_malformed', 'envelope', `completion envelope is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CompletionEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      body,
      envelope: null,
      violations: parsed.error.issues.map(issue => contractViolation(
        'completion_malformed',
        issue.path.join('.') || 'envelope',
        issue.message,
      )),
    };
  }
  return { ok: true, body, envelope: parsed.data, normalizedArtifacts: [], warnings: [] };
}

function validateAcceptance(
  subtask: Subtask,
  envelope: CompletionEnvelopeV1,
  violations: CompletionContractViolation[],
): void {
  const expected = new Set(subtask.acceptance.map(item => item.key));
  const actual = new Set<string>();
  let total = 0;
  for (const [index, item] of envelope.acceptanceEvidence.entries()) {
    if (actual.has(item.key)) violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.key`, `duplicate acceptance key ${item.key}`));
    actual.add(item.key);
    if (item.evidence.length < 1 || item.evidence.length > 4) {
      violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.evidence`, 'acceptance evidence must contain 1 to 4 entries'));
    }
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      total += evidence.length;
      if (!evidence.trim() || evidence.length > 1_000) {
        violations.push(contractViolation('completion_budget_exceeded', `acceptanceEvidence.${index}.evidence.${evidenceIndex}`, 'evidence must contain 1 to 1000 characters'));
      }
    }
  }
  if (!sameSet(expected, actual)) {
    violations.push(contractViolation('completion_acceptance_mismatch', 'acceptanceEvidence', `acceptance keys must equal authorized keys: ${[...expected].sort().join(', ')}`));
  }
  if (total > 12_000) violations.push(contractViolation('completion_budget_exceeded', 'acceptanceEvidence', 'acceptance evidence exceeds 12000 characters'));
}

function validateHandoffs(
  contracts: OutgoingHandoffContract[],
  envelope: CompletionEnvelopeV1,
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

function validateBudgets(
  envelope: CompletionEnvelopeV1,
  violations: CompletionContractViolation[],
  incomingUsageByTarget: ReadonlyMap<string, IncomingHandoffUsage> | undefined,
): void {
  let totalText = 0;
  let totalHandoffArtifacts = 0;
  for (const [handoffIndex, handoff] of envelope.handoffs.entries()) {
    let edgeText = 0;
    let edgeArtifacts = 0;
    for (const [itemIndex, item] of handoff.items.entries()) {
      if (item.type === 'text') {
        edgeText += item.value.length;
        totalText += item.value.length;
        if (!item.value.trim() || item.value.length > 4_000) {
          violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.items.${itemIndex}.value`, 'text handoff item must contain 1 to 4000 characters'));
        }
      } else {
        edgeArtifacts += item.paths.length;
        totalHandoffArtifacts += item.paths.length;
        if (item.paths.length < 1 || item.paths.length > 20) {
          violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.items.${itemIndex}.paths`, 'artifact handoff item must contain 1 to 20 paths'));
        }
      }
    }
    if (edgeText > 12_000) violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}`, 'edge text exceeds 12000 characters'));
    if (edgeArtifacts > 20) violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}`, 'edge artifact paths exceed 20'));
    const existingIncoming = incomingUsageByTarget?.get(handoff.toSubtaskId);
    if ((existingIncoming?.textCharacters ?? 0) + edgeText > 24_000) {
      violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.toSubtaskId`, `all incoming handoff text for ${handoff.toSubtaskId} exceeds 24000 characters`));
    }
    if ((existingIncoming?.artifactPaths ?? 0) + edgeArtifacts > 40) {
      violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.toSubtaskId`, `all incoming handoff artifact paths for ${handoff.toSubtaskId} exceed 40`));
    }
  }
  if (totalText > 24_000) violations.push(contractViolation('completion_budget_exceeded', 'handoffs', 'all outgoing handoff text exceeds 24000 characters'));
  if (totalHandoffArtifacts > 40) violations.push(contractViolation('completion_budget_exceeded', 'handoffs', 'all outgoing handoff artifact paths exceed 40'));
  if (envelope.artifacts.length > 40) violations.push(contractViolation('completion_budget_exceeded', 'artifacts', 'node artifacts exceed 40 paths'));
}

function validateArtifacts(
  envelope: CompletionEnvelopeV1,
  targetPaths: string[],
  cwd: string,
  violations: CompletionContractViolation[],
): string[] {
  const declared = new Set<string>();
  const normalized: string[] = [];
  const realTargets = targetPaths.filter(existsSync).map(path => realpathSync(path));
  for (const [index, artifact] of envelope.artifacts.entries()) {
    if (!artifact.trim() || artifact.length > 1_024) {
      violations.push(contractViolation('completion_artifact_invalid', `artifacts.${index}`, 'artifact path must contain 1 to 1024 characters'));
      continue;
    }
    const candidate = isAbsolute(artifact) ? artifact : resolve(cwd, artifact);
    if (!existsSync(candidate)) {
      violations.push(contractViolation('completion_artifact_invalid', `artifacts.${index}`, `artifact does not exist: ${artifact}`));
      continue;
    }
    const real = realpathSync(candidate);
    if (!realTargets.some(target => isWithin(target, real))) {
      violations.push(contractViolation('completion_artifact_invalid', `artifacts.${index}`, `artifact escapes Task target paths: ${artifact}`));
      continue;
    }
    if (declared.has(real)) {
      violations.push(contractViolation('completion_artifact_invalid', `artifacts.${index}`, `duplicate artifact path: ${artifact}`));
      continue;
    }
    declared.add(real);
    normalized.push(real);
  }
  for (const [handoffIndex, handoff] of envelope.handoffs.entries()) {
    for (const [itemIndex, item] of handoff.items.entries()) {
      if (item.type !== 'artifact') continue;
      for (const path of item.paths) {
        const candidate = isAbsolute(path) ? path : resolve(cwd, path);
        const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
        if (!declared.has(real)) violations.push(contractViolation('completion_artifact_invalid', `handoffs.${handoffIndex}.items.${itemIndex}.paths`, `handoff artifact must also be declared at top level: ${path}`));
      }
    }
  }
  return normalized;
}

function validateExpectedOutput(subtask: Subtask, envelope: CompletionEnvelopeV1, violations: CompletionContractViolation[]): void {
  if (subtask.expectedOutput === 'artifact' && envelope.artifacts.length === 0) {
    violations.push(contractViolation('completion_artifact_required', 'artifacts', 'artifact output requires at least one valid artifact'));
  }
  if (subtask.expectedOutput === 'patch') {
    const evidence = envelope.acceptanceEvidence.flatMap(item => item.evidence).join('\n').toLowerCase();
    if (!/(test|测试|未测试|not tested|not run|未运行)/i.test(evidence)) {
      violations.push(contractViolation('completion_patch_evidence_missing', 'acceptanceEvidence', 'patch output requires test evidence or an explicit not-tested explanation'));
    }
  }
}

function collectWarnings(subtask: Subtask, body: string): string[] {
  if (subtask.expectedOutput === 'analysis' && !/(source|来源|limit|限制)/i.test(body)) {
    return ['analysis output does not explicitly identify sources or limitations'];
  }
  if (subtask.expectedOutput === 'review' && !/(verdict|结论|approve|request changes|通过|不通过)/i.test(body)) {
    return ['review output does not contain an explicit verdict'];
  }
  return [];
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

function failure(code: CompletionContractErrorCode, path: string, message: string): CompletionProtocolResult {
  return { ok: false, body: null, envelope: null, violations: [contractViolation(code, path, message)] };
}

function contractViolation(code: CompletionContractErrorCode, path: string, message: string): CompletionContractViolation {
  return { code, path, message };
}

function compareViolation(left: CompletionContractViolation, right: CompletionContractViolation): number {
  return left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}
