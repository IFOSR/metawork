import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AgentClassDefinition,
  ConfigurationSnapshot,
  ModelPolicy,
  PermissionProfile,
} from './types.js';

export interface CompiledAgentRuntime {
  rootPath: string;
  revisionId: string;
  agentClassPaths: Record<string, string>;
}

export class ConfigurationCompiler {
  constructor(readonly outputRoot: string) {}

  async compile(snapshot: ConfigurationSnapshot): Promise<CompiledAgentRuntime> {
    const rootPath = resolve(this.outputRoot, snapshot.revisionId);
    await mkdir(rootPath, { recursive: false, mode: 0o700 });
    try {
      const agentClassPaths: Record<string, string> = {};
      for (const [agentClassId, agentClass] of Object.entries(snapshot.config.agentClasses).sort()) {
        const relativePath = agentClass.kind === 'planner'
          ? join('planner', agentClassId)
          : join('executors', agentClassId);
        const agentRoot = join(rootPath, relativePath);
        agentClassPaths[agentClassId] = agentRoot;
        await writeAgentRuntime(agentRoot, agentClassId, agentClass, snapshot);
      }
      await writeJson(rootPath, 'runtime-manifest.json', {
        schemaVersion: 1,
        revisionId: snapshot.revisionId,
        contentHash: snapshot.contentHash,
        agentClasses: agentClassPaths,
      });
      await makeImmutable(rootPath);
      return { rootPath, revisionId: snapshot.revisionId, agentClassPaths };
    } catch (error) {
      throw error;
    }
  }
}

async function writeAgentRuntime(
  rootPath: string,
  agentClassId: string,
  agentClass: AgentClassDefinition,
  snapshot: ConfigurationSnapshot,
): Promise<void> {
  const harness = snapshot.config.harnesses[agentClass.harnessRef];
  const modelRefs = agentClass.modelPolicy.mode === 'fixed'
    ? [agentClass.modelPolicy.modelRef]
    : agentClass.modelPolicy.allowedModelRefs;
  const models = modelRefs.map(modelRef => {
    const model = snapshot.config.models[modelRef]!;
    const provider = snapshot.config.providers[model.providerRef]!;
    return {
      modelRef,
      modelId: model.modelId,
      providerRef: model.providerRef,
      providerRegion: provider.region,
      capabilities: [...model.capabilities].sort(),
      reasoning: model.reasoning,
    };
  });
  const permissionProfile = agentClass.permissionProfileRef
    ? snapshot.config.permissionProfiles[agentClass.permissionProfileRef]
    : null;
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeJson(rootPath, 'agent.json', {
      schemaVersion: 1,
      revisionId: snapshot.revisionId,
      agentClassId,
      kind: agentClass.kind,
      harnessRef: agentClass.harnessRef,
      generatedRuntimeRef: agentClass.generatedRuntimeRef,
      modelPolicy: cloneModelPolicy(agentClass.modelPolicy),
      skills: [...agentClass.skills].sort(),
      mcpServers: [...agentClass.mcpServers].sort(),
      plugins: [...agentClass.plugins].sort(),
    }),
    writeJson(rootPath, 'model.json', { models }),
    writeJson(rootPath, 'permission.json', permissionProfile
      ? clonePermissionProfile(permissionProfile)
      : null),
    writeJson(rootPath, 'harness.json', {
      kind: harness.kind,
      transport: harness.transport,
      driverId: harness.driverId,
      supportsProbe: harness.supportsProbe,
      supportsAbort: harness.supportsAbort,
      supportsContinuation: harness.supportsContinuation,
    }),
  ]);
}

async function writeJson(rootPath: string, name: string, value: unknown): Promise<void> {
  await writeFile(
    join(rootPath, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function makeImmutable(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeImmutable(child);
    else await chmod(child, 0o444);
  }
  await chmod(path, 0o555);
}

function cloneModelPolicy(policy: ModelPolicy): ModelPolicy {
  if (policy.mode === 'fixed') return { ...policy };
  return {
    ...policy,
    allowedModelRefs: [...policy.allowedModelRefs],
    fallback: policy.fallback
      ? { ...policy.fallback, order: [...policy.fallback.order] }
      : undefined,
  };
}

function clonePermissionProfile(profile: PermissionProfile): PermissionProfile {
  return {
    ...profile,
    parameters: {
      ...profile.parameters,
      allowedPublicDomains: profile.parameters.allowedPublicDomains
        ? [...profile.parameters.allowedPublicDomains]
        : undefined,
    },
  };
}
