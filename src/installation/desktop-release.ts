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
const windowsFileSchema = z.object({ ...fileHashSchema, format: z.enum(['data', 'pe-x64', 'pe-managed', 'pe-x86']) }).strict();
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

/** Validate archive names before extraction, using the target filesystem rules. */
export function validateDesktopArchivePath(path: string, platform: 'darwin' | 'win32'): void {
  (platform === 'win32' ? windowsPathSchema : pathSchema).parse(path.replace(/\/$/u, ''));
}

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
  const pending: Array<{ path: string; name: string }> = [];
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
        pending.push({ path, name });
      }
    }
  }
  await visit(root);
  // A production payload contains tens of thousands of small files. Hashing
  // each one serially makes a fresh Windows launch spend several minutes in
  // the connecting state. Keep a bounded worker pool so integrity validation
  // remains complete while allowing the filesystem to make progress.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const item = pending[index];
      if (!item) return;
      const file = await hashReleaseFile(item.path);
      files[item.name] = platform === 'win32'
        ? { sha256: file.sha256, size: file.size, format: await windowsFileFormat(item.path, file.size) }
        : file;
    }
  };
  await Promise.all(Array.from({ length: Math.min(24, pending.length) }, () => worker()));
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
  const unapprovedX86 = Object.entries(inventory).filter(([path, file]) => 'format' in file && file.format === 'pe-x86'
    && path !== 'metawork/desktop-tools/git/usr/libexec/getprocaddr32.exe').map(([path]) => path);
  if (unapprovedX86.length) throw new Error(`Unapproved x86 Desktop dependencies: ${unapprovedX86.join(', ')}`);
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
async function windowsFileFormat(path: string, size: number): Promise<'data' | 'pe-x64' | 'pe-managed' | 'pe-x86'> {
  const handle = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) {
      if (/\.(?:exe|dll|node|pyd)$/iu.test(path)) throw new Error(`Windows native file is not PE: ${path}`);
      return 'data';
    }
    const offset = dos.readUInt32LE(0x3c);
    if (size < 64 || offset < 64 || offset > size - 26) throw new Error(`Invalid Windows PE header: ${path}`);
    const pe = Buffer.alloc(26);
    await handle.read(pe, 0, pe.length, offset);
    const sections = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    if (pe.readUInt32LE(0) !== 0x4550 || !(pe.readUInt16LE(22) & 2)
      || !sections || sections > 96 || optionalSize < 96
      || offset + 24 + optionalSize + sections * 40 > size) {
      throw new Error(`Windows native file is not a valid x64 PE image: ${path}`);
    }
    if (pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b && optionalSize >= 112) return 'pe-x64';
    // Git Credential Manager includes pure-IL AnyCPU assemblies with PE32/I386
    // headers. They are not x86 native libraries. Require a bounded CLR header
    // and metadata, ILONLY, and no 32-bit/native-entrypoint requirements.
    if (pe.readUInt16LE(4) === 0x14c && pe.readUInt16LE(24) === 0x10b && optionalSize >= 224) {
      const headers = Buffer.alloc(optionalSize + sections * 40);
      await handle.read(headers, 0, headers.length, offset + 24);
      if (headers.readUInt32LE(92) < 15 || headers.readUInt32LE(96 + 14 * 8) === 0) return 'pe-x86';
      const mapRva = (rva: number, length: number): number | undefined => {
        if (!rva || !length) return undefined;
        const matches: number[] = [];
        for (let index = 0; index < sections; index++) {
          const start = optionalSize + index * 40;
          const virtual = headers.readUInt32LE(start + 12);
          const rawSize = headers.readUInt32LE(start + 16);
          const raw = headers.readUInt32LE(start + 20);
          const delta = rva - virtual;
          if (delta >= 0 && delta + length <= rawSize && raw + delta + length <= size) matches.push(raw + delta);
        }
        return matches.length === 1 ? matches[0] : undefined;
      };
      const clrSize = headers.readUInt32LE(96 + 14 * 8 + 4);
      const clrOffset = headers.readUInt32LE(92) >= 15 && clrSize >= 72
        ? mapRva(headers.readUInt32LE(96 + 14 * 8), clrSize) : undefined;
      if (clrOffset !== undefined) {
        const clr = Buffer.alloc(72); await handle.read(clr, 0, clr.length, clrOffset);
        const flags = clr.readUInt32LE(16);
        const metadataSize = clr.readUInt32LE(12);
        const metadata = metadataSize >= 16 ? mapRva(clr.readUInt32LE(8), metadataSize) : undefined;
        if (clr.readUInt32LE(0) >= 72 && clr.readUInt32LE(0) <= clrSize
          && (flags & 1) !== 0 && (flags & (2 | 0x10 | 0x20000)) === 0 && metadata !== undefined) {
          const signature = Buffer.alloc(4); await handle.read(signature, 0, 4, metadata);
          if (signature.toString('ascii') === 'BSJB') return 'pe-managed';
        }
      }
    }
    throw new Error(`Windows native file is not a valid x64 PE image or AnyCPU assembly: ${path}`);
  } finally { await handle.close(); }
}
