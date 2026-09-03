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
//   --out-dir <dir>          Output directory (default: <source>/dist-release)
//   --channel <name>         Release channel (default: preview)
//   --release-id <id>        Release ID (default: <version>-build-<rev>-<epoch>)
//   --key-id <id>            Signing key ID (default: release-2026-preview-01)
//   --signing-key <path>     Ed25519 private key PEM (or env METAWORK_RELEASE_SIGNING_KEY)
//   --generate-dev-key <prefix>
//                            Write an Ed25519 dev key pair to <prefix>.{private,public}.pem
//                            and exit (testing only; never publish releases signed with it)
//   --validity-days <n>      Manifest validity window (default: 90)
//   --artifact-base-url <u>  URL prefix for artifact URLs (default: ./ relative)
//   --platform <name>        Override packaged platform (darwin|linux)
//   --arch <name>            Override packaged arch (x64|arm64); use together
//                            with --platform to cross-package a tree whose
//                            native modules were swapped for the target
//                            platform's prebuilds
//   --compat <json>          Override the release compatibility block
//
// The caller is responsible for producing a production-only node_modules tree
// (for example `npm ci --omit=dev`) before packaging; the packaged tree is
// shipped verbatim into the release tarball.
import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = {
    sourceRoot: resolve(scriptDir, '..'),
    sourceMetaRoot: undefined,
    plannerRoot: undefined,
    outDir: undefined,
    channel: 'preview',
    releaseId: undefined,
    keyId: 'release-2026-preview-01',
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
      case '--out-dir': options.outDir = resolve(requireValue()); break;
      case '--channel': options.channel = requireValue(); break;
      case '--release-id': options.releaseId = requireValue(); break;
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
  options.sourceMetaRoot ??= resolve(scriptDir, '..');
  options.outDir ??= join(options.sourceRoot, 'dist-release');
  return options;
}

function platformName() {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`unsupported packaging platform: ${process.platform}`);
}

function architectureName() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`unsupported packaging architecture: ${process.arch}`);
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
  const required = [
    join(options.sourceRoot, 'dist', 'install-cli.js'),
    join(options.sourceRoot, 'web', 'dist'),
    join(options.sourceRoot, 'node_modules'),
    join(options.plannerRoot, 'package.json'),
    join(options.plannerRoot, 'packages', 'coding-agent', 'dist'),
    join(options.plannerRoot, 'node_modules'),
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      throw new Error(
        `missing build output: ${path}; build first (npm run build, and the vendored Planner build)`,
      );
    }
  }
}

const waitForExit = promisify((child, callback) => {
  child.on('exit', (code, signal) => {
    if (code === 0) callback(null);
    else callback(new Error(`process ${child.spawnfile} failed: code=${code} signal=${signal ?? ''}`));
  });
  child.on('error', callback);
});

// Copies selected entries into <staging>/<prefix>/ using a streaming tar pipe
// so the archive carries a single top-level directory (the installer extracts
// with --strip-components=1), so excludes work on both bsdtar and GNU tar, and
// so multi-hundred-megabyte dependency trees never buffer in memory.
async function packageTarball({ sourceRoot, stagingRoot, prefix, entries, exclude, outputPath }) {
  mkdirSync(join(stagingRoot, prefix), { recursive: true });
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
  const migrationsSource = readFileSync(join(sourceRoot, 'src', 'storage', 'migrations.ts'), 'utf8');
  const match = /export const CURRENT_SCHEMA_VERSION = (\d+)/u.exec(migrationsSource);
  if (!match) throw new Error('cannot determine CURRENT_SCHEMA_VERSION from src/storage/migrations.ts');
  return Number(match[1]);
}

function defaultCompatibility(sourceRoot) {
  return {
    // configurationSchema: AnyFusionConfigurationV2 schemaVersion (src/configuration/types.ts)
    configurationSchema: 2,
    // plannerHostProtocol: anyfusion-planner-host-v2 driver contract
    plannerHostProtocol: 2,
    // planningPlanSchema: planning-agent-plan-v8
    planningPlanSchema: 8,
    planningPlanSchemaHash: 'planning-agent-plan-v8',
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
    ?? `${packageVersion}-build-${revision}-${Date.now()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
    throw new Error(`invalid release ID: ${releaseId}`);
  }

  const stagingRoot = join(options.outDir, '.staging');
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const runtimeArchiveName = `metawork-${releaseId}-${platform}-${arch}.tar.gz`;
  const plannerArchiveName = `planner-${releaseId}-${platform}-${arch}.tar.gz`;
  await packageTarball({
    sourceRoot: options.sourceRoot,
    stagingRoot,
    prefix: 'metawork',
    entries: ['dist', 'web/dist', 'node_modules', 'package.json'],
    exclude: ['.DS_Store'],
    outputPath: join(options.outDir, runtimeArchiveName),
  });
  await packageTarball({
    sourceRoot: options.plannerRoot,
    stagingRoot,
    prefix: 'planner',
    entries: ['.'],
    exclude: ['.git', '.DS_Store'],
    outputPath: join(options.outDir, plannerArchiveName),
  });
  rmSync(stagingRoot, { recursive: true, force: true });

  const base = options.artifactBaseUrl.replace(/\/$/u, '');
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
    planner: {
      source: sourceUrl,
      revision,
      url: base === '.' ? plannerArchiveName : `${base}/${plannerArchiveName}`,
      byteSize: statSize(join(options.outDir, plannerArchiveName)),
      sha256: sha256sum(join(options.outDir, plannerArchiveName)),
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
    `planner: ${plannerArchiveName} (${signedManifest.planner.byteSize} bytes)`,
    `manifest: ${manifestPath}`,
    `signed by: ${options.keyId}`,
  ].join('\n'));
  process.stdout.write('\n');
}

function statSize(path) {
  return readFileSync(path).length;
}

main().catch(error => {
  process.stderr.write(`package-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
