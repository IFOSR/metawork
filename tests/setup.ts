import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

let activeInstallRoot: string | null = null;
let previousEnvironment: Record<string, string | undefined> | null = null;

process.env.OPENAI_BASE_URL ??= 'http://127.0.0.1:1/v1';
process.env.OPENAI_API_KEY ??= 'metaclaw-test-placeholder';

beforeEach(() => {
  const installRoot = mkdtempSync(join(tmpdir(), `anyfusion-vitest-${process.pid}-`));
  const workspaceSource = join(installRoot, 'workspace-source');
  mkdirSync(workspaceSource, { recursive: true });
  writeFileSync(join(workspaceSource, 'README.md'), '# AnyFusion test workspace\n');

  previousEnvironment = {
    ANYFUSION_INSTALL_ROOT: process.env.ANYFUSION_INSTALL_ROOT,
    ANYFUSION_SECRET_STORE: process.env.ANYFUSION_SECRET_STORE,
    ANYFUSION_TEST_WORKSPACE_SOURCE: process.env.ANYFUSION_TEST_WORKSPACE_SOURCE,
  };
  process.env.ANYFUSION_INSTALL_ROOT = installRoot;
  process.env.ANYFUSION_SECRET_STORE = 'file';
  process.env.ANYFUSION_TEST_WORKSPACE_SOURCE = workspaceSource;
  activeInstallRoot = installRoot;
});

afterEach(() => {
  if (previousEnvironment) {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previousEnvironment = null;
  }
  if (activeInstallRoot) {
    rmSync(activeInstallRoot, { recursive: true, force: true });
    activeInstallRoot = null;
  }
});
