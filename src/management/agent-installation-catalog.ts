export type SupportedAgentId = 'pi-agent' | 'codex-cli';

export interface AgentInstallationDefinition {
  agentId: SupportedAgentId;
  command: string;
  args: readonly string[];
  required: boolean;
  installUrl: string;
}

export const AGENT_INSTALLATION_CATALOG: readonly AgentInstallationDefinition[] = [
  {
    agentId: 'pi-agent',
    command: 'pi',
    args: ['--version'],
    required: true,
    installUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
  },
  {
    agentId: 'codex-cli',
    command: 'codex',
    args: ['--version'],
    required: false,
    installUrl: 'https://developers.openai.com/codex/cli/',
  },
];
