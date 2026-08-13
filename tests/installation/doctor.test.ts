import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallationDoctor } from '../../src/installation/doctor.js';

describe('installation doctor', () => {
  it('checks required paths and detects commands without modifying them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-doctor-'));
    try {
      for (const dir of ['dist', 'node_modules', 'planner']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(join(root, 'package.json'), '{}');

      const checks = await runInstallationDoctor({
        installRoot: root,
        detectCommand: async command => command === 'codex',
      });

      const byName = Object.fromEntries(checks.map(check => [check.name, check]));
      expect(byName['dist']!.ok).toBe(true);
      expect(byName['planner']!.ok).toBe(true);
      expect(byName['package.json']!.ok).toBe(true);
      expect(byName['codex_detected']!.ok).toBe(true);
      expect(byName['pi_detected']!.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing required paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-doctor-empty-'));
    try {
      const checks = await runInstallationDoctor({
        installRoot: root,
        detectCommand: async () => false,
      });
      const byName = Object.fromEntries(checks.map(check => [check.name, check]));
      expect(byName['dist']!.ok).toBe(false);
      expect(byName['planner']!.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
