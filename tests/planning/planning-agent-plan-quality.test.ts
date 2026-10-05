import { describe, expect, it } from 'vitest';
import { collectWorkGraphQualityWarnings } from '../../src/planning/planning-agent-plan-validator.js';
import { dagQualityFixtures } from './dag-quality-fixtures.js';

describe('Planner Work Graph quality fixtures', () => {
  for (const fixture of dagQualityFixtures) {
    it(fixture.name, () => {
      expect(collectWorkGraphQualityWarnings(fixture.plan).length > 0).toBe(fixture.warning);
    });
  }
});
