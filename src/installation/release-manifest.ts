import { verify } from 'node:crypto';
import { z } from 'zod';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SemverSchema = z.string().trim().regex(
  SEMVER_PATTERN,
  'must be a semantic version',
);
const RevisionPinSchema = z.string().trim().min(1, 'revision pin is required');
const Sha256Schema = z.string().trim().regex(/^[a-f0-9]{64}$/u, 'must be a lowercase sha256 hex digest');

const ReleaseArtifactSchema = z.object({
  source: z.string().trim().min(1),
  revision: RevisionPinSchema,
  url: z.string().trim().url(),
  byteSize: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();

const CompatibilitySchema = z.object({
  configurationSchema: z.number().int().positive(),
  plannerHostProtocol: z.number().int().positive(),
  planningPlanSchema: z.number().int().positive(),
  planningPlanSchemaHash: z.string().trim().min(1),
  workGraphSchema: z.number().int().positive(),
  kernelDecisionSchema: z.number().int().positive(),
  databaseSchema: z.number().int().positive(),
}).strict();

const SignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string().trim().min(1),
  value: z.string().trim().min(1),
}).strict();

export const ReleaseManifestSchema = z.object({
  manifestSchemaVersion: z.number().int().positive(),
  releaseId: SemverSchema,
  channel: z.enum(['stable', 'preview']),
  publishedAt: z.string().trim().datetime({ offset: true }),
  expiresAt: z.string().trim().datetime({ offset: true }),
  minimumInstallerVersion: SemverSchema,
  minimumNodeVersion: SemverSchema,
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  metawork: ReleaseArtifactSchema,
  planner: ReleaseArtifactSchema,
  compatibility: CompatibilitySchema,
  signature: SignatureSchema,
  previousCompatibleRelease: SemverSchema.nullable(),
}).strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseManifestInput = z.input<typeof ReleaseManifestSchema>;

export interface ArtifactVerification {
  byteSize: number;
  sha256: string;
}

export interface ReleaseManifestVerificationOptions {
  expectedChannel: ReleaseManifest['channel'];
  expectedPlatform: ReleaseManifest['platform'];
  expectedArch: ReleaseManifest['arch'];
  currentInstallerVersion: string;
  currentNodeVersion: string;
  now: Date;
  trustedKeys: Record<string, string>;
  revokedKeyIds: readonly string[];
  artifacts: {
    metawork: ArtifactVerification;
    planner: ArtifactVerification;
  };
}

export interface RequiredReleaseCompatibility {
  configurationSchema: number;
  plannerHostProtocol: number;
  planningPlanSchema: number;
  planningPlanSchemaHash?: string;
  workGraphSchema: number;
  kernelDecisionSchema: number;
  databaseSchema: number;
}

export type ReleaseCompatibilityDecision =
  | { ok: true }
  | { ok: false; reason: string };

export type ReleaseCompatibilityInput =
  | {
      mode: 'update';
      currentReleaseId: string;
      candidate: ReleaseManifest;
      requiredCompatibility: RequiredReleaseCompatibility;
    }
  | {
      mode: 'rollback';
      currentReleaseId: string;
      candidate: ReleaseManifest;
      requiredCompatibility: RequiredReleaseCompatibility;
      previouslyVerifiedCompatibleReleaseIds: readonly string[];
    };

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  return ReleaseManifestSchema.parse(input);
}

export function canonicalizeReleaseManifestPayload(input: unknown): string {
  const { signature: _signature, ...payload } = input as { signature?: unknown };

  return stableStringify(payload);
}

export function verifyReleaseManifest(
  input: unknown,
  options: ReleaseManifestVerificationOptions,
): ReleaseManifest {
  const manifest = parseReleaseManifest(input);

  if (manifest.channel !== options.expectedChannel) {
    throw new Error(`release manifest channel mismatch: expected ${options.expectedChannel}, got ${manifest.channel}`);
  }
  if (manifest.platform !== options.expectedPlatform) {
    throw new Error(`release manifest platform mismatch: expected ${options.expectedPlatform}, got ${manifest.platform}`);
  }
  if (manifest.arch !== options.expectedArch) {
    throw new Error(`release manifest arch mismatch: expected ${options.expectedArch}, got ${manifest.arch}`);
  }
  if (new Date(manifest.expiresAt).getTime() <= options.now.getTime()) {
    throw new Error('release manifest expired');
  }
  if (compareSemanticVersions(options.currentInstallerVersion, manifest.minimumInstallerVersion) < 0) {
    throw new Error(
      `installer version ${options.currentInstallerVersion} does not satisfy minimum ${manifest.minimumInstallerVersion}`,
    );
  }
  if (compareSemanticVersions(options.currentNodeVersion, manifest.minimumNodeVersion) < 0) {
    throw new Error(
      `Node version ${options.currentNodeVersion} does not satisfy minimum ${manifest.minimumNodeVersion}`,
    );
  }
  if (options.revokedKeyIds.includes(manifest.signature.keyId)) {
    throw new Error(`release manifest signing key is revoked: ${manifest.signature.keyId}`);
  }

  const trustedKey = options.trustedKeys[manifest.signature.keyId];
  if (!trustedKey) {
    throw new Error(`release manifest uses unknown signing key: ${manifest.signature.keyId}`);
  }

  if (!verifyManifestSignature(manifest, trustedKey)) {
    throw new Error('release manifest signature verification failed');
  }

  verifyArtifact('metawork', manifest.metawork, options.artifacts.metawork);
  verifyArtifact('planner', manifest.planner, options.artifacts.planner);

  return manifest;
}

export function decideReleaseCompatibility(input: ReleaseCompatibilityInput): ReleaseCompatibilityDecision {
  const compatibilityProblem = findCompatibilityProblem(input.candidate, input.requiredCompatibility);
  if (compatibilityProblem) {
    return { ok: false, reason: compatibilityProblem };
  }

  const versionOrder = compareSemanticVersions(input.candidate.releaseId, input.currentReleaseId);

  if (input.mode === 'update' && versionOrder < 0) {
    return { ok: false, reason: 'default update forbids downgrade' };
  }

  if (input.mode === 'rollback' && versionOrder >= 0) {
    return { ok: false, reason: 'rollback target must be strictly older than the current release' };
  }

  if (
    input.mode === 'rollback'
    && !input.previouslyVerifiedCompatibleReleaseIds.includes(input.candidate.releaseId)
  ) {
    return {
      ok: false,
      reason: `rollback target ${input.candidate.releaseId} was not previously verified compatible`,
    };
  }

  return { ok: true };
}

function verifyManifestSignature(manifest: ReleaseManifest, trustedPublicKey: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalizeReleaseManifestPayload(manifest)),
      trustedPublicKey,
      Buffer.from(manifest.signature.value, 'base64'),
    );
  } catch {
    return false;
  }
}

function verifyArtifact(
  name: 'metawork' | 'planner',
  expected: ReleaseManifest['metawork'],
  actual: ArtifactVerification,
): void {
  if (actual.byteSize !== expected.byteSize) {
    throw new Error(`${name} artifact size mismatch`);
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(`${name} artifact hash mismatch`);
  }
}

function findCompatibilityProblem(
  manifest: ReleaseManifest,
  required: RequiredReleaseCompatibility,
): string | null {
  for (const key of [
    'configurationSchema',
    'plannerHostProtocol',
    'planningPlanSchema',
    'workGraphSchema',
    'kernelDecisionSchema',
    'databaseSchema',
  ] as const) {
    if (manifest.compatibility[key] !== required[key]) {
      return `incompatible ${key}: expected ${required[key]}, got ${manifest.compatibility[key]}`;
    }
  }

  if (
    required.planningPlanSchemaHash
    && manifest.compatibility.planningPlanSchemaHash !== required.planningPlanSchemaHash
  ) {
    return 'incompatible planningPlanSchemaHash';
  }

  return null;
}

function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = compareNumericIdentifier(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }

  if (leftVersion.prerelease.length === 0) {
    return rightVersion.prerelease.length === 0 ? 0 : 1;
  }
  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  for (
    let index = 0;
    index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    index += 1
  ) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);

    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;

    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

function parseSemanticVersion(version: string): {
  core: [string, string, string];
  prerelease: string[];
} {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`invalid semantic version: ${version}`);
  }

  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }

  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
