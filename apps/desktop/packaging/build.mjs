import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await build({ entryPoints: ['main/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], sourcemap: true });
await build({ entryPoints: ['preload/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({ entryPoints: ['../../src/installation/desktop-release.ts'], outfile: 'dist/release-tools.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22' });
