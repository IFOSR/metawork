import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';

const acceptance = process.env.RUN_INSTALLED_OBSERVATION === '1' ? describe : describe.skip;
acceptance('isolated installed release observation', () => {
  it('runs the installed native TUI against its installed Server and checks release identity', async () => {
    const server = await startProductionObservationServer({ installed: true });
    const native = spawn(process.execPath, [join(server.applicationRoot, 'planner/packages/coding-agent/dist/cli.js'),
      '--gateway-socket', server.endpoint.unixSocketPath, '--conversation-id', 'conv_acceptance_10'],
    { env: { ...server.env, COLUMNS: '140', LINES: '40' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    native.stdout.on('data', data => { output = (output + String(data)).slice(-64 * 1024); });
    native.stderr.on('data', data => { errors = (errors + String(data)).slice(-2048); });
    try {
      expect(await realpath(join(server.root, 'app/current'))).toBe(await realpath(server.applicationRoot));
      const identity = JSON.parse(await readFile(join(server.applicationRoot, 'release-identity.json'), 'utf8'));
      expect(identity).toMatchObject({ releaseId: 'observation-local-acceptance', gatewayProtocolVersion: 2 });
      expect(server.endpoint.releaseId).toBe(identity.releaseId);
      await vi.waitFor(() => {
        if (native.exitCode !== null) throw new Error(`native exit ${native.exitCode}: ${errors}`);
        expect(output).toContain('RESULT_10');
      }, { timeout: 20000 });
      expect(output).not.toContain('capability_mismatch');
    } finally {
      native.kill('SIGTERM');
      if (native.exitCode === null && native.signalCode === null) await new Promise<void>(done => native.once('exit', () => done()));
      await server.close();
    }
  }, 240_000);
});
