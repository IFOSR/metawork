#!/usr/bin/env node
// Release gate: a Desktop payload must actually be able to update an existing
// installation before it is published. See scripts/desktop-update-gate.ts.
//
// Usage: node scripts/verify-desktop-update.mjs <payload-resources> <previous-install-root>
//   <payload-resources>       extracted MetaWork.app/Contents/Resources of the candidate DMG,
//                             or apps/desktop/release/mac-arm64/MetaWork.app/Contents/Resources
//   <previous-install-root>   an installation root whose app/current is the release to upgrade from
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const resources = process.argv[2];
const previousRoot = process.argv[3];
if (!resources || !previousRoot) {
  throw new Error('Usage: verify-desktop-update.mjs <payload-resources> <previous-install-root>');
}
// The repository runner is `tsx`; `vite-node` is not an installed dependency.
execFileSync(resolve('node_modules/.bin/tsx'),
  [resolve('scripts/desktop-update-gate.ts'), resolve(resources), resolve(previousRoot)],
  { stdio: 'inherit' });
