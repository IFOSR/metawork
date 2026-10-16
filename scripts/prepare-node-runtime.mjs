#!/usr/bin/env node
// Build the relocatable Node tree shipped inside Desktop Runtime. Node's
// executable is self-contained for the supported macOS distributions; npm,
// corepack, headers and bundled developer modules are not runtime inputs.
import { cp, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareNodeRuntime(sourceArg, outputArg) {
  const source = resolve(sourceArg);
  const output = resolve(outputArg);
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (contains(source, output) || contains(output, source)) {
    throw new Error('Node source and output must be separate trees');
  }
  // The supported macOS Node distribution is self-contained. Never inherit
  // globally installed CLIs, npm/corepack, headers or arbitrary share resources.
  for (const file of ['bin/node', 'LICENSE']) {
    if (!(await stat(join(source, file))).isFile()) throw new Error(`Missing Node runtime file: ${file}`);
  }
  // Refuse existing output rather than deleting a caller-supplied directory.
  await mkdir(output, { recursive: false });
  await mkdir(join(output, 'bin'));
  await cp(join(source, 'bin/node'), join(output, 'bin/node'), { dereference: true });
  for (const file of ['LICENSE', 'README.md']) {
    if (existsSync(join(source, file))) await cp(join(source, file), join(output, file), { dereference: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) {
    throw new Error('Usage: node scripts/prepare-node-runtime.mjs SOURCE_NODE_ROOT OUTPUT_NODE_ROOT');
  }
  await prepareNodeRuntime(source, output);
  process.stdout.write(`Prepared minimal Node runtime: ${resolve(output)}\n`);
}
