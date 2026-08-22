import { describe, expect, it } from 'vitest';
import { PI_WEB_EXTENSION_SOURCE } from '../../src/executor/pi-agent.js';

describe('Pi attempt extension', () => {
  it('registers attempt-scoped ResultReference list and get tools', () => {
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_list"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('name: "result_reference_get"');
    expect(PI_WEB_EXTENSION_SOURCE).toContain('callEvidence("result_reference_get"');
  });
});
