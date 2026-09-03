import type { Config } from '../core/types.js';
import type { ConfigurationSnapshot, HarnessDefinition } from './types.js';

const DEFAULT_MAX_CONCURRENT_ATTEMPTS = 4;
const DEFAULT_MAX_CONCURRENT_TASKS = 2;
const DEFAULT_MAX_CONCURRENT_ATTEMPTS_PER_TASK = 2;
const DEFAULT_SCHEDULING_AGING_MS = 300_000;
const DEFAULT_SAME_CONVERSATION_QUEUE_LIMIT = 8;

export function buildApplicationConfig(snapshot: ConfigurationSnapshot): Config {
  return {
    version: 2,
    executor: {
      command: defaultExecutorCommand(snapshot) ?? 'codex',
      timeout: Math.ceil((snapshot.config.runtimePolicy.attemptTimeoutMs ?? 300_000) / 1_000),
      max_duration: Math.ceil((snapshot.config.runtimePolicy.attemptTimeoutMs ?? 3_600_000) / 1_000),
    },
    orchestration: {
      reminder_enabled: true,
      reminder_throttle: 300,
      top_k_preferences: 5,
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 60,
      max_concurrent_attempts:
        snapshot.config.runtimePolicy.maxConcurrentAttempts
        ?? DEFAULT_MAX_CONCURRENT_ATTEMPTS,
      max_concurrent_tasks:
        snapshot.config.runtimePolicy.maxConcurrentTasks
        ?? DEFAULT_MAX_CONCURRENT_TASKS,
      max_concurrent_attempts_per_task:
        snapshot.config.runtimePolicy.maxConcurrentAttemptsPerTask
        ?? DEFAULT_MAX_CONCURRENT_ATTEMPTS_PER_TASK,
      scheduling_aging_ms:
        snapshot.config.runtimePolicy.schedulingAgingMs
        ?? DEFAULT_SCHEDULING_AGING_MS,
      same_conversation_queue_limit:
        snapshot.config.runtimePolicy.sameConversationQueueLimit
        ?? DEFAULT_SAME_CONVERSATION_QUEUE_LIMIT,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
    notifications: {
      feishu: { enabled: false },
    },
    integrations: {
      markdown_preview: {
        enabled: true,
        host: '127.0.0.1',
        port: 8790,
      },
    },
    gateway: {
      enabled: snapshot.config.gateway.enabled ?? false,
      platforms: {
        feishu: projectFeishuPlatform(snapshot.config.gateway.platforms?.feishu),
      },
    },
  };
}

function projectFeishuPlatform(
  feishu: import('./types.js').FeishuGatewayPlatformDefinition | undefined,
): NonNullable<NonNullable<Config['gateway']>['platforms']>['feishu'] {
  if (!feishu) {
    return {
      enabled: false,
      domain: 'feishu',
      connection_mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    };
  }
  return { ...feishu };
}

function defaultExecutorCommand(snapshot: ConfigurationSnapshot): string | null {
  for (const [, agentClass] of Object.entries(snapshot.config.agentClasses).sort()) {
    if (agentClass.kind !== 'executor') continue;
    const harness = snapshot.config.harnesses[agentClass.harnessRef];
    const command = localCliCommand(harness);
    if (command) return command;
  }
  return null;
}

function localCliCommand(harness: HarnessDefinition | undefined): string | null {
  return harness?.transport === 'local-cli' ? harness.command : null;
}
