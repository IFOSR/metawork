import { describe, expect, it } from 'vitest';
import { computeArtifactVerification, verifyArtifactBytes } from '../../src/installation/release-verifier.js';

describe('release-verifier', () => {
  it('computes byte size and sha256', () => {
    const bytes = Buffer.from('hello release');
    const verification = computeArtifactVerification(bytes);
    expect(verification.byteSize).toBe(bytes.byteLength);
    expect(verification.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts matching bytes', () => {
    const bytes = Buffer.from('hello release');
    const verification = computeArtifactVerification(bytes);
    expect(verifyArtifactBytes(bytes, verification)).toEqual({ ok: true });
  });

  it('rejects a size mismatch', () => {
    const bytes = Buffer.from('hello');
    const verification = { byteSize: 100, sha256: computeArtifactVerification(bytes).sha256 };
    expect(verifyArtifactBytes(bytes, verification)).toMatchObject({
      ok: false,
      reason: 'artifact byte size mismatch',
    });
  });

  it('rejects a hash mismatch', () => {
    const bytes = Buffer.from('hello');
    const verification = { byteSize: bytes.byteLength, sha256: '0'.repeat(64) };
    expect(verifyArtifactBytes(bytes, verification)).toMatchObject({
      ok: false,
      reason: 'artifact sha256 mismatch',
    });
  });
});
