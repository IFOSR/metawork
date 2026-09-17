import { publicDisplayNameFromRef } from './public-provider-catalog.js';

export const DEFAULT_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'pi-agent': '智能体 1',
  'codex-cli': '智能体 2',
};

export function resolveAgentDisplayName(
  agentClassRef: string,
  configured?: string,
): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return DEFAULT_AGENT_DISPLAY_NAMES[agentClassRef]
    ?? publicDisplayNameFromRef(agentClassRef);
}

export function resolveProviderDisplayName(
  providerRef: string,
  configured?: string,
  catalogLabel?: string,
): string {
  return configured?.trim()
    || catalogLabel?.trim()
    || publicDisplayNameFromRef(providerRef);
}
