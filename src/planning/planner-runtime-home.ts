import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

const materializations = new Map<string, Promise<string>>();

/**
 * Copies the immutable generated Planner configuration into a writable,
 * account-scoped home. Planner persists trust and other runtime state there.
 */
export async function materializePlannerRuntimeHome(
  sourceHome: string,
  runtimeRoot: string,
  revisionId: string,
  options: {
    runtimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
    expectedModel?: { provider: string; modelId: string };
  } = {},
): Promise<string> {
  const source = resolve(sourceHome);
  const root = resolve(runtimeRoot);
  const target = resolve(root, revisionId);
  assertContained(root, target, 'Planner runtime revision');

  const key = `${source}\0${target}`;
  const existing = materializations.get(key);
  if (existing) return existing;

  const materialization = materialize(source, root, target, options);
  materializations.set(key, materialization);
  try {
    return await materialization;
  } finally {
    if (materializations.get(key) === materialization) {
      materializations.delete(key);
    }
  }
}

async function materialize(
  source: string,
  root: string,
  target: string,
  options: {
    runtimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
    expectedModel?: { provider: string; modelId: string };
  },
): Promise<string> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Planner generated home is not a directory: ${source}`);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });

  const targetInfo = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (targetInfo) {
    if (!targetInfo.isDirectory()) {
      throw new Error(`Planner runtime home is not a directory: ${target}`);
    }
    await copyTree(source, target);
    await writeCompatibilityConfigIfNeeded(target, options);
    await chmod(target, 0o700);
    return target;
  }

  const temporary = join(
    root,
    `.${relative(root, target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    await copyTree(source, temporary);
    await writeCompatibilityConfigIfNeeded(temporary, options);
    await chmod(temporary, 0o700);
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function writeCompatibilityConfigIfNeeded(
  plannerHome: string,
  options: {
    runtimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
    expectedModel?: { provider: string; modelId: string };
  },
): Promise<void> {
  const [models, settings] = await Promise.all([
    lstat(join(plannerHome, 'models.json')).catch(() => null),
    lstat(join(plannerHome, 'settings.json')).catch(() => null),
  ]);
  if (models && settings) return;
  const expected = options.expectedModel;
  if (!expected) return;
  const baseUrl = options.runtimeEnvironment?.OPENAI_BASE_URL?.trim();
  if (!baseUrl) return;

  if (!models) {
    await writeFile(
      join(plannerHome, 'models.json'),
      `${JSON.stringify({
        providers: {
          [expected.provider]: {
            baseUrl,
            api: 'openai-responses',
            apiKey: '$OPENAI_API_KEY',
            models: [{
              id: expected.modelId,
              reasoning: true,
              compat: { supportsReasoningEffort: true },
            }],
          },
        },
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  if (!settings) {
    await writeFile(
      join(plannerHome, 'settings.json'),
      `${JSON.stringify({
        defaultProvider: expected.provider,
        defaultModel: expected.modelId,
        quietStartup: true,
        defaultProjectTrust: 'always',
        enableSkillCommands: false,
        defaultThinkingLevel: 'high',
        enabledModels: [`${expected.provider}/${expected.modelId}`],
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported entry in Planner generated home: ${sourcePath}`);
    }
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o600);
  }
}

function assertContained(root: string, target: string, label: string): void {
  const path = relative(root, target);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(root, path) !== target) {
    throw new Error(`${label} escapes its runtime root: ${target}`);
  }
}
