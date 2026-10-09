import { describe, expect, it } from 'vitest';
import { desktopInstallFailure } from '../../src/installation/desktop-install-progress.js';

describe('Bounded installation failure diagnostics', () => {
  it('keeps Win32 codes across cleanup failures without messages or local paths', () => {
    const native = new Error('create private relative symlink failed, Win32=1314');
    native.stack = 'Error: provider-secret\n    at replaceRelativeSymlink (file:///private/provider-secret/file.js:1:2)';
    const cleanup = Object.assign(new Error('provider-secret'), { code: 'EPERM' });
    const report = desktopInstallFailure(new AggregateError([native, cleanup], 'provider-secret'));
    expect(report).toMatchObject({ causes: [{ win32: 1314, frames: ['replaceRelativeSymlink'] }, { code: 'EPERM' }] });
    expect(JSON.stringify(report)).not.toContain('provider-secret');
    expect(JSON.stringify(report)).not.toContain('/private');
  });
  it('bounds recursive aggregate errors and ignores unrecognized error codes', () => {
    const error = new AggregateError([], 'secret');
    error.errors.push(error);
    expect(JSON.stringify(desktopInstallFailure(error)).length).toBeLessThan(2048);
    expect(desktopInstallFailure(Object.assign(new Error('secret'), { code: 'secret' })))
      .toMatchObject({ code: 'INSTALLATION_FAILED' });
  });
});
