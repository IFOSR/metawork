import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentClass, ExecutorResult } from '../core/types.js';
import type { AttemptSandboxPort } from '../execution/attempt-sandbox.js';
import { DEFAULT_ATTEMPT_SANDBOX_LIMITS } from '../execution/attempt-sandbox.js';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import type { AttemptSandboxRepositoryPort } from '../execution/repositories.js';
import { buildEnvFromFile } from '../utils/env-file.js';
import { AttemptModelGatewayServer } from '../execution/attempt-model-gateway.js';

const EXECUTOR_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const;

export class SandboxedExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private activeContainerId: string | null = null;

  constructor(
    private readonly agentClass: AgentClass,
    private readonly sandbox: AttemptSandboxPort,
    private readonly repository?: AttemptSandboxRepositoryPort,
  ) {
    this.name = agentClass.name;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.sandbox;
    if (!binding) return failed('sandbox binding is required', 'sandbox_binding_missing', startedAt);
    if (!this.agentClass.executionImageRef || !this.agentClass.resolvedImageId || !this.agentClass.permissionProfileId) {
      return failed(`AgentClass ${this.name} has no verified image or permission profile`, 'agent_class_sandbox_unconfigured', startedAt);
    }
    const resultPath = join(binding.workspacePath, '.metaclaw', 'results', `${binding.attemptId}.md`);
    const prompt = buildExecutorContextPrompt({
      ...input,
      context: {
        ...input.context,
        workspaceContext: {
          ...input.context.workspaceContext,
          workingDirectory: '/workspace',
          targetPaths: input.context.workspaceContext.targetPaths.map(target => (
            target === binding.workspacePath || target.startsWith(`${binding.workspacePath}/`) || target.startsWith(`${binding.workspacePath}\\`)
              ? `/workspace${target.slice(binding.workspacePath.length).replaceAll('\\', '/')}`
              : target
          )),
        },
      },
    });
    const { command, args } = this.commandAndArgs(
      prompt,
      `/workspace/.metaclaw/results/${binding.attemptId}.md`,
      input,
    );
    let modelGateway: AttemptModelGatewayServer | null = null;
    try {
      const providerEnvironment = this.providerEnvironment();
      const upstreamBaseUrl = providerEnvironment.OPENAI_BASE_URL;
      const upstreamApiKey = providerEnvironment.OPENAI_API_KEY;
      const sandboxProviderEnvironment = { ...providerEnvironment };
      if (upstreamBaseUrl && upstreamApiKey) {
        modelGateway = new AttemptModelGatewayServer({
          upstreamBaseUrl,
          upstreamApiKey,
          advertisedHost: process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
        });
        const gateway = await modelGateway.start();
        sandboxProviderEnvironment.OPENAI_BASE_URL = gateway.baseUrl;
        sandboxProviderEnvironment.OPENAI_API_KEY = gateway.apiKey;
      }
      const record = await this.sandbox.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        leaseToken: binding.leaseToken,
        idempotencyKey: binding.idempotencyKey,
        imageRef: this.agentClass.executionImageRef,
        resolvedImageId: this.agentClass.resolvedImageId,
        command,
        args,
        environment: {
          ...sandboxProviderEnvironment,
          METACLAW_ATTEMPT_ID: binding.attemptId,
          METACLAW_CAPABILITY_MCP_URL: binding.capabilityBinding?.mcpUrl ?? '',
          METACLAW_CAPABILITY_URL: binding.capabilityBinding?.jsonUrl ?? '',
          METACLAW_CAPABILITY_TOKEN: binding.capabilityBinding?.bearerToken ?? '',
          METACLAW_EVIDENCE_MCP_URL: input.context.evidenceTools.binding?.mcpUrl ?? '',
          METACLAW_EVIDENCE_JSON_URL: input.context.evidenceTools.binding?.jsonUrl ?? '',
          METACLAW_EVIDENCE_TOKEN: input.context.evidenceTools.binding?.bearerToken ?? '',
          ...(this.agentClass.permissionProfileId === 'public-web-research' ? {
            HTTP_PROXY: 'http://metaclaw-egress:8080',
            HTTPS_PROXY: 'http://metaclaw-egress:8080',
            NO_PROXY: 'metaclaw-control',
          } : {}),
        },
        mounts: [
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.sourcePath, target: '/source', mode: 'ro' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
          { source: binding.handoffsPath, target: '/handoffs', mode: 'ro' },
          ...(binding.gitMetadataPath
            ? [{ source: binding.gitMetadataPath, target: '/workspace/.git', mode: 'ro' as const }]
            : []),
        ],
        controlNetwork: binding.controlNetwork,
        egressMode: this.agentClass.permissionProfileId === 'public-web-research' ? 'proxy' : 'disabled',
        nestedSandbox: this.name === 'codex-cli' ? 'codex-workspace-write' : undefined,
        limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
      });
      const createdAt = new Date().toISOString();
      this.repository?.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        workspaceId: binding.workspaceId,
        containerId: record.containerId,
        imageRef: this.agentClass.executionImageRef,
        imageId: record.imageId,
        status: 'created',
        leaseToken: binding.leaseToken,
        labels: record.labels,
        exitCode: null,
        resultCollectedAt: null,
        cleanupStatus: null,
        cleanupError: null,
        createdAt,
        updatedAt: createdAt,
      });
      this.activeContainerId = record.containerId;
      binding.onContainerCreated?.(record.containerId);
      input.onProgress?.({ kind: 'status', text: `sandbox ${record.containerId.slice(0, 12)} started` });
      await this.sandbox.start(record.containerId);
      this.repository?.update(binding.attemptId, { status: 'running', updatedAt: new Date().toISOString() });
      const exitCode = await this.sandbox.wait(record.containerId);
      const logs = await this.sandbox.logs(record.containerId);
      this.repository?.update(binding.attemptId, {
        status: 'exited', exitCode, resultCollectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      let output = logs.trim();
      if (this.name === 'codex-cli' && exitCode === 0) {
        output = (await readFile(resultPath, 'utf8').catch(() => logs)).trim();
      }
      if (output) {
        const runtimeWorkspacePath = binding.workspacePath.replaceAll('\\', '/');
        output = output.replaceAll(/\/workspace(?=\/|[\s`"')\]}]|$)/gu, runtimeWorkspacePath);
      }
      await this.sandbox.remove(record.containerId);
      this.repository?.update(binding.attemptId, { status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString() });
      this.activeContainerId = null;
      await modelGateway?.close();
      modelGateway = null;
      return exitCode === 0 && output
        ? { success: true, output, exitCode, durationMs: Date.now() - startedAt }
        : failed(logs.trim() || `sandbox exited with code ${exitCode}`, 'sandbox_execution_failed', startedAt, exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleanupError: string | null = null;
      if (this.activeContainerId) {
        try {
          await this.sandbox.stop(this.activeContainerId);
          await this.sandbox.remove(this.activeContainerId);
          this.repository?.update(binding.attemptId, {
            status: 'removed', cleanupStatus: 'removed', cleanupError: null, updatedAt: new Date().toISOString(),
          });
        } catch (cleanup) {
          cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup);
        }
      }
      if (cleanupError || !this.activeContainerId) {
        this.repository?.update(binding.attemptId, {
          cleanupStatus: 'failed', cleanupError: cleanupError ?? message, updatedAt: new Date().toISOString(),
        });
      }
      this.activeContainerId = null;
      await modelGateway?.close().catch(() => undefined);
      return failed(message, 'sandbox_configuration_failure', startedAt);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.agentClass.executionImageRef || !this.agentClass.resolvedImageId || !this.agentClass.permissionProfileId) return false;
    try {
      return await this.sandbox.resolveImage(this.agentClass.executionImageRef) === this.agentClass.resolvedImageId;
    } catch {
      return false;
    }
  }

  abort(): void {
    if (this.activeContainerId) void this.sandbox.stop(this.activeContainerId).catch(() => undefined);
  }

  private commandAndArgs(prompt: string, outputPath: string, input: ExecutorInput): { command: string; args: string[] } {
    const command = this.agentClass.runtimeCommand
      ?? (this.name === 'codex-cli' ? 'codex' : this.name === 'pi-agent' ? 'pi' : null);
    if (!command) throw new Error(`AgentClass ${this.name} has no container runtime command`);
    if (this.name === 'codex-cli') {
      const args = buildCodexNonInteractiveArgs(prompt, { ephemeral: false, outputLastMessagePath: outputPath });
      const runtimeMcpArgs: string[] = [];
      const evidenceMcpUrl = input.context.evidenceTools.binding?.mcpUrl;
      const capabilityMcpUrl = input.sandbox?.capabilityBinding?.mcpUrl;
      if (evidenceMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_evidence.url=${JSON.stringify(evidenceMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_evidence.bearer_token_env_var=\"METACLAW_EVIDENCE_TOKEN\"',
        );
      }
      if (capabilityMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_capability.url=${JSON.stringify(capabilityMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_capability.bearer_token_env_var=\"METACLAW_CAPABILITY_TOKEN\"',
        );
      }
      args.splice(args.length - 1, 0, ...runtimeMcpArgs);
      return { command, args };
    }
    if (this.name === 'pi-agent') {
      return {
        command,
        args: [
          '--no-extensions', '--extension', '/opt/metaclaw/pi-attempt-tools.ts', '--tools',
          'web_search,web_fetch,evidence_list,evidence_search,evidence_get,bash,read,write,edit,grep,find,ls',
          '-p', prompt,
        ],
      };
    }
    const template = this.agentClass.runtimeArgs;
    return {
      command,
      args: template.some(arg => arg.includes('{prompt}'))
        ? template.map(arg => arg.replaceAll('{prompt}', prompt))
        : [...template, prompt],
    };
  }

  private providerEnvironment(): Record<string, string> {
    const envFile = this.name === 'codex-cli'
      ? process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE
      : this.name === 'pi-agent'
        ? process.env.METACLAW_PI_EXECUTOR_ENV_FILE
        : undefined;
    const source = buildEnvFromFile(envFile, process.env);
    return Object.fromEntries(EXECUTOR_PROVIDER_ENV_KEYS.flatMap(key => {
      const value = source[key];
      return value ? [[key, value]] : [];
    }));
  }
}

function failed(message: string, code: string, startedAt: number, exitCode = 1): ExecutorResult {
  return {
    success: false,
    output: '',
    error: message,
    failure: { kind: 'configuration', scope: 'agent_class', code, summary: message },
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}
