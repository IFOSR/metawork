import { describe, expect, it } from 'vitest';
import { buildPlannerInputProfile } from '../../src/planning/planner-input-profile.js';

describe('buildPlannerInputProfile', () => {
  it('requires vision without using semantic keywords', () => {
    const profile = buildPlannerInputProfile({
      userInput: 'please process this attachment',
      images: [{ name: 'diagram.png', mimeType: 'image/png', data: 'data' }],
    });

    expect(profile.requiredCapabilities).toEqual([
      'planning',
      'structured-output',
      'vision',
    ]);
    expect(profile.imageCount).toBe(1);
    expect(profile.imageMimes).toEqual(['image/png']);
    expect(profile.attachmentCount).toBe(1);
  });

  it('adds long-context requirements from structural input size', () => {
    const profile = buildPlannerInputProfile({ userInput: 'x'.repeat(64_001) });

    expect(profile.requiredCapabilities).toContain('long-context');
    expect(profile.contextTokens).toBeGreaterThan(16_000);
    expect(profile.requiresStructuredOutput).toBe(true);
  });
});
