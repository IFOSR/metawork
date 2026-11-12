#!/usr/bin/env node
// Packages a prebuilt MetaWork release for the curl|bash installer path:
// runtime + vendored Planner tarballs plus an Ed25519-signed manifest whose
// schema matches scripts/install.sh and src/installation/release-manifest.ts.
//
// Usage:
//   node scripts/package-release.mjs [options]
//
// Options:
//   --source-root <dir>      Repository root (default: script parent)
//   --source-meta-root <dir>  Source tree for version metadata such as the
//                            database schema version (default: script parent)
//   --planner-root <dir>     Vendored Planner root (default: <source>/planner/AnyFusion-Pi)
//   --pi-command <cmd>       Upstream Pi executable to package (default: pi)
//   --memory-root <dir>      Memory engine tree, TDAI MemoryCore (default:
//                            $METAWORK_MEMORY_ENGINE_ROOT or <source>/memory/tdai).
//                            Must contain a compiled dist/gateway/server.js.
//   --memory-source <url>    Upstream source recorded in the manifest
//   --memory-revision <rev>  Upstream revision recorded in the manifest
//   --out-dir <dir>          Output directory (default: <source>/dist-release)
//   --channel <name>         Release channel (default: stable)
//   --release-id <id>        Release ID (default: stable build ID or <version>-preview.N)
//   --preview-number <n>     Required for --channel preview when package.json is stable
//   --key-id <id>            Signing key ID (default: metawork-release-2026-03)
//   --signing-key <path>     Ed25519 private key PEM (or env METAWORK_RELEASE_SIGNING_KEY)
//   --generate-dev-key <prefix>
//                            Write an Ed25519 dev key pair to <prefix>.{private,public}.pem
//                            and exit (testing only; never publish releases signed with it)
//   --validity-days <n>      Manifest validity window (default: 90)
//   --artifact-base-url <u>  URL prefix for artifact URLs (default: ./ relative)
//   --platform <name>        Override packaged platform (darwin|linux|win32)
//   --arch <name>            Override packaged arch (x64|arm64); use together
//                            with --platform to cross-package a tree whose
//                            native modules were swapped for the target
//                            platform's prebuilds
//   --compat <json>          Override the release compatibility block
//
// The caller is responsible for producing a production-only node_modules tree
// (for example `npm ci --omit=dev`) before packaging. The archive inputs below
// are an explicit runtime allowlist; the development workspace is never
// shipped verbatim into a release tarball.
import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePiRuntimePin } from './lib/pi-runtime-pin.mjs';
import { stagePackagedPi } from './lib/packaged-pi.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = {
    sourceRoot: resolve(scriptDir, '..'),
    sourceMetaRoot: undefined,
    plannerRoot: undefined,
    piCommand: undefined,
    piPinPath: undefined,
    memoryRoot: undefined,
    memorySource: undefined,
    memoryRevision: undefined,
    outDir: undefined,
    channel: 'stable',
    releaseId: undefined,
    previewNumber: undefined,
    keyId: 'metawork-release-2026-03',
    signingKeyPath: undefined,
    generateDevKeyPrefix: undefined,
    validityDays: 90,
    artifactBaseUrl: '.',
    platformOverride: undefined,
    archOverride: undefined,
    compat: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    const requireValue = () => {
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--source-root': options.sourceRoot = resolve(requireValue()); break;
      case '--source-meta-root': options.sourceMetaRoot = resolve(requireValue()); break;
      case '--planner-root': options.plannerRoot = resolve(requireValue()); break;
      case '--pi-command': options.piCommand = requireValue(); break;
      case '--pi-pin': options.piPinPath = resolve(requireValue()); break;
      case '--memory-root': options.memoryRoot = resolve(requireValue()); break;
      case '--memory-source': options.memorySource = requireValue(); break;
      case '--memory-revision': options.memoryRevision = requireValue(); break;
      case '--out-dir': options.outDir = resolve(requireValue()); break;
      case '--channel': options.channel = requireValue(); break;
      case '--release-id': options.releaseId = requireValue(); break;
      case '--preview-number': options.previewNumber = Number(requireValue()); break;
      case '--key-id': options.keyId = requireValue(); break;
      case '--signing-key': options.signingKeyPath = resolve(requireValue()); break;
      case '--generate-dev-key': options.generateDevKeyPrefix = requireValue(); break;
      case '--validity-days': options.validityDays = Number(requireValue()); break;
      case '--artifact-base-url': options.artifactBaseUrl = requireValue(); break;
      case '--platform': options.platformOverride = requireValue(); break;
      case '--arch': options.archOverride = requireValue(); break;
      case '--compat': options.compat = requireValue(); break;
      default: throw new Error(`unknown option: ${argument}`);
    }
  }
  options.plannerRoot ??= join(options.sourceRoot, 'planner', 'AnyFusion-Pi');
  options.memoryRoot ??= process.env.METAWORK_MEMORY_ENGINE_ROOT
    ? resolve(process.env.METAWORK_MEMORY_ENGINE_ROOT)
    : join(options.sourceRoot, 'memory', 'tdai');
  options.sourceMetaRoot ??= resolve(scriptDir, '..');
  options.outDir ??= join(options.sourceRoot, 'dist-release');
  return options;
}

export function platformName(platform = process.platform) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  throw new Error(`unsupported packaging platform: ${platform}`);
}

export function architectureName(architecture = process.arch) {
  if (architecture === 'x64') return 'x64';
  if (architecture === 'arm64') return 'arm64';
  throw new Error(`unsupported packaging architecture: ${architecture}`);
}

export function archiveExtension(platform) {
  if (platform === 'win32') return '.zip';
  if (platform === 'darwin' || platform === 'linux') return '.tar.gz';
  throw new Error(`unsupported archive platform: ${platform}`);
}

export function archiveName(kind, releaseId, platform, arch) {
  if (kind !== 'metawork' && kind !== 'planner' && kind !== 'memory' && kind !== 'pi') {
    throw new Error(`unsupported release artifact: ${kind}`);
  }
  return `${kind}-${releaseId}-${platform}-${arch}${archiveExtension(platform)}`;
}

/** Release IDs for preview artifacts are ordered SemVer prereleases. */
export function previewReleaseId(packageVersion, previewNumber) {
  if (!Number.isSafeInteger(previewNumber) || previewNumber < 1) {
    throw new Error(`preview number must be a positive integer: ${previewNumber}`);
  }
  return `${packageVersion}-preview.${previewNumber}`;
}

function assertReleaseIdentity({ channel, packageVersion, releaseId, previewNumber }) {
  const packagePreview = /^(.*)-preview\.(\d+)$/u.exec(packageVersion);
  const baseVersion = packagePreview?.[1] ?? packageVersion;
  const escapedVersion = baseVersion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const previewPattern = new RegExp(`^${escapedVersion}-preview\\.(\\d+)$`, 'u');
  const previewMatch = previewPattern.exec(releaseId);
  if (channel === 'preview') {
    if (previewNumber !== undefined) previewReleaseId(baseVersion, previewNumber);
    if (packagePreview && releaseId !== packageVersion) {
      throw new Error(`package.json preview version must match release ID: ${packageVersion}`);
    }
    if (previewNumber !== undefined) {
      const existingNumber = packagePreview?.[2] ?? previewMatch?.[1];
      if (existingNumber !== undefined && Number(existingNumber) !== previewNumber) {
        throw new Error(`preview number does not match release ID: expected ${previewNumber}`);
      }
    }
    if (previewMatch && Number(previewMatch[1]) >= 1) return;
    if (previewNumber !== undefined && releaseId === previewReleaseId(baseVersion, previewNumber)) return;
    throw new Error(`preview releases must use ${packageVersion}-preview.N`);
  }
  if (packagePreview) throw new Error('preview package versions require --channel preview');
  if (previewMatch) throw new Error('preview release IDs require --channel preview');
  if (previewNumber !== undefined) throw new Error('--preview-number requires --channel preview');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

function gitRevision(sourceRoot) {
  const result = spawnSync('git', ['-C', sourceRoot, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'source';
}

function gitSourceUrl(sourceRoot) {
  const result = spawnSync('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'https://github.com/IFOSR/metawork.git';
  const url = result.stdout.trim();
  return url.startsWith('git@github.com:')
    ? url.replace('git@github.com:', 'https://github.com/')
    : url;
}

function assertPackagableTree(options) {
  if (basename(options.memoryRoot) !== 'tdai') {
    throw new Error(
      `memory engine root must be a directory named "tdai" (got ${basename(options.memoryRoot)});`
      + ' every installer extracts it to <releaseRoot>/memory/tdai',
    );
  }
  const required = [
    join(options.sourceRoot, 'dist', 'install-cli.js'),
    join(options.sourceRoot, 'dist', 'planning-agent-plan-v9.schema.json'),
    join(options.sourceRoot, 'web', 'dist'),
    join(options.sourceRoot, 'node_modules'),
    ...(existsSync(options.plannerRoot) ? [
      join(options.plannerRoot, 'package.json'),
      join(options.plannerRoot, 'packages', 'coding-agent', 'dist'),
      join(options.plannerRoot, 'node_modules'),
    ] : []),
    join(options.memoryRoot, 'package.json'),
    join(options.memoryRoot, 'dist', 'gateway', 'server.js'),
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      throw new Error(
        `missing build output: ${path}; build first (npm run build, and the vendored Planner build)`,
      );
    }
  }
  const nativeSqliteBinary = join(
    options.sourceRoot,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!existsSync(nativeSqliteBinary)) {
    throw new Error(
      `missing native runtime dependency: ${nativeSqliteBinary}; `
      + 'run the target-native production dependency install before packaging',
    );
  }
}

const waitForExit = promisify((child, callback) => {
  child.on('exit', (code, signal) => {
    if (code === 0) callback(null);
    else callback(new Error(`process ${child.spawnfile} failed: code=${code} signal=${signal ?? ''}`));
  });
  child.on('error', callback);
});

const memoryArchiveExcludes = [
  '.DS_Store',
  '.git',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig*.json',
  'vitest.config.*',
  'eslint.config.*',
  'src',
  'scripts',
  'assets',
  'hermes-plugin',
  'README*',
  'CHANGELOG*',
  'index.ts',
  'openclaw.plugin.json',
  'node_modules/.bin',
  'node_modules/@types',
  'node_modules/@vitest',
  'node_modules/@vitest/**',
  'node_modules/@rolldown',
  'node_modules/@rolldown/**',
  'node_modules/esbuild',
  'node_modules/@esbuild',
  'node_modules/tsx',
  'node_modules/tsdown',
  'node_modules/typescript',
  'node_modules/vitest',
  '**/*.map',
  '**/*.d.ts',
  '**/test',
  '**/tests',
  '**/__tests__',
  '**/.git',
  '**/.cache',
  '**/.vite',
];

const runtimeArchiveExcludes = [
  '.DS_Store',
  'node_modules/.bin',
  'node_modules/@types',
  'node_modules/@vitest',
  'node_modules/@rolldown',
  'node_modules/esbuild',
  'node_modules/@esbuild',
  'node_modules/typescript',
  'node_modules/vitest',
  'node_modules/tsx',
  'node_modules/tsup',
  'node_modules/vite',
  'node_modules/rollup',
  '**/node_modules/.bin',
  '**/node_modules/@types',
  '**/node_modules/@vitest',
  '**/node_modules/@vitest/**',
  '**/node_modules/@rolldown',
  '**/node_modules/@rolldown/**',
  '**/node_modules/esbuild',
  '**/node_modules/@esbuild',
  '**/node_modules/typescript',
  '**/node_modules/vitest',
  '**/node_modules/tsx',
  '**/node_modules/tsup',
  '**/node_modules/vite',
  '**/node_modules/rollup',
  '**/*.map',
  '**/*.d.ts',
  '**/test',
  '**/tests',
  '**/__tests__',
  '**/fixtures',
  '**/examples',
  '**/.cache',
  '**/.vite',
  '**/.turbo',
  '**/.github',
  '**/.github/**',
  '**/docker',
  '**/docker/**',
];

const plannerArchiveExcludes = [
  '.git',
  '.DS_Store',
  '**/*.map',
  '**/*.d.ts',
  'src',
  'scripts',
  'test',
  'tests',
  'fixtures',
  'examples',
  'docs',
  '**/src',
  '**/scripts',
  '**/test',
  '**/tests',
  '**/fixtures',
  '**/examples',
  '**/docs',
  '**/.bin',
  '**/.cache',
  '**/.vite',
  '**/.turbo',
  'node_modules/@biomejs',
  'node_modules/@types',
  'node_modules/typescript',
  'node_modules/vitest',
  'node_modules/esbuild',
  'node_modules/tsx',
  'node_modules/tsgo',
  'node_modules/shx',
  'node_modules/husky',
];

// Copies selected entries into <staging>/<prefix>/ using a streaming tar pipe
// so the archive carries a single top-level directory (the installer extracts
// with --strip-components=1), so excludes work on both bsdtar and GNU tar, and
// so multi-hundred-megabyte dependency trees never buffer in memory.
async function packageArchive({ sourceRoot, stagingRoot, prefix, entries, exclude, outputPath, platform }) {
  mkdirSync(join(stagingRoot, prefix), { recursive: true });
  if (platform === 'win32') {
    const pack = spawn('tar', [
      '-C', sourceRoot,
      '-h',
      ...(exclude ?? []).flatMap(pattern => ['--exclude', pattern]),
      '-cf', '-',
      ...entries,
    ]);
    const unpack = spawn('tar', ['-C', join(stagingRoot, prefix), '-xf', '-']);
    let unpackError = '';
    unpack.stderr.on('data', chunk => { unpackError += chunk.toString('utf8'); });
    pack.stdout.pipe(unpack.stdin);
    const [packResult, unpackResult] = await Promise.allSettled([
      waitForExit(pack),
      waitForExit(unpack),
    ]);
    if (packResult.status === 'rejected') {
      throw new Error(`staging tar for ${prefix} failed: ${packResult.reason?.message ?? packResult.reason}`);
    }
    if (unpackResult.status === 'rejected') {
      throw new Error(`staging extract for ${prefix} failed: ${unpackResult.reason?.message ?? unpackResult.reason} ${unpackError}`);
    }
    run('tar', ['-a', '-cf', outputPath, '-C', stagingRoot, prefix]);
    return;
  }
  const pack = spawn('tar', [
    '-C', sourceRoot,
    // -h dereferences symlinks (npm workspace layouts create many) so the
    // archive is plain files and both bsdtar and GNU tar extract it safely.
    '-h',
    ...(exclude ?? []).flatMap(pattern => ['--exclude', pattern]),
    '-cf', '-',
    ...entries,
  ]);
  const unpack = spawn('tar', ['-C', join(stagingRoot, prefix), '-xf', '-']);
  let unpackError = '';
  unpack.stderr.on('data', chunk => { unpackError += chunk.toString('utf8'); });
  pack.stdout.pipe(unpack.stdin);
  const [packResult, unpackResult] = await Promise.allSettled([
    waitForExit(pack),
    waitForExit(unpack),
  ]);
  if (packResult.status === 'rejected') {
    throw new Error(`staging tar for ${prefix} failed: ${packResult.reason?.message ?? packResult.reason}`);
  }
  if (unpackResult.status === 'rejected') {
    throw new Error(`staging extract for ${prefix} failed: ${unpackResult.reason?.message ?? unpackResult.reason} ${unpackError}`);
  }
  run('tar', [
    '-C', stagingRoot,
    '--exclude', '.DS_Store',
    '-czf', outputPath,
    prefix,
  ]);
}

function sha256sum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableStringify(value) {
  // Keep in sync with src/installation/release-manifest.ts stableStringify,
  // which also matches the verifier embedded in scripts/install.sh.
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function currentDatabaseSchema(sourceRoot) {
  const schemaSource = readFileSync(join(sourceRoot, 'src', 'storage', 'current-schema.ts'), 'utf8');
  const match = /export const CURRENT_SCHEMA_VERSION = (\d+)/u.exec(schemaSource);
  if (!match) throw new Error('cannot determine CURRENT_SCHEMA_VERSION from src/storage/current-schema.ts');
  return Number(match[1]);
}

function defaultCompatibility(sourceRoot) {
  return {
    // configurationSchema: AnyFusionConfigurationV2 schemaVersion (src/configuration/types.ts)
    configurationSchema: 2,
    // plannerHostProtocol: anyfusion-planner-host-v2 driver contract
    plannerHostProtocol: 2,
    // planningPlanSchema: planning-agent-plan-v9
    planningPlanSchema: 8,
    planningPlanSchemaHash: 'planning-agent-plan-v9',
    // workGraphSchema / kernelDecisionSchema: release metadata reviewed per release
    workGraphSchema: 7,
    kernelDecisionSchema: 6,
    databaseSchema: currentDatabaseSchema(sourceRoot),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.generateDevKeyPrefix) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(`${options.generateDevKeyPrefix}.private.pem`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(`${options.generateDevKeyPrefix}.public.pem`, publicKey.export({ type: 'spki', format: 'pem' }));
    process.stdout.write(`dev key pair written to ${options.generateDevKeyPrefix}.{private,public}.pem\n`);
    process.stdout.write('WARNING: development key; do not use it for published releases.\n');
    return;
  }

  assertPackagableTree(options);
  const platform = options.platformOverride ?? platformName();
  const arch = options.archOverride ?? architectureName();
  const revision = gitRevision(options.sourceRoot);
  const sourceUrl = gitSourceUrl(options.sourceRoot);
  const packageVersion = JSON.parse(readFileSync(join(options.sourceRoot, 'package.json'), 'utf8')).version;
  const releaseId = options.releaseId
    ?? (options.channel === 'preview'
      ? /-preview\.\d+$/u.test(packageVersion)
        ? packageVersion
        : previewReleaseId(packageVersion, options.previewNumber)
      : `${packageVersion}-build-${revision}-${Date.now()}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
    throw new Error(`invalid release ID: ${releaseId}`);
  }
  assertReleaseIdentity({ channel: options.channel, packageVersion, releaseId, previewNumber: options.previewNumber });

  const stagingRoot = join(options.outDir, '.staging');
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const runtimeArchiveName = archiveName('metawork', releaseId, platform, arch);
  // The vendored Planner is optional now (ADR-0055 D6): a release that runs the
  // packaged Pi runtime does not ship a vendored planner tree at all.
  const vendorPlanner = existsSync(options.plannerRoot);
  const plannerArchiveName = vendorPlanner ? archiveName('planner', releaseId, platform, arch) : null;
  const memoryArchiveName = archiveName('memory', releaseId, platform, arch);
  await packageArchive({
    sourceRoot: options.sourceRoot,
    stagingRoot,
    prefix: 'metawork',
    entries: ['dist', 'web/dist', 'node_modules', 'package.json'],
    exclude: runtimeArchiveExcludes,
    outputPath: join(options.outDir, runtimeArchiveName),
    platform,
  });
  if (vendorPlanner) {
    await packageArchive({
      sourceRoot: options.plannerRoot,
      stagingRoot,
      prefix: 'planner',
      entries: [
        'package.json',
        'packages/coding-agent/package.json',
        'packages/coding-agent/dist',
        'packages/ai/package.json',
        'packages/ai/dist',
        'packages/agent/package.json',
        'packages/agent/dist',
        'packages/tui/package.json',
        'packages/tui/dist',
        'node_modules',
      ],
      exclude: plannerArchiveExcludes,
      outputPath: join(options.outDir, plannerArchiveName),
      platform,
    });
  }
  // ADR-0055 D6: the packaged upstream Pi runtime is pinned at build time and
  // archived with the release, so an install cannot drift to another Pi.
  const piPin = probePiRuntimePin({ command: options.piCommand });
  if (options.piPinPath) {
    const expected = JSON.parse(readFileSync(options.piPinPath, 'utf8'));
    if (['commandPath', 'releaseDir', 'version', 'packageVersion', 'lockSha256'].some(key => expected[key] !== piPin[key])) {
      throw new Error('Pi runtime changed after build-time pin');
    }
  }
  const piDistribution = join(stagingRoot, 'pi-distribution');
  await stagePackagedPi(piPin, piDistribution);
  const piArchiveName = archiveName('pi', releaseId, platform, arch);
  await packageArchive({
    sourceRoot: piDistribution,
    stagingRoot,
    prefix: 'pi',
    entries: ['.'],
    outputPath: join(options.outDir, piArchiveName),
    platform,
  });
  await packageArchive({
    sourceRoot: dirname(options.memoryRoot),
    stagingRoot,
    prefix: 'memory',
    entries: [basename(options.memoryRoot)],
    exclude: memoryArchiveExcludes,
    outputPath: join(options.outDir, memoryArchiveName),
    platform,
  });
  rmSync(stagingRoot, { recursive: true, force: true });

  const base = options.artifactBaseUrl.replace(/\/$/u, '');
  const lockSha256 = memoryLockSha256(options.memoryRoot);
  const manifest = {
    manifestSchemaVersion: 1,
    releaseId,
    channel: options.channel,
    publishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + options.validityDays * 86_400_000).toISOString(),
    minimumInstallerVersion: '1.2.0',
    minimumNodeVersion: '22.19.0',
    platform,
    arch,
    metawork: {
      source: sourceUrl,
      revision,
      url: base === '.' ? runtimeArchiveName : `${base}/${runtimeArchiveName}`,
      byteSize: statSize(join(options.outDir, runtimeArchiveName)),
      sha256: sha256sum(join(options.outDir, runtimeArchiveName)),
    },
    ...(vendorPlanner ? {
      planner: {
        source: sourceUrl,
        revision,
        url: base === '.' ? plannerArchiveName : `${base}/${plannerArchiveName}`,
        byteSize: statSize(join(options.outDir, plannerArchiveName)),
        sha256: sha256sum(join(options.outDir, plannerArchiveName)),
      },
    } : {}),
    pi: {
      version: piPin.version,
      ...(piPin.nodeEngine ? { nodeEngine: piPin.nodeEngine } : {}),
      ...(piPin.lockSha256 ? { lockSha256: piPin.lockSha256 } : {}),
      url: base === '.' ? piArchiveName : `${base}/${piArchiveName}`,
      byteSize: statSize(join(options.outDir, piArchiveName)),
      sha256: sha256sum(join(options.outDir, piArchiveName)),
    },
    memory: {
      source: options.memorySource ?? memorySourceUrl(options.memoryRoot),
      revision: options.memoryRevision ?? memoryRevision(options.memoryRoot),
      url: base === '.' ? memoryArchiveName : `${base}/${memoryArchiveName}`,
      byteSize: statSize(join(options.outDir, memoryArchiveName)),
      sha256: sha256sum(join(options.outDir, memoryArchiveName)),
      ...(lockSha256 ? { lockSha256 } : {}),
    },
    compatibility: options.compat
      ? JSON.parse(options.compat)
      : defaultCompatibility(options.sourceMetaRoot),
    previousCompatibleRelease: null,
  };

  const signingKeyPem = options.signingKeyPath
    ?? process.env.METAWORK_RELEASE_SIGNING_KEY;
  if (!signingKeyPem) {
    throw new Error(
      'a signing key is required: pass --signing-key <pem> or set METAWORK_RELEASE_SIGNING_KEY',
    );
  }
  const signatureValue = ed25519Sign(
    null,
    Buffer.from(stableStringify(manifest), 'utf8'),
    readFileSync(signingKeyPem, 'utf8'),
  );
  const signedManifest = {
    ...manifest,
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      value: signatureValue.toString('base64'),
    },
  };

  const manifestPath = join(options.outDir, `manifest.${platform}-${arch}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`);
  process.stdout.write([
    `release: ${releaseId} (${platform}-${arch}, channel ${options.channel})`,
    `runtime: ${runtimeArchiveName} (${signedManifest.metawork.byteSize} bytes)`,
    ...(vendorPlanner ? [`planner: ${plannerArchiveName} (${signedManifest.planner.byteSize} bytes)`] : []),
    `pi: ${piArchiveName} (${signedManifest.pi.byteSize} bytes)`,
    `memory: ${memoryArchiveName} (${signedManifest.memory.byteSize} bytes)`,
    `manifest: ${manifestPath}`,
    `signed by: ${options.keyId}`,
  ].join('\n'));
  process.stdout.write('\n');
}

/** Upstream revision of the memory engine; the release records it per artifact. */
function memoryRevision(memoryRoot) {
  const configured = process.env.METAWORK_MEMORY_ENGINE_REVISION?.trim();
  if (configured) return configured;
  const result = spawnSync('git', ['-C', memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function memorySourceUrl(memoryRoot) {
  const configured = process.env.METAWORK_MEMORY_ENGINE_SOURCE?.trim();
  if (configured) return configured;
  const result = spawnSync('git', ['-C', memoryRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (result.status !== 0) return 'https://github.com/TencentCloud/TencentDB-Agent-Memory.git';
  return result.stdout.trim();
}

/** SHA-256 of the engine dependency lockfile, so the shipped tree is reproducible. */
function memoryLockSha256(memoryRoot) {
  const path = join(memoryRoot, 'package-lock.json');
  return existsSync(path) ? sha256sum(path) : undefined;
}

function statSize(path) {
  return readFileSync(path).length;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    process.stderr.write(`package-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
