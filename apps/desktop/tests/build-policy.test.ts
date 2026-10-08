import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allowDevelopmentPayload } from '../shared/build-policy.js';

describe('Windows internal distribution policy', () => {
  it('does not trust a development descriptor without the build flag', () => {
    expect(allowDevelopmentPayload(true, 'win32')).toBe(false);
    expect(allowDevelopmentPayload(false, 'win32')).toBe(false);
    expect(allowDevelopmentPayload(true, 'darwin')).toBe(true);
    expect(allowDevelopmentPayload(false, 'darwin')).toBe(false);
  });

  it.each([false, true])('bakes internal=%s into Main independently of runtime environment', async internal => {
    const source = fileURLToPath(new URL('../shared/build-policy.ts', import.meta.url));
    const result = await build({ stdin: { contents: `import { allowDevelopmentPayload } from ${JSON.stringify(source)};
      console.log(JSON.stringify([allowDevelopmentPayload(true, 'win32'), allowDevelopmentPayload(false, 'win32')]));`,
      resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
      define: { METAWORK_INTERNAL_WINDOWS_BUILD: String(internal) } });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', result.outputFiles[0]!.text],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, METAWORK_DESKTOP_INTERNAL: internal ? '0' : '1' } });
    expect(JSON.parse(output)).toEqual([internal, internal]);
  });
});
