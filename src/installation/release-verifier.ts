// Computes and verifies release artifact hash/size independently of the signed
// manifest. The installer uses this after download so a corrupted or truncated
// artifact is rejected before any file is switched.
import { createHash } from 'node:crypto';
import type { ArtifactVerification } from './release-manifest.js';

export function computeArtifactVerification(bytes: Buffer): ArtifactVerification {
  return {
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function verifyArtifactBytes(
  bytes: Buffer,
  expected: ArtifactVerification,
): { ok: true } | { ok: false; reason: string } {
  if (bytes.byteLength !== expected.byteSize) {
    return { ok: false, reason: 'artifact byte size mismatch' };
  }
  const actual = computeArtifactVerification(bytes);
  if (actual.sha256 !== expected.sha256) {
    return { ok: false, reason: 'artifact sha256 mismatch' };
  }
  return { ok: true };
}
