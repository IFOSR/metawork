// Loads the shipped Pi tool-call stall guard through the real system Pi
// extension loader, so `dist/pi-tool-stall` -> `dist/tool-stall-core.js`
// resolution, TypeScript loading and handler registration are verified against
// the actual installed Pi rather than a test double.
//
// Usage: METAWORK_PI_PACKAGE_ROOT=<system pi package> node scripts/check-pi-tool-stall.mjs
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const packageRoot = process.env.METAWORK_PI_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error('Set METAWORK_PI_PACKAGE_ROOT to the installed system Pi package (not the vendored Planner).');
}
const core = resolve(packageRoot, 'dist/core') + '/';
const { loadExtensions } = await import(pathToFileURL(core + 'extensions/loader.js'));
const { createEventBus } = await import(pathToFileURL(core + 'event-bus.js'));

const root = await mkdtemp(join(tmpdir(), 'tool-stall-acceptance-'));
process.env.METACLAW_TOOL_STALL_FACTS = join(root, 'facts.jsonl');

try {
  const loaded = await loadExtensions([resolve('dist/pi-tool-stall/index.ts')], root, createEventBus());
  assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
  const extension = loaded.extensions[0];
  assert.ok(extension, 'the stall guard extension must load');

  const registered = [...extension.handlers.keys()].sort();
  const required = [
    'tool_execution_end',
    'tool_execution_start',
    'tool_execution_update',
    'tool_result',
  ];
  for (const event of required) {
    assert.ok(registered.includes(event), `missing handler for ${event} (registered: ${registered.join(', ')})`);
  }
  console.log(`Loaded Pi tool stall guard (${registered.join(', ')}).`);
} finally {
  await rm(root, { recursive: true, force: true });
}
