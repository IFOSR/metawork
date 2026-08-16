import type {
  ConfigurationProbeResult,
  ConfigurationServiceDependencies,
} from '../configuration/configuration-service.js';
import type {
  ConfigurationSnapshot,
  HarnessDriverId,
} from '../configuration/types.js';
import { CodexCliDriver } from './codex-cli-driver.js';
import type { HarnessDriver, HarnessProbeResult } from './harness-driver.js';
import { PiCliDriver } from './pi-cli-driver.js';

type ProbeDriver = Pick<HarnessDriver, 'probe'>;

export async function probeLocalExecutorHarnesses(
  snapshot: ConfigurationSnapshot,
  drivers: ReadonlyMap<string, ProbeDriver>,
): Promise<ConfigurationProbeResult> {
  const harnesses = new Map<string, {
    harnessRef: string;
    driverId: HarnessDriverId;
  }>();
  for (const agentClass of Object.values(snapshot.config.agentClasses)) {
    if (!agentClass.enabled || agentClass.kind !== 'executor') continue;
    const harness = snapshot.config.harnesses[agentClass.harnessRef];
    if (!harness?.enabled || harness.kind !== 'executor' || !harness.supportsProbe) continue;
    harnesses.set(agentClass.harnessRef, {
      harnessRef: agentClass.harnessRef,
      driverId: harness.driverId,
    });
  }

  const issues: string[] = [];
  const results = new Map<string, HarnessProbeResult>();
  for (const { harnessRef, driverId } of harnesses.values()) {
    const driver = drivers.get(driverId);
    if (!driver) {
      issues.push(`Harness ${harnessRef} (${driverId}) has no local probe implementation`);
      continue;
    }
    let result = results.get(driverId);
    if (!result) {
      result = await driver.probe();
      results.set(driverId, result);
    }
    if (!result.available) {
      issues.push(
        `Harness ${harnessRef} (${driverId}) unavailable: `
        + `${result.detail?.trim() || 'probe failed'}`,
      );
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export function createLocalExecutorConfigurationProbe(): NonNullable<
  ConfigurationServiceDependencies['probe']
> {
  const drivers = new Map<string, ProbeDriver>([
    ['codex-cli', new CodexCliDriver()],
    ['pi-cli', new PiCliDriver()],
  ]);
  return snapshot => probeLocalExecutorHarnesses(snapshot, drivers);
}
