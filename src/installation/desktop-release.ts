import { createHash, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonicalizeReleaseManifestPayload, parseReleaseManifest } from './release-manifest.js';

const pathSchema = z.string().min(1).max(1024).refine(value => !isAbsolute(value)
  && !value.split('/').some(part => part === '..' || part === '.' || !part)
  && !value.includes('\\') && !value.includes('\0'));
export const DesktopReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  desktopVersion: z.string().min(1),
  electronVersion: z.string().min(1),
  platform: z.literal('darwin'), arch: z.enum(['arm64', 'x64']),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  development: z.boolean(),
  nodeVersion: z.string().regex(/^22\.\d+\.\d+$/u).refine(value => Number(value.split('.')[1]) >= 19), nodeAbi: z.literal('127'),
  gatewayProtocolVersion: z.literal(2),
  capabilities: z.array(z.string()).refine(values => values.includes('desktop-session-v1')),
  runtimeManifest: z.unknown(),
  files: z.record(pathSchema, z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative(), executable: z.boolean() }).strict()),
  signature: z.object({ algorithm: z.literal('ed25519'), keyId: z.string().min(1), value: z.string().min(1) }).strict(),
}).strict();
export type DesktopRelease = z.infer<typeof DesktopReleaseSchema>;

export async function hashReleaseFile(path: string): Promise<{ sha256: string; size: number; executable: boolean }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('Desktop payload must contain regular files');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: info.size, executable: (info.mode & 0o111) !== 0 };
}

export async function desktopInventory(root: string): Promise<DesktopRelease['files']> {
  const files: DesktopRelease['files'] = Object.create(null);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        if (!entry.isFile()) throw new Error('Desktop payload cannot contain links or special files');
        const name = relative(root, path).split(sep).join('/');
        pathSchema.parse(name);
        files[name] = await hashReleaseFile(path);
      }
    }
  }
  await visit(root);
  return files;
}

/** Verify before executing any bundled helper or touching an installed release. */
export async function verifyDesktopRelease(resources: string, options: {
  trustedKeys: Record<string, string>; arch: string; desktopVersion: string;
  allowDevelopment?: boolean;
}): Promise<DesktopRelease> {
  const release = DesktopReleaseSchema.parse(JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8')));
  if (release.arch !== options.arch || release.desktopVersion !== options.desktopVersion
    || (release.development && !options.allowDevelopment)) throw new Error('Desktop release compatibility mismatch');
  const key = options.trustedKeys[release.signature.keyId];
  if (!key || !verify(null, Buffer.from(canonicalizeReleaseManifestPayload(release)), key, Buffer.from(release.signature.value, 'base64'))) {
    throw new Error('Desktop release signature rejected');
  }
  const runtime = parseReleaseManifest(release.runtimeManifest);
  if (runtime.releaseId !== release.releaseId || runtime.platform !== release.platform || runtime.arch !== release.arch
    || !release.sourceCommit.startsWith(runtime.metawork.revision)
    || Date.parse(runtime.expiresAt) <= Date.now()) throw new Error('Desktop runtime matrix mismatch');
  const runtimeKey = options.trustedKeys[runtime.signature.keyId];
  if (!runtimeKey || !verify(null, Buffer.from(canonicalizeReleaseManifestPayload(runtime)), runtimeKey, Buffer.from(runtime.signature.value, 'base64'))) {
    throw new Error('Runtime release signature rejected');
  }
  const payload = await realpath(join(resources, 'payload'));
  const inventory = await desktopInventory(payload);
  if (JSON.stringify(Object.keys(inventory).sort()) !== JSON.stringify(Object.keys(release.files).sort())) throw new Error('Desktop payload file set mismatch');
  for (const [path, actual] of Object.entries(inventory)) {
    const expected = release.files[path]!;
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.executable !== expected.executable) {
      throw new Error('Desktop payload integrity mismatch');
    }
  }
  for (const required of ['metawork/dist/index.js', 'metawork/dist/desktop-install-cli.js',
    'metawork/dist/desktop-update-cli.js', 'metawork/web/dist/index.html',
    'metawork/desktop-tools/node/bin/node', 'metawork/desktop-tools/git/bin/git',
    'metawork/desktop-tools/executor/bin/pi', 'planner/packages/coding-agent/dist/cli.js']) {
    if (!inventory[required]) throw new Error('Required Desktop runtime dependency is missing');
  }
  for (const executable of ['metawork/desktop-tools/node/bin/node', 'metawork/desktop-tools/git/bin/git',
    'metawork/desktop-tools/executor/bin/pi']) {
    if (!inventory[executable]?.executable) throw new Error('Desktop runtime tool is not executable');
  }
  return release;
}
