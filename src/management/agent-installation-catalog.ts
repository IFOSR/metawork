import {
  DEFAULT_TOOL_PROBE_POLICY,
  MANAGED_TOOL_PROBE_POLICY,
  type ToolProbePolicy,
} from '../executor/tool-probe.js';

export type SupportedAgentId = 'pi-agent' | 'codex-cli';

export interface AgentInstallationDefinition {
  agentId: SupportedAgentId;
  command: string;
  args: readonly string[];
  required: boolean;
  installUrl: string;
  /**
   * 探测策略：受管 Pi 是随包自包含二进制，首次启动要付出镜像加载与主机扫描
   * 的冷启动代价，必须给更长预算并允许重试，否则健康安装会被判成损坏。
   */
  probe: ToolProbePolicy;
}

export const AGENT_INSTALLATION_CATALOG: readonly AgentInstallationDefinition[] = [
  {
    agentId: 'pi-agent',
    command: 'pi',
    args: ['--version'],
    required: true,
    installUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
    probe: MANAGED_TOOL_PROBE_POLICY,
  },
  {
    agentId: 'codex-cli',
    command: 'codex',
    args: ['--version'],
    required: false,
    installUrl: 'https://developers.openai.com/codex/cli/',
    probe: DEFAULT_TOOL_PROBE_POLICY,
  },
];

/**
 * 安装探测以 CLI 命令为物理身份，AgentClass 以 harness 引用为配置身份。
 * 两者靠 harness 的 local-cli command 对应起来，用于让“就绪卡片”和“智能体名称”
 * 显示同一个名字：安装 → 命令 → Harness → AgentClass。
 *
 * 多class共用同一命令时按 ref 字典序取第一个，保证结果稳定。
 */
export function agentClassRefForInstallation(input: {
  agentId: SupportedAgentId;
  agentClasses: Readonly<Record<string, { readonly harnessRef: string } | undefined>>;
  harnesses: Readonly<Record<string, {
    readonly transport?: string;
    readonly command?: string;
  } | undefined>>;
}): string | null {
  const definition = AGENT_INSTALLATION_CATALOG.find(item => item.agentId === input.agentId);
  if (!definition) return null;
  for (const ref of Object.keys(input.agentClasses).sort()) {
    const agentClass = input.agentClasses[ref];
    if (!agentClass) continue;
    const harness = input.harnesses[agentClass.harnessRef];
    if (harness?.transport === 'local-cli' && harness.command === definition.command) {
      return ref;
    }
  }
  return null;
}
