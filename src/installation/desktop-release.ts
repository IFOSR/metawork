import { createHash, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonicalizeReleaseManifestPayload, parseReleaseManifest } from './release-manifest.js';

const pathSchema = z.string().min(1).max(1024).refine(value => !isAbsolute(value)
  && !value.split('/').some(part => part === '..' || part === '.' || !part)
  && !value.includes('\\') && !value.includes('\0'));
const fileHashSchema = { sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative() };
const darwinFileSchema = z.object({ ...fileHashSchema, executable: z.boolean() }).strict();
const windowsFileSchema = z.object({ ...fileHashSchema, format: z.enum(['data', 'pe-x64']) }).strict();
const windowsPathSchema = pathSchema.refine(value => value.split('/').every(part =>
  !/[<>:"|?*\u0000-\u001f]/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)));
const releaseFields = {
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  desktopVersion: z.string().min(1),
  electronVersion: z.string().min(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  development: z.boolean(),
  nodeVersion: z.string().regex(/^22\.\d+\.\d+$/u).refine(value => Number(value.split('.')[1]) >= 19), nodeAbi: z.literal('127'),
  gatewayProtocolVersion: z.literal(2),
  capabilities: z.array(z.string()).refine(values => values.includes('desktop-session-v1')),
  runtimeManifest: z.unknown(),
  signature: z.object({ algorithm: z.literal('ed25519'), keyId: z.string().min(1), value: z.string().min(1) }).strict(),
};
export const DesktopReleaseSchema = z.discriminatedUnion('platform', [
  z.object({ ...releaseFields, platform: z.literal('darwin'), arch: z.enum(['arm64', 'x64']),
    files: z.record(pathSchema, darwinFileSchema) }).strict(),
  z.object({ ...releaseFields, platform: z.literal('win32'), arch: z.literal('x64'),
    files: z.record(windowsPathSchema, windowsFileSchema) }).strict(),
]);
export type DesktopRelease = z.infer<typeof DesktopReleaseSchema>;
type DarwinInventory = Record<string, z.infer<typeof darwinFileSchema>>;
type WindowsInventory = Record<string, z.infer<typeof windowsFileSchema>>;

export async function hashReleaseFile(path: string): Promise<{ sha256: string; size: number; executable: boolean }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('Desktop payload must contain regular files');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: info.size, executable: (info.mode & 0o111) !== 0 };
}

export function desktopInventory(root: string, platform?: 'darwin'): Promise<DarwinInventory>;
export function desktopInventory(root: string, platform: 'win32'): Promise<WindowsInventory>;
export function desktopInventory(root: string, platform: 'darwin' | 'win32'): Promise<DesktopRelease['files']>;
export async function desktopInventory(root: string, platform: 'darwin' | 'win32' = 'darwin'): Promise<DesktopRelease['files']> {
  const files: DesktopRelease['files'] = Object.create(null);
  const windowsNames = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      (platform === 'win32' ? windowsPathSchema : pathSchema).parse(name);
      if (platform === 'win32') {
        const folded = name.toUpperCase();
        if (windowsNames.has(folded)) throw new Error('Desktop Windows payload has case-colliding paths');
        windowsNames.add(folded);
      }
      if (entry.isDirectory()) await visit(path);
      else {
        if (!entry.isFile()) throw new Error('Desktop payload cannot contain links or special files');
        const file = await hashReleaseFile(path);
        files[name] = platform === 'win32'
          ? { sha256: file.sha256, size: file.size, format: await windowsFileFormat(path, file.size) }
          : file;
      }
    }
  }
  await visit(root);
  return files;
}

/** Verify before executing any bundled helper or touching an installed release. */
export async function verifyDesktopRelease(resources: string, options: {
  trustedKeys: Record<string, string>; platform: string; arch: string; desktopVersion: string;
  allowDevelopment?: boolean;
}): Promise<DesktopRelease> {
  const release = DesktopReleaseSchema.parse(JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8')));
  if (release.platform !== options.platform || release.arch !== options.arch || release.desktopVersion !== options.desktopVersion
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
  const inventory = await desktopInventory(payload, release.platform);
  if (JSON.stringify(Object.keys(inventory).sort()) !== JSON.stringify(Object.keys(release.files).sort())) throw new Error('Desktop payload file set mismatch');
  for (const [path, actual] of Object.entries(inventory)) {
    const expected = release.files[path]!;
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
      throw new Error('Desktop payload integrity mismatch');
    }
  }
  const shared = ['metawork/dist/index.js', 'metawork/dist/desktop-install-cli.js',
    'metawork/dist/desktop-update-cli.js', 'metawork/web/dist/index.html',
    'planner/packages/coding-agent/dist/cli.js'];
  const nativeTools = release.platform === 'darwin'
    ? ['metawork/desktop-tools/node/bin/node', 'metawork/desktop-tools/git/bin/git', 'metawork/desktop-tools/executor/bin/pi']
    : ['metawork/desktop-tools/node/node.exe', 'metawork/desktop-tools/git/cmd/git.exe',
      'metawork/desktop-tools/git/bin/bash.exe', 'metawork/dist/pi-pdf/python/python.exe',
      'metawork/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'metawork/native/windows/metawork-platform.node'];
  const windowsScripts = release.platform === 'win32'
    ? ['metawork/desktop-tools/executor/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', 'metawork/dist/pi-pdf/index.ts'] : [];
  for (const required of [...shared, ...nativeTools, ...windowsScripts]) {
    if (!inventory[required]) throw new Error('Required Desktop runtime dependency is missing');
  }
  for (const executable of nativeTools) {
    const file = inventory[executable]!;
    if ('executable' in file ? !file.executable : file.format !== 'pe-x64') {
      throw new Error('Desktop runtime tool is not executable for the target platform');
    }
  }
  if (release.platform === 'win32') {
    for (const tool of ['node', 'git', 'executor']) {
      if (!Object.keys(inventory).some(path => path.startsWith(`metawork/desktop-tools/${tool}/`)
        && /(?:^|\/)(?:licen[sc]e|copying|notice)[^/]*$/iu.test(path))) throw new Error(`Missing ${tool} license notices`);
    }
  }
  return release;
}

/** PE header checks establish file format/architecture, not runtime dependency closure. */
async function windowsFileFormat(path: string, size: number): Promise<'data' | 'pe-x64'> {
  const handle = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) {
      if (/\.(?:exe|dll|node|pyd)$/iu.test(path)) throw new Error('Windows native file is not PE');
      return 'data';
    }
    const offset = dos.readUInt32LE(0x3c);
    if (size < 64 || offset < 64 || offset > size - 26) throw new Error('Invalid Windows PE header');
    const pe = Buffer.alloc(26);
    await handle.read(pe, 0, pe.length, offset);
    const sections = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664
      || pe.readUInt16LE(24) !== 0x20b || !(pe.readUInt16LE(22) & 2)
      || !sections || sections > 96 || optionalSize < 112
      || offset + 24 + optionalSize + sections * 40 > size) {
      throw new Error('Windows native file is not a valid x64 PE image');
    }
    return 'pe-x64';
  } finally { await handle.close(); }
}
