// Defines the native configuration wizard order and its non-interactive input
// contract. A config file may drive the same steps without prompting; missing
// Executor commands create disabled profiles rather than failing the install.
export const CONFIGURATION_WIZARD_ORDER = [
  'region',
  'provider_secret',
  'planner_harness',
  'planner_model_policy',
  'executor_command_detection',
  'executor_agent_classes',
  'model_permission_skill_bindings',
  'validation_summary',
  'activation',
] as const;

export type ConfigurationWizardStep = typeof CONFIGURATION_WIZARD_ORDER[number];

export interface ConfigurationWizardInput {
  region?: string;
  providerUrl?: string;
  providerKeyRef?: string;
  plannerHarnessRef?: string;
  plannerModelRef?: string;
  executorCommands?: Record<string, string>;
}

export interface WizardValidationResult {
  ok: boolean;
  issues: string[];
}

export function validateWizardInput(input: ConfigurationWizardInput): WizardValidationResult {
  const issues: string[] = [];
  if (!input.region?.trim()) issues.push('region is required');
  if (!input.providerUrl?.trim()) issues.push('providerUrl is required');
  if (!input.providerKeyRef?.trim()) issues.push('providerKeyRef is required');
  if (!input.plannerHarnessRef?.trim()) issues.push('plannerHarnessRef is required');
  if (!input.plannerModelRef?.trim()) issues.push('plannerModelRef is required');
  return { ok: issues.length === 0, issues };
}

export function nextWizardStep(current: ConfigurationWizardStep | null): ConfigurationWizardStep {
  if (!current) return CONFIGURATION_WIZARD_ORDER[0];
  const index = CONFIGURATION_WIZARD_ORDER.indexOf(current);
  return CONFIGURATION_WIZARD_ORDER[Math.min(index + 1, CONFIGURATION_WIZARD_ORDER.length - 1)]!;
}
