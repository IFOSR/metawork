/**
 * Memory sidecar configuration.
 *
 * The engine is configured to match the MetaWork memory contract (design §5.4):
 * MetaWork already deposits whole segments, so the engine must not wait for a
 * conversation count, must not warm up exponentially, and must extract shortly
 * after a deposit. BM25 is the only retrieval path, so the FTS5 gate applies.
 *
 * The generated file never contains a credential: the extraction key is
 * injected through the sidecar environment only.
 */

export interface MemorySidecarConfigInput {
  port: number;
  dataDir: string;
  baseUrl: string;
  model: string;
  apiKeyEnvVar: string;
  serviceId: string;
}

export function renderMemorySidecarConfig(input: MemorySidecarConfigInput): string {
  return `deployMode: standalone
stateBackend: "local"

server:
  port: ${input.port}
  host: "127.0.0.1"
  # Bearer gate. The token lives only in the sidecar environment and in the
  # MetaWork SecretStore; it never enters the Server process.env, which the
  # Planner process tree inherits (design §6.4).
  apiKey: "\${${KERNEL_AUTH_TOKEN_ENV_VAR}}"

data:
  baseDir: ${yamlString(input.dataDir)}

llm:
  baseUrl: ${yamlString(input.baseUrl)}
  apiKey: "\${${input.apiKeyEnvVar}}"
  model: ${yamlString(input.model)}
  maxTokens: 4096
  timeoutMs: 120000

memory:
  capture:
    enabled: true
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
    triggerMode: current
  pipeline:
    everyNConversations: 1
    enableWarmup: false
    l1IdleTimeoutSeconds: 30
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"
    timeoutMs: 5000
  storeBackend: "sqlite"
  embedding:
    provider: "none"
  bm25:
    enabled: true
    language: "zh"
`;
}

/** Environment variable that carries the engine Bearer gate into the sidecar. */
export const KERNEL_AUTH_TOKEN_ENV_VAR = 'TDAI_KERNEL_AUTH_TOKEN';

/** Minimal YAML string quoting for values that may contain spaces or colons. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}
