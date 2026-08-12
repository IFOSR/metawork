import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeReleaseManifestPayload,
  decideReleaseCompatibility,
  parseReleaseManifest,
  verifyReleaseManifest,
  type ReleaseManifestInput,
} from '../../src/installation/release-manifest.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trustedPublicKey = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const metaworkBytes = Buffer.from('metawork artifact');
const plannerBytes = Buffer.from('planner artifact');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseManifest(overrides: Partial<ReleaseManifestInput> = {}): ReleaseManifestInput {
  const unsigned = {
    manifestSchemaVersion: 1,
    releaseId: '2.0.0',
    channel: 'stable',
    publishedAt: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-09-11T00:00:00.000Z',
    minimumInstallerVersion: '1.0.0',
    minimumNodeVersion: '22.19.0',
    platform: 'darwin',
    arch: 'arm64',
    metawork: {
      source: 'https://github.com/IFOSR/metawork.git',
      revision: 'metawork-revision-pin',
      url: 'https://releases.example.test/metawork.tgz',
      byteSize: metaworkBytes.byteLength,
      sha256: sha256(metaworkBytes),
    },
    planner: {
      source: 'https://github.com/IFOSR/AnyFusion-Pi.git',
      revision: 'd62eed393f77fadf771d881b56176f680eb4da57',
      url: 'https://releases.example.test/planner.tgz',
      byteSize: plannerBytes.byteLength,
      sha256: sha256(plannerBytes),
    },
    compatibility: {
      configurationSchema: 2,
      plannerHostProtocol: 2,
      planningPlanSchema: 8,
      planningPlanSchemaHash: 'planning-schema-hash',
      workGraphSchema: 7,
      kernelDecisionSchema: 6,
      databaseSchema: 31,
    },
    previousCompatibleRelease: '1.9.0',
  } satisfies Omit<ReleaseManifestInput, 'signature'>;

  const signature = sign(null, Buffer.from(canonicalizeReleaseManifestPayload(unsigned)), privateKey)
    .toString('base64');

  return {
    ...unsigned,
    signature: { algorithm: 'ed25519', keyId: 'release-2026-01', value: signature },
    ...overrides,
  };
}

describe('release manifest parsing and verification', () => {
  it('strictly parses a signed manifest and rejects unknown fields', () => {
    const parsed = parseReleaseManifest(baseManifest());

    expect(parsed.releaseId).toBe('2.0.0');
    expect(() => parseReleaseManifest({ ...baseManifest(), serverRoot: '/invalid' }))
      .toThrow(/unrecognized/i);
  });

  it('rejects manifests with missing revision pins', () => {
    expect(() => parseReleaseManifest({
      ...baseManifest(),
      planner: { ...baseManifest().planner, revision: '' },
    })).toThrow(/revision/i);
  });

  it('verifies trust, target platform, expiry, signature, and artifact integrity before activation', () => {
    const manifest = baseManifest();

    expect(verifyReleaseManifest(manifest, {
      expectedChannel: 'stable',
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
      currentInstallerVersion: '1.0.0',
      currentNodeVersion: '22.19.0',
      now: new Date('2026-08-12T00:00:00.000Z'),
      trustedKeys: { 'release-2026-01': trustedPublicKey },
      revokedKeyIds: [],
      artifacts: {
        metawork: { byteSize: metaworkBytes.byteLength, sha256: sha256(metaworkBytes) },
        planner: { byteSize: plannerBytes.byteLength, sha256: sha256(plannerBytes) },
      },
    })).toMatchObject({ releaseId: '2.0.0' });
  });

  it('rejects wrong channel, platform, arch, expired manifests, unknown keys, revoked keys, bad signatures, and artifact mismatches', () => {
    const options = {
      expectedChannel: 'stable',
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
      currentInstallerVersion: '1.0.0',
      currentNodeVersion: '22.19.0',
      now: new Date('2026-08-12T00:00:00.000Z'),
      trustedKeys: { 'release-2026-01': trustedPublicKey },
      revokedKeyIds: [] as string[],
      artifacts: {
        metawork: { byteSize: metaworkBytes.byteLength, sha256: sha256(metaworkBytes) },
        planner: { byteSize: plannerBytes.byteLength, sha256: sha256(plannerBytes) },
      },
    };

    expect(() => verifyReleaseManifest({ ...baseManifest(), channel: 'preview' }, options))
      .toThrow(/channel/i);
    expect(() => verifyReleaseManifest({ ...baseManifest(), platform: 'linux' }, options))
      .toThrow(/platform/i);
    expect(() => verifyReleaseManifest({ ...baseManifest(), arch: 'x64' }, options))
      .toThrow(/arch/i);
    expect(() => verifyReleaseManifest(baseManifest(), { ...options, now: new Date('2026-10-01T00:00:00.000Z') }))
      .toThrow(/expired/i);
    expect(() => verifyReleaseManifest(baseManifest(), { ...options, trustedKeys: {} }))
      .toThrow(/unknown/i);
    expect(() => verifyReleaseManifest(baseManifest(), { ...options, revokedKeyIds: ['release-2026-01'] }))
      .toThrow(/revoked/i);
    expect(() => verifyReleaseManifest({
      ...baseManifest(),
      signature: { algorithm: 'ed25519', keyId: 'release-2026-01', value: 'not-valid-base64' },
    }, options)).toThrow(/signature/i);
    expect(() => verifyReleaseManifest(baseManifest(), {
      ...options,
      artifacts: {
        ...options.artifacts,
        planner: { byteSize: plannerBytes.byteLength + 1, sha256: sha256(plannerBytes) },
      },
    })).toThrow(/size/i);
    expect(() => verifyReleaseManifest(baseManifest(), {
      ...options,
      artifacts: {
        ...options.artifacts,
        planner: { byteSize: plannerBytes.byteLength, sha256: sha256(Buffer.from('tampered')) },
      },
    })).toThrow(/hash/i);
  });

  it('rejects manifests that require a newer installer or Node runtime', () => {
    const options = {
      expectedChannel: 'stable' as const,
      expectedPlatform: 'darwin' as const,
      expectedArch: 'arm64' as const,
      currentInstallerVersion: '1.0.0',
      currentNodeVersion: '22.19.0',
      now: new Date('2026-08-12T00:00:00.000Z'),
      trustedKeys: { 'release-2026-01': trustedPublicKey },
      revokedKeyIds: [] as string[],
      artifacts: {
        metawork: { byteSize: metaworkBytes.byteLength, sha256: sha256(metaworkBytes) },
        planner: { byteSize: plannerBytes.byteLength, sha256: sha256(plannerBytes) },
      },
    };

    expect(() => verifyReleaseManifest(baseManifest(), {
      ...options,
      currentInstallerVersion: '0.9.0',
    })).toThrow(/installer.*1\.0\.0/i);
    expect(() => verifyReleaseManifest(baseManifest(), {
      ...options,
      currentNodeVersion: '22.18.0',
    })).toThrow(/node.*22\.19\.0/i);
  });
});

describe('release update and rollback compatibility decisions', () => {
  it('allows compatible forward updates and forbids default downgrades', () => {
    expect(decideReleaseCompatibility({
      mode: 'update',
      currentReleaseId: '1.9.0',
      candidate: parseReleaseManifest(baseManifest()),
      requiredCompatibility: {
        configurationSchema: 2,
        plannerHostProtocol: 2,
        planningPlanSchema: 8,
        workGraphSchema: 7,
        kernelDecisionSchema: 6,
        databaseSchema: 31,
      },
    })).toEqual({ ok: true });

    expect(decideReleaseCompatibility({
      mode: 'update',
      currentReleaseId: '2.0.0',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '1.8.0' })),
      requiredCompatibility: {
        configurationSchema: 2,
        plannerHostProtocol: 2,
        planningPlanSchema: 8,
        workGraphSchema: 7,
        kernelDecisionSchema: 6,
        databaseSchema: 31,
      },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/downgrade/i) });
  });

  it('applies SemVer precedence to prereleases and ignores build metadata', () => {
    const requiredCompatibility = {
      configurationSchema: 2,
      plannerHostProtocol: 2,
      planningPlanSchema: 8,
      workGraphSchema: 7,
      kernelDecisionSchema: 6,
      databaseSchema: 31,
    };

    expect(decideReleaseCompatibility({
      mode: 'update',
      currentReleaseId: '2.0.0',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '2.0.0-preview.1' })),
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/downgrade/i) });

    expect(decideReleaseCompatibility({
      mode: 'update',
      currentReleaseId: '2.0.0-preview.10',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '2.0.0-preview.2' })),
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/downgrade/i) });

    expect(decideReleaseCompatibility({
      mode: 'update',
      currentReleaseId: '2.0.0-preview.2',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '2.0.0-preview.10' })),
      requiredCompatibility,
    })).toEqual({ ok: true });

    expect(decideReleaseCompatibility({
      mode: 'rollback',
      currentReleaseId: '2.0.0-preview.2+current',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '2.0.0-preview.2+candidate' })),
      previouslyVerifiedCompatibleReleaseIds: ['2.0.0-preview.2+candidate'],
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/i) });
  });

  it('allows explicit rollback only to a strictly older, previously verified compatible manifest', () => {
    const requiredCompatibility = {
      configurationSchema: 2,
      plannerHostProtocol: 2,
      planningPlanSchema: 8,
      workGraphSchema: 7,
      kernelDecisionSchema: 6,
      databaseSchema: 31,
    };

    expect(decideReleaseCompatibility({
      mode: 'rollback',
      currentReleaseId: '2.0.0',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '1.9.0', previousCompatibleRelease: null })),
      previouslyVerifiedCompatibleReleaseIds: ['1.9.0'],
      requiredCompatibility,
    })).toEqual({ ok: true });

    expect(decideReleaseCompatibility({
      mode: 'rollback',
      currentReleaseId: '2.0.0',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '1.8.0', previousCompatibleRelease: null })),
      previouslyVerifiedCompatibleReleaseIds: ['1.9.0'],
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/previously verified/i) });

    expect(decideReleaseCompatibility({
      mode: 'rollback',
      currentReleaseId: '2.0.0',
      candidate: parseReleaseManifest(baseManifest()),
      previouslyVerifiedCompatibleReleaseIds: ['2.0.0'],
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/i) });

    expect(decideReleaseCompatibility({
      mode: 'rollback',
      currentReleaseId: '2.0.0-preview.2',
      candidate: parseReleaseManifest(baseManifest({ releaseId: '2.0.0-preview.10' })),
      previouslyVerifiedCompatibleReleaseIds: ['2.0.0-preview.10'],
      requiredCompatibility,
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/i) });
  });
});
