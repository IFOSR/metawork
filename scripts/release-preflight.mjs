import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TRUSTED_PUBLIC_KEY } from './verify-release-assets.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
for (const root of ['.', 'web', 'apps/desktop']) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
  if (pkg.version !== version || lock.version !== version || lock.packages[''].version !== version) {
    throw new Error(`Release version mismatch in ${root}`);
  }
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag and package version must match');
}
const required = ['RELEASE_KEY', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_ID',
  'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'CSC_NAME', 'ARM64_URL', 'ARM64_SHA256', 'X64_URL', 'X64_SHA256'];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error(`Release configuration is missing: ${missing.join(', ')}`);
for (const arch of ['ARM64', 'X64']) {
  if (new URL(process.env[`${arch}_URL`]).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(process.env[`${arch}_SHA256`])) {
    throw new Error(`Invalid reviewed tool distribution configuration for ${arch}`);
  }
}
if (createPublicKey(process.env.RELEASE_KEY).export({ type: 'spki', format: 'pem' }).trim() !== TRUSTED_PUBLIC_KEY.trim()) {
  throw new Error('Release signing key does not match the installed trust root');
}
readFileSync(`docs/releases/v${version}.md`);
console.log(`Release v${version} prerequisites are present`);
