import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_WIZARD_ORDER,
  nextWizardStep,
  validateWizardInput,
} from '../../src/installation/configuration-wizard.js';

describe('configuration-wizard', () => {
  it('validates complete input', () => {
    expect(validateWizardInput({
      region: 'international',
      providerUrl: 'https://api.example.com/v1',
      providerKeyRef: 'keychain:anyfusion/provider',
      plannerHarnessRef: 'anyfusion-planner',
      plannerModelRef: 'test-model',
    })).toEqual({ ok: true, issues: [] });
  });

  it('reports every missing required field', () => {
    const result = validateWizardInput({ region: 'international' });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      'providerUrl is required',
      'providerKeyRef is required',
      'plannerHarnessRef is required',
      'plannerModelRef is required',
    ]);
  });

  it('advances through the wizard order and stays on the last step', () => {
    expect(CONFIGURATION_WIZARD_ORDER[0]).toBe('region');
    expect(CONFIGURATION_WIZARD_ORDER.at(-1)).toBe('activation');
    expect(nextWizardStep(null)).toBe('region');
    expect(nextWizardStep('region')).toBe('provider_secret');
    expect(nextWizardStep('activation')).toBe('activation');
  });
});
