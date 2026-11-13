import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import {
  resolveCurrentRuntimeHome,
  resolveRevisionRuntimeHome,
} from '../configuration/agent-runtime-renderer.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { RuntimeHomeMaterializer } from './runtime-home-materializer.js';
import { normalizePiUsage } from './pi-usage.js';
import { PI_PROVIDER_OPTIONS_EXTENSION_SOURCE } from './pi-provider-options.js';
import {
  TOOL_STALL_FACTS_FILE,
  TOOL_STALL_SAMPLE_MS,
  TOOL_STALL_WINDOW_MS,
} from './tool-stall-core.js';
import type { ExecutorAffordanceId } from '../routing/types.js';
import type {
  HarnessDriver,
  HarnessActivitySignal,
  HarnessLaunchInput,
  HarnessLaunchSpec,
  HarnessProbeResult,
  HarnessProgressEvent,
  HarnessProgressLineInput,
  HarnessResultStreamSnapshot,
  HarnessResultStreamTracker,
  HarnessResultInput,
  HarnessUsageEvent,
  MaterializedRuntimeHome,
  ProbeCommandRunner,
  RuntimeHomeInput,
} from './harness-driver.js';
import {
  emptyToUndefined,
  normalizeHarnessResult,
  assistantMessageText,
  parseJsonLine,
  parseJsonLines,
  safeHostEnvironment,
  safeHarnessName,
} from './harness-driver.js';

const execFileAsync = promisify(execFile);
const MAX_PROVISIONAL_TEXT_BYTES = 1024 * 1024;

export class PiCliDriver implements HarnessDriver {
  readonly id = 'pi-cli';
  readonly executionProtocols = ['workspace-image-artifact-v1'] as const;
  readonly supportsResponseOnly = true;
  readonly supportsEvidenceTools = true;
  private readonly runProbe: ProbeCommandRunner;
  private readonly explicitHomeTemplateDir?: string;
  private readonly generatedRuntimeRoot?: string;
  private readonly fallbackHomeTemplateDir?: string;
  private readonly webExtensionSourcePath?: string;
  private readonly pdfExtensionRoot: string;
  /** Executor-owned stall guard; always present so every Attempt is protected. */
  private readonly stallGuardExtensionRoot: string;
  private readonly command: string;
  /**
   * Pi's tool_execution_end event normally omits args. Keep the start facts
   * long enough to pair the end result with the command that actually ran.
   */
  private readonly pendingToolCalls = new Map<string, { toolName: string; detail: string }>();

  constructor(dependencies: {
    command?: string;
    probeCommand?: ProbeCommandRunner;
    homeTemplateDir?: string;
    generatedRuntimeRoot?: string;
    webExtensionSourcePath?: string;
    pdfExtensionRoot?: string;
    stallGuardExtensionRoot?: string;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    this.command = dependencies.command ?? 'pi';
    this.pdfExtensionRoot = dependencies.pdfExtensionRoot
      ?? join(resolveMetaWorkPaths().appCurrent, 'dist', 'pi-pdf');
    this.stallGuardExtensionRoot = dependencies.stallGuardExtensionRoot
      ?? join(resolveMetaWorkPaths().appCurrent, 'dist', 'pi-tool-stall');
    this.explicitHomeTemplateDir = emptyToUndefined(dependencies.homeTemplateDir);
    this.generatedRuntimeRoot = emptyToUndefined(dependencies.generatedRuntimeRoot);
    this.webExtensionSourcePath = emptyToUndefined(
      dependencies.webExtensionSourcePath
        ?? process.env.METACLAW_PI_ATTEMPT_EXTENSION
        ?? join(resolveMetaWorkPaths().appCurrent, 'dist', 'pi-attempt-tools.ts'),
    );
    this.fallbackHomeTemplateDir = emptyToUndefined(
      resolveCurrentRuntimeHome(resolveMetaWorkPaths().generatedAgentRuntime, 'pi-home')
      ?? process.env.METACLAW_EXECUTOR_PI_HOME,
    );
  }

  async probe(): Promise<HarnessProbeResult> {
    const result = await this.runProbe(this.command, ['--version']);
    // Optional PDF tooling validates its Python dependencies when a pdf_* tool
    // is actually invoked. It must not gate every Pi research/coding attempt.
    return result.code === 0
      ? { available: true, detail: result.stdout.trim() }
      : { available: false, detail: result.stderr.trim() || `pi exited with ${result.code}` };
  }

  async materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome> {
    const materializer = new RuntimeHomeMaterializer(input.attemptsRoot);
    const { homePath } = materializer.resolvePaths(input.attemptId);
    const agentPath = `${homePath}/.pi/agent`;
    const sessionPath = `${agentPath}/sessions`;
    const home = await materializer.materialize({
      attemptId: input.attemptId,
      revisionId: input.revisionId,
      agentClassId: input.agentClassId,
      bindingFingerprint: input.bindingFingerprint,
      environment: {
        HOME: homePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: sessionPath,
        ANYFUSION_PLANNER_HOME: agentPath,
        ANYFUSION_PLANNER_SESSION_DIR: sessionPath,
        ...input.environment,
        METACLAW_PI_WEB_TOOLS_ENABLED: hasWebResearchAffordances(input.executorAffordances) ? '1' : '0',
      },
      homeDirectories: ['.pi/agent/sessions'],
    });
    await this.seedProviderConfig(homePath, input.revisionId, input);
    const extensionsPath = join(homePath, '.pi', 'agent', 'extensions');
    await mkdir(extensionsPath, { recursive: true, mode: 0o700 });
    await writeFile(join(extensionsPath, 'metawork-provider-options.ts'),
      PI_PROVIDER_OPTIONS_EXTENSION_SOURCE, { mode: 0o600 });
    await this.seedWebExtension(homePath, input.executorAffordances, input.evidenceToolsAvailable === true);
    if (existsSync(join(this.pdfExtensionRoot, 'index.ts'))) {
      const extensions = join(homePath, '.pi', 'agent', 'extensions');
      await mkdir(extensions, { recursive: true, mode: 0o700 });
      await writeFile(join(extensions, 'pi-pdf.ts'),
        `export { default } from ${JSON.stringify(join(this.pdfExtensionRoot, 'index.ts'))};\n`, { mode: 0o600 });
    }
    const stallGuardSource = join(this.stallGuardExtensionRoot, 'index.ts');
    if (existsSync(stallGuardSource)) {
      const extensions = join(homePath, '.pi', 'agent', 'extensions');
      await mkdir(extensions, { recursive: true, mode: 0o700 });
      await writeFile(join(extensions, 'metawork-tool-stall.ts'),
        `export { default } from ${JSON.stringify(stallGuardSource)};\n`, { mode: 0o600 });
    }
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    const agentPath = `${input.runtimeHomePath}/.pi/agent`;
    // The vendored Planner CLI denies `--provider`/`--model`/`--tools` from any
    // client (planner-policy DENIED_FLAGS): provider and model selection flow
    // through the seeded home settings.json instead, and the managed web
    // research tools register inline (env-gated) because file extensions and
    // tool CLI flags cannot load under the policy. Response-only attempts keep
    // default tools because settings expose no tools toggle.
    // The workspace boundary env uses realpath form to match the supervisor's
    // Planner injection — the boundary check compares raw strings and mangles
    // forward-slash Windows paths. (Realpath may fail on synthetic launch
    // inputs; the raw cwd is an acceptable fallback.)
    let authorizedWorkspace = input.cwd;
    try {
      authorizedWorkspace = realpathSync(input.cwd);
    } catch {
      /* keep raw cwd */
    }
    // Debug capture override must also win over the OPENAI_BASE_URL env (the
    // ai package prefers it over the models.json baseUrl when both exist).
    const debugBaseUrl = process.env.METACLAW_DEBUG_BASE_URL_OVERRIDE?.trim();
    const environment: Record<string, string> = {
      HOME: input.runtimeHomePath,
      // The vendored fork renamed the agent-dir env: it honors
      // ANYFUSION_PLANNER_HOME/ANYFUSION_PLANNER_SESSION_DIR and ignores the
      // legacy PI_CODING_AGENT_DIR names. Keep both for older layouts.
      PI_CODING_AGENT_DIR: agentPath,
      PI_CODING_AGENT_SESSION_DIR: `${agentPath}/sessions`,
      ANYFUSION_PLANNER_HOME: agentPath,
      ANYFUSION_PLANNER_SESSION_DIR: `${agentPath}/sessions`,
      ANYFUSION_PLANNER_WORKSPACE: authorizedWorkspace,
      ANYFUSION_PLANNER_SCHEMA_PATH: process.env.METACLAW_PLANNER_SCHEMA_PATH
        ?? join(resolveMetaWorkPaths().appCurrent, 'dist', 'planning-agent-plan-v8.schema.json'),
      // No Planner MCP env here: Executor sessions do not submit planning
      // proposals, and the vendored MCP extension skips itself gracefully
      // when ANYFUSION_PLANNER_MCP_COMMAND is unset.
    };
    if (debugBaseUrl) {
      environment.OPENAI_BASE_URL = debugBaseUrl;
    }
    return {
      command: this.command,
      args: [
        '--mode',
        'json',
        ...(input.responseOnly ? ['--no-session'] : []),
        input.prompt,
      ],
      cwd: input.cwd,
      environment: {
        ...environment,
        PYTHONDONTWRITEBYTECODE: '1',
        // The stall guard and the MetaWork host must agree on the window and on
        // where tool-call stall facts land.
        METACLAW_TOOL_STALL_FACTS: join(input.runtimeHomePath, TOOL_STALL_FACTS_FILE),
        METACLAW_TOOL_STALL_WINDOW_MS: String(TOOL_STALL_WINDOW_MS),
        METACLAW_TOOL_STALL_SAMPLE_MS: String(TOOL_STALL_SAMPLE_MS),
      },
    };
  }

  parseResult(input: HarnessResultInput) {
    const events = parseJsonLines(input.stdout);
    const terminalError = findPiTerminalError(events);
    if (terminalError) {
      return {
        success: false as const,
        output: input.streamedOutput?.trim() ?? lastAssistantMessageText(events) ?? '',
        error: redactSensitiveText(terminalError),
      };
    }
    if (input.exitCode === 0) {
      const streamedOutput = input.streamedOutput?.trim();
      if (streamedOutput) {
        return { success: true as const, output: streamedOutput };
      }
      const messages = events
        .filter(event => event.type === 'message_end')
        .map(event => assistantMessageText(event.message))
        .filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return { success: true as const, output: messages.at(-1)! };
      }
      return {
        success: false as const,
        output: '' as const,
        error: 'Pi executor exited without a final assistant response',
      };
    }
    return normalizeHarnessResult(input);
  }

  parseResultLine(input: HarnessProgressLineInput): string | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || !['message_end', 'turn_end'].includes(String(event.type))) return null;
    return assistantMessageText(event.message);
  }

  createResultStreamTracker(): HarnessResultStreamTracker {
    return new PiResultStreamTracker();
  }

  parseProgressLine(input: HarnessProgressLineInput): HarnessProgressEvent | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return null;
    if (event.type === 'message_end' && messageRole(event.message) === 'assistant') {
      const text = assistantMessageText(event.message);
      if (text) {
        return { kind: 'status', text: `Executor: ${executorActivityExcerpt(text)}` };
      }
      return null;
    }
    if (event.type === 'tool_execution_start') {
      const toolName = safeHarnessName(event.toolName);
      const detail = toolArgSummary(event.args);
      if (typeof event.toolCallId === 'string' && event.toolCallId.trim()) {
        this.pendingToolCalls.set(event.toolCallId, { toolName, detail });
      }
      return {
        kind: 'skill',
        text: formatToolStart(toolName, detail),
      };
    }
    if (event.type === 'tool_execution_end') {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const pending = toolCallId ? this.pendingToolCalls.get(toolCallId) : undefined;
      const toolName = safeHarnessName(event.toolName || pending?.toolName);
      const detail = toolArgSummary(event.args) || pending?.detail || '';
      if (toolCallId) this.pendingToolCalls.delete(toolCallId);
      const result = toolResultSummary(event.result);
      return {
        kind: 'skill',
        text: formatToolEnd(toolName, detail, result, event.isError === true),
      };
    }
    if (event.type === 'tool_execution_update') {
      const text = toolResultSummary(event.partialResult);
      return text ? { kind: 'log', text: `Executor tool progress:\n${text}` } : null;
    }
    return null;
  }

  parseUsageLine(input: HarnessProgressLineInput): HarnessUsageEvent | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (event?.type !== 'message_end' || messageRole(event.message) !== 'assistant') return null;
    const message = asRecord(event.message);
    const usage = asRecord(message?.usage);
    const explicitCallId = firstString(message?.id, message?.messageId);
    const fallbackCallId = `message_end:${createHash('sha256')
      .update(input.line, 'utf8')
      .digest('hex')
      .slice(0, 24)}`;
    const callId = explicitCallId ?? fallbackCallId;
    const normalized = normalizePiUsage({
      input: usage?.input, output: usage?.output,
      cacheRead: usage?.cacheRead !== undefined ? usage.cacheRead : usage?.cache_read,
      cacheWrite: usage?.cacheWrite !== undefined ? usage.cacheWrite : usage?.cache_write,
      reasoning: usage?.reasoning,
    });
    return {
      sourceEventKey: callId.startsWith('message_end:')
        ? callId
        : `message_end:${callId}`,
      callId,
      occurredAtUtc: new Date().toISOString(),
      providerResponseId: explicitCallId ?? null,
      ...normalized,
    };
  }

  parseActivityLine(input: HarnessProgressLineInput): HarnessActivitySignal | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return null;
    if (event.type === 'message_start' && messageRole(event.message) === 'assistant') {
      return { type: 'operation_started', operationId: 'pi-model' };
    }
    if (event.type === 'message_end' && messageRole(event.message) === 'assistant') {
      return { type: 'operation_finished', operationId: 'pi-model' };
    }
    if (event.type === 'message_update') {
      const update = asRecord(event.assistantMessageEvent);
      if (typeof update?.delta === 'string' && update.delta.length > 0) {
        return { type: 'operation_progress', operationId: 'pi-model' };
      }
    }
    if (event.type === 'tool_execution_update' && typeof event.toolCallId === 'string') {
      if (!event.partialResult || typeof event.partialResult !== 'object') return null;
      return { type: 'operation_progress', operationId: `pi-tool:${safeHarnessName(event.toolCallId)}`,
        checkpoint: createHash('sha256').update(JSON.stringify(event.partialResult ?? null)).digest('hex') };
    }
    if (event.type === 'turn_start' || event.type === 'turn_end') {
      if (typeof event.turnIndex !== 'number') return null;
      return {
        type: event.type === 'turn_start' ? 'operation_started' : 'operation_finished',
        operationId: `pi-turn:${event.turnIndex}`,
      };
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      if (typeof event.toolCallId !== 'string' || !event.toolCallId.trim()) return null;
      return {
        type: event.type === 'tool_execution_start' ? 'operation_started' : 'operation_finished',
        operationId: `pi-tool:${safeHarnessName(event.toolCallId)}`,
      };
    }
    return null;
  }

  private async seedProviderConfig(
    homePath: string,
    revisionId: string,
    binding?: { providerRef?: string; modelId?: string },
  ): Promise<void> {
    const revisionHome = this.generatedRuntimeRoot
      ? resolveRevisionRuntimeHome(this.generatedRuntimeRoot, revisionId, 'pi-home')
      : undefined;
    if (this.generatedRuntimeRoot && !revisionHome) {
      throw new Error(
        `Pi executor runtime home is missing for configuration revision ${revisionId}: `
        + join(this.generatedRuntimeRoot, revisionId, 'pi-home'),
      );
    }
    const templateDir = revisionHome
      ?? this.explicitHomeTemplateDir
      ?? this.fallbackHomeTemplateDir;
    if (!templateDir) return;
    const sourceDir = join(templateDir, '.pi', 'agent');
    const targetDir = join(homePath, '.pi', 'agent');
    for (const fileName of ['models.json', 'settings.json']) {
      const source = join(sourceDir, fileName);
      if (!existsSync(source)) {
        throw new Error(`Pi executor home template is missing ${fileName}: ${source}`);
      }
      const target = join(targetDir, fileName);
      await writeFileWithRetry(target, await readFile(source, 'utf8'));
    }
		// The attempt binding overrides the generation-wide template defaults: the
		// vendored CLI resolves the session model from `enabledModels` (scoped
		// models take priority over env-based fallbacks) and falls back to
		// `defaultProvider`/`defaultModel`. The manifest hash side seeds the
		// same three keys (agent-runtime-renderer executorRuntimeFileHashes).
		if (binding?.providerRef && binding?.modelId) {
			const settingsPath = join(targetDir, 'settings.json');
			const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
			settings.defaultProvider = binding.providerRef;
			settings.defaultModel = binding.modelId;
			settings.enabledModels = [`${binding.providerRef}/${binding.modelId}`];
			await writeFileWithRetry(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		}
		// Debug capture escape hatch (METACLAW_DEBUG_BASE_URL_OVERRIDE): redirect
		// the provider baseUrl to a local capture/forwarding proxy. Pairs with
		// verifyExecutorRuntimeHome's matching models.json hash skip.
		const debugBaseUrl = process.env.METACLAW_DEBUG_BASE_URL_OVERRIDE?.trim();
		if (debugBaseUrl) {
			const modelsPath = join(targetDir, 'models.json');
			const models = JSON.parse(await readFile(modelsPath, 'utf8')) as {
				providers?: Record<string, { baseUrl?: unknown }>;
			};
			for (const provider of Object.values(models.providers ?? {})) {
				if (typeof provider.baseUrl === 'string' && provider.baseUrl.includes('api.kimi.com')) {
					provider.baseUrl = debugBaseUrl;
				}
			}
			await writeFileWithRetry(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
		}
  }

  private async seedWebExtension(
    homePath: string,
    affordances: readonly ExecutorAffordanceId[] | undefined,
    evidenceToolsAvailable: boolean,
  ): Promise<void> {
    if (!this.webExtensionSourcePath
      || (!hasWebResearchAffordances(affordances) && !evidenceToolsAvailable)) return;
    // A previous partial build (`tsup` clears dist/ and the generated
    // extension is a separate step) used to surface here as a generic
    // ENOENT "configuration" failure, which the user cannot act on. Fail with
    // the actual repair instruction instead.
    if (!existsSync(this.webExtensionSourcePath)) {
      throw new Error(
        'MetaWork runtime is incomplete: missing generated Pi extension '
        + `${this.webExtensionSourcePath}. Rebuild the complete runtime `
        + '(npm run build, or run tsup plus the schema and pi-attempt-extension generators).',
      );
    }
    const extensionsDir = join(homePath, '.pi', 'agent', 'extensions');
    await mkdir(extensionsDir, { recursive: true, mode: 0o700 });
    const target = join(extensionsDir, 'metawork-web-tools.ts');
    // The isolated attempt home has no node_modules up-tree, so the seeded
    // extension's `@earendil-works/*` bare imports cannot resolve there.
    // Rewrite them to absolute file URLs into the staged fork packages.
    const stagedRoot = join(resolveMetaWorkPaths().appCurrent, 'planner', 'packages');
    let source = await readFile(this.webExtensionSourcePath, 'utf8');
    source = source
      .replaceAll('"@earendil-works/pi-ai"', `"${pathToFileURL(join(stagedRoot, 'ai', 'dist', 'index.js')).href}"`)
      .replaceAll('"@earendil-works/pi-coding-agent"', `"${pathToFileURL(join(stagedRoot, 'coding-agent', 'dist', 'index.js')).href}"`);
    await writeFileWithRetry(target, source);
  }
}

class PiResultStreamTracker implements HarnessResultStreamTracker {
  private completedOutput: string | null = null;
  private provisionalOutput = '';
  private assistantStreamOpen = false;
  private lastEventKind: string | null = null;
  private turnIndex: number | null = null;

  observe(input: HarnessProgressLineInput): void {
    if (input.stream !== 'stdout') return;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return;
    this.lastEventKind = event.type;
    if (event.type === 'turn_start' && typeof event.turnIndex === 'number') {
      this.turnIndex = event.turnIndex;
      return;
    }
    if (event.type === 'message_start' && messageRole(event.message) === 'assistant') {
      this.assistantStreamOpen = true;
      this.provisionalOutput = '';
      return;
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== 'object' || Array.isArray(update)) return;
      const assistantEvent = update as Record<string, unknown>;
      if (assistantEvent.type !== 'text_delta' || typeof assistantEvent.delta !== 'string') return;
      this.lastEventKind = 'message_update:text_delta';
      this.assistantStreamOpen = true;
      this.provisionalOutput = appendBoundedUtf8(
        this.provisionalOutput,
        assistantEvent.delta,
        MAX_PROVISIONAL_TEXT_BYTES,
      );
      return;
    }
    if (
      (event.type === 'message_end' || event.type === 'turn_end')
      && messageRole(event.message) === 'assistant'
    ) {
      const output = assistantMessageText(event.message);
      if (output) this.completedOutput = output;
      this.provisionalOutput = '';
      this.assistantStreamOpen = false;
    }
  }

  snapshot(): HarnessResultStreamSnapshot {
    const provisional = this.assistantStreamOpen && this.provisionalOutput.length > 0;
    const output = provisional ? this.provisionalOutput : this.completedOutput;
    return {
      output,
      provisional,
      diagnostics: {
        lastEventKind: this.lastEventKind,
        turnIndex: this.turnIndex,
        assistantStreamOpen: this.assistantStreamOpen,
        safeTextBytes: Buffer.byteLength(output ?? '', 'utf8'),
      },
    };
  }
}

/**
 * Windows Defender real-time scanning transiently locks freshly written
 * source files, surfacing as EPERM/EBUSY/EACCES on the immediate reopen.
 * Retry a few times with a growing delay before giving up.
 */
async function writeFileWithRetry(path: string, content: string): Promise<void> {
  const transient = ['EPERM', 'EBUSY', 'EACCES'];
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'w' });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 4 || !transient.includes(code)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * (attempt + 1)));
    }
  }
}

function appendBoundedUtf8(current: string, delta: string, maxBytes: number): string {
  const combined = current + delta;
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.length <= maxBytes) return combined;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function hasWebResearchAffordances(
  affordances: readonly ExecutorAffordanceId[] | undefined,
): boolean {
  const available = new Set(affordances ?? []);
  const requiredAffordances = [
    'public-web-search',
    'public-web-fetch',
    'source-citation',
  ] as const;
  return requiredAffordances.every(affordance => available.has(affordance));
}

function findPiTerminalError(events: Record<string, unknown>[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      const message = [...event.messages].reverse().find(isAssistantMessage);
      if (message) return assistantTerminalError(message);
    }
    if (['message_end', 'turn_end'].includes(String(event.type)) && isAssistantMessage(event.message)) {
      return assistantTerminalError(event.message);
    }
    if (
      event.type === 'error'
      && typeof event.errorMessage === 'string'
      && event.errorMessage.trim()
    ) {
      return event.errorMessage.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
}

function lastAssistantMessageText(events: Record<string, unknown>[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const candidates = event.type === 'agent_end' && Array.isArray(event.messages)
      ? event.messages
      : [event.message];
    for (const candidate of [...candidates].reverse()) {
      const text = assistantMessageText(candidate);
      if (text) return text;
    }
  }
  return null;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).role === 'assistant';
}

function messageRole(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof (value as Record<string, unknown>).role === 'string'
    ? String((value as Record<string, unknown>).role)
    : null;
}

/** 工具参数中允许进入用户可见进度的白名单键；其余一律不透出。 */
const TOOL_ARG_KEYS = [
  'command',
  'path',
  'file_path',
  'url',
  'query',
  'pattern',
  'skill',
] as const;

function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return executorActivityExcerpt(value, 500);
    }
  }
  return '';
}

function formatToolStart(toolName: string, detail: string): string {
  if (!detail) return `Executor started tool: ${toolName}`;
  const label = toolName === 'bash' ? 'Command' : 'Input';
  return `Executor started tool: ${toolName}\n${label}: ${detail}`;
}

function formatToolEnd(toolName: string, detail: string, result: string, failed: boolean): string {
  const lines = [`Executor ${failed ? 'failed' : 'completed'} tool: ${toolName}`];
  if (detail) lines.push(`${toolName === 'bash' ? 'Command' : 'Input'}: ${detail}`);
  lines.push(`Return: ${result || 'no output'}`);
  return lines.join('\n');
}

/** Extract the useful, user-visible portion of Pi's tool result envelope. */
function toolResultSummary(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return executorResultExcerpt(value);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return executorResultExcerpt(JSON.stringify(value) ?? String(value));
  }

  const record = value as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? record.content
      .map(item => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
        const itemRecord = item as Record<string, unknown>;
        return typeof itemRecord.text === 'string'
          ? itemRecord.text
          : typeof itemRecord.content === 'string' ? itemRecord.content : '';
      })
      .filter(Boolean)
      .join('\n')
    : '';
  const output = [
    content,
    ...['stdout', 'stderr', 'output', 'error', 'errorMessage', 'text']
      .map(key => typeof record[key] === 'string' ? String(record[key]) : '')
      .filter(Boolean),
  ].filter(Boolean).join('\n');
  if (output) return executorResultExcerpt(output);

  try {
    return executorResultExcerpt(JSON.stringify(value));
  } catch {
    return '[unserializable tool result]';
  }
}

/** Redact while preserving line breaks so stdout/stderr remains readable. */
function executorResultExcerpt(value: string, limit = 1200): string {
  const normalized = redactSensitiveText(value.trim());
  if (normalized.length <= limit) return normalized;
  const tailLength = Math.min(320, Math.floor(limit / 3));
  const headLength = limit - tailLength - 32;
  return `${normalized.slice(0, headLength)}\n… [output truncated] …\n${normalized.slice(-tailLength)}`;
}

/** 脱敏 + 压缩空白 + 截断：Executor 活动文本进入用户可见进度的唯一通道。 */
export function executorActivityExcerpt(value: string, limit = 240): string {
  const normalized = redactSensitiveText(value.replace(/\s+/gu, ' ').trim());
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
}

function assistantTerminalError(message: Record<string, unknown>): string | null {
  const stopReason = typeof message.stopReason === 'string'
    ? message.stopReason.toLowerCase()
    : '';
  const errorMessage = typeof message.errorMessage === 'string'
    ? message.errorMessage.trim()
    : '';
  if (stopReason === 'error' || stopReason === 'aborted' || errorMessage) {
    return errorMessage || `Pi executor request ${stopReason || 'failed'}`;
  }
  return null;
}

async function defaultProbeCommand(command: string, args: readonly string[]) {
  try {
    const result = await execFileAsync(command, [...args], {
      env: { ...safeHostEnvironment(process.env), PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 5000, maxBuffer: 64 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; signal?: string; killed?: boolean; message?: string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: redactSensitiveText(failure.stderr?.trim() || (failure.killed
        ? `Pi probe timed out after 5000ms (signal=${failure.signal ?? 'unknown'})`
        : failure.message ?? `Pi probe failed (code=${failure.code ?? 'unknown'}, signal=${failure.signal ?? 'none'})`)),
    };
  }
}
