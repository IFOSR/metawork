#!/usr/bin/env node
// Build the relocatable Node tree shipped inside Desktop Runtime. Node's
// executable is self-contained for the supported macOS distributions; npm,
// corepack, headers and bundled developer modules are not runtime inputs.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('Usage: node scripts/prepare-node-runtime.mjs SOURCE_NODE_ROOT OUTPUT_NODE_ROOT');
}

const source = resolve(sourceArg);
const output = resolve(outputArg);
const node = join(source, 'bin', 'node');
if (!existsSync(node)) throw new Error(`Node executable not found: ${node}`);

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'bin'), { recursive: true });
await cp(node, join(output, 'bin', 'node'));
for (const file of ['LICENSE', 'README.md']) {
  if (existsSync(join(source, file))) await cp(join(source, file), join(output, file));
}
if (existsSync(join(source, 'share'))) {
  await cp(join(source, 'share'), join(output, 'share'), { recursive: true });
}
process.stdout.write(`Prepared minimal Node runtime: ${output}\n`);
