import { describe, expect, it } from 'vitest';
import {
  classifyCostEntry,
  isPayer,
  validatePlatformAbsorption,
} from '../../src/billing/cost-policy.js';

describe('classifyCostEntry', () => {
  it('charges platform-paid model and tool cost', () => {
    expect(classifyCostEntry({
      payer: 'platform',
      resource: 'model_tokens',
      hasPrice: true,
    })).toEqual({ disposition: 'eligible', billableBase: true, reason: 'platform_payer' });
    expect(classifyCostEntry({
      payer: 'platform',
      resource: 'tool_request',
      hasPrice: true,
    }).billableBase).toBe(true);
  });

  it('keeps user-paid model cost out of the platform base', () => {
    expect(classifyCostEntry({
      payer: 'user_direct',
      resource: 'model_tokens',
      hasPrice: true,
    })).toEqual({ disposition: 'absorbed', billableBase: false, reason: 'user_direct_payer' });
    expect(classifyCostEntry({
      payer: 'user_direct',
      resource: 'image',
      hasPrice: true,
    }).billableBase).toBe(false);
  });

  it('still charges MetaWork-provided execution resources for user-paid models', () => {
    expect(classifyCostEntry({
      payer: 'user_direct',
      resource: 'compute',
      hasPrice: true,
      metaWorkProvidedResource: true,
    })).toEqual({
      disposition: 'eligible',
      billableBase: true,
      reason: 'user_direct_model_metawork_resource',
    });
    // Not verifiably MetaWork-provided -> stay out of the base.
    expect(classifyCostEntry({
      payer: 'user_direct',
      resource: 'compute',
      hasPrice: true,
    }).billableBase).toBe(false);
  });

  it('never spreads system background cost onto the active Query', () => {
    expect(classifyCostEntry({
      payer: 'system',
      resource: 'model_tokens',
      hasPrice: true,
    })).toEqual({ disposition: 'absorbed', billableBase: false, reason: 'system_cost' });
  });

  it('keeps unknown payers in pending reconciliation', () => {
    expect(classifyCostEntry({
      payer: 'unknown',
      resource: 'model_tokens',
      hasPrice: true,
    })).toEqual({ disposition: 'pending', billableBase: false, reason: 'payer_unknown' });
  });

  it('absorbs platform-defect rework instead of passing it on', () => {
    expect(classifyCostEntry({
      payer: 'platform',
      resource: 'model_tokens',
      hasPrice: true,
      platformBorneDefect: true,
    })).toEqual({ disposition: 'absorbed', billableBase: false, reason: 'platform_defect_absorbed' });
  });

  it('never fabricates a charge for missing price or estimated quantity', () => {
    expect(classifyCostEntry({
      payer: 'platform',
      resource: 'search',
      hasPrice: false,
    })).toEqual({ disposition: 'pending', billableBase: false, reason: 'price_unavailable' });
    expect(classifyCostEntry({
      payer: 'platform',
      resource: 'model_tokens',
      hasPrice: true,
      quantityIsEstimate: true,
    })).toEqual({ disposition: 'pending', billableBase: false, reason: 'estimated_quantity' });
  });

  it('rejects an unknown payer string', () => {
    expect(isPayer('platform')).toBe(true);
    expect(isPayer('provider_name')).toBe(false);
    expect(() => classifyCostEntry({
      payer: 'anthropic' as never,
      resource: 'model_tokens',
      hasPrice: true,
    })).toThrow('invalid_payer');
  });
});

describe('validatePlatformAbsorption', () => {
  it('requires an audited decision before excluding a missing item', () => {
    const decision = validatePlatformAbsorption({
      reason: 'provider usage endpoint unavailable',
      authorizedBy: 'ops@metawork',
      decidedAt: '2026-09-21T10:00:00.000Z',
      missingCategories: ['model_tokens:out'],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(decision.missingCategories).toEqual(['model_tokens:out']);
  });

  it('rejects an unaudited or empty absorption', () => {
    expect(() => validatePlatformAbsorption({
      reason: '',
      authorizedBy: 'ops',
      decidedAt: 'now',
      missingCategories: ['x'],
    })).toThrow('invalid_absorption_reason');
    expect(() => validatePlatformAbsorption({
      reason: 'r',
      authorizedBy: ' ',
      decidedAt: 'now',
      missingCategories: ['x'],
    })).toThrow('invalid_absorption_authorizer');
    expect(() => validatePlatformAbsorption({
      reason: 'r',
      authorizedBy: 'ops',
      decidedAt: 'now',
      missingCategories: [],
    })).toThrow('invalid_absorption_categories');
  });
});
