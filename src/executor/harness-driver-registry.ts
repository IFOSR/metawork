import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type {
  AgentClassDefinition,
  HarnessDefinition,
  RuntimeConfigurationView,
  RuntimePrivateConfigurationBinding,
} from '../configuration/types.js';
import type { ExecutorAdapter } from './adapter.js';
import type { HarnessDriver } from './harness-driver.js';
import { harnessDriverCatalogEntry } from '../configuration/harness-driver-catalog.js';

export interface HarnessDriverAdapterFactoryInput {
  driver: HarnessDriver;
  configuration: RuntimeConfigurationView;
  agentClass: AgentClassDefinition;
  harness: HarnessDefinition;
  authorizedBinding: AuthorizedExecutorBinding;
  runtimeBinding: RuntimePrivateConfigurationBinding;
}

export type HarnessDriverAdapterFactory = (
  input: HarnessDriverAdapterFactoryInput,
) => ExecutorAdapter;

interface RegisteredHarnessDriver {
  driver: HarnessDriver;
  createAdapter: HarnessDriverAdapterFactory;
}

export class HarnessDriverRegistry {
  private readonly registrations = new Map<string, RegisteredHarnessDriver>();

  register(
    driver: HarnessDriver,
    createAdapter: HarnessDriverAdapterFactory,
  ): void {
    if (this.registrations.has(driver.id)) {
      throw new Error(`Harness driver is already registered: ${driver.id}`);
    }
    const catalogEntry = harnessDriverCatalogEntry(driver.id);
    if (
      !catalogEntry
      || !sameValues(driver.executionProtocols, catalogEntry.executionProtocols)
    ) {
      throw new Error(`Harness driver execution protocol mismatch: ${driver.id}`);
    }
    this.registrations.set(driver.id, { driver, createAdapter });
  }

  createAdapter(input: {
    configuration: RuntimeConfigurationView;
    authorizedBinding: AuthorizedExecutorBinding;
    runtimeBinding: RuntimePrivateConfigurationBinding;
  }): ExecutorAdapter {
    const { configuration, authorizedBinding, runtimeBinding } = input;
    requireRevision(configuration.revisionId, authorizedBinding, runtimeBinding);

    const agentClass = configuration.agentClasses[authorizedBinding.agentClassRef];
    if (!agentClass || !agentClass.enabled || agentClass.kind !== 'executor') {
      throw new Error(
        `Executor AgentClass is not enabled in configuration: ${authorizedBinding.agentClassRef}`,
      );
    }
    if (agentClass.harnessRef !== authorizedBinding.harnessRef) {
      throw new Error(
        `AgentClass ${authorizedBinding.agentClassRef} is bound to Harness `
        + `${agentClass.harnessRef}, not ${authorizedBinding.harnessRef}`,
      );
    }

    const harness = configuration.harnesses[agentClass.harnessRef];
    if (!harness || !harness.enabled || harness.kind !== 'executor') {
      throw new Error(`Executor Harness is not enabled in configuration: ${agentClass.harnessRef}`);
    }

    const model = configuration.models[authorizedBinding.modelRef];
    if (!model || !model.enabled || model.providerRef !== authorizedBinding.providerRef) {
      throw new Error(
        `Model binding is not enabled in configuration: ${authorizedBinding.modelRef}`,
      );
    }
    if (
      agentClass.permissionProfileRef !== authorizedBinding.permissionProfileRef
      || !configuration.permissionProfiles[authorizedBinding.permissionProfileRef]
    ) {
      throw new Error(
        `Permission profile binding is not enabled in configuration: `
        + authorizedBinding.permissionProfileRef,
      );
    }

    const registration = this.registrations.get(harness.driverId);
    if (!registration) {
      throw new Error(`Harness driver is not registered: ${harness.driverId}`);
    }

    return registration.createAdapter({
      driver: registration.driver,
      configuration,
      agentClass,
      harness,
      authorizedBinding,
      runtimeBinding,
    });
  }

  supportsContinuation(input: {
    configuration: RuntimeConfigurationView;
    agentClassRef: string;
  }): boolean {
    const resolved = this.resolveRegistration(input);
    return Boolean(
      resolved?.harness.supportsContinuation
      && resolved.registration.driver.supportsContinuation,
    );
  }

  supportsResponseOnly(input: {
    configuration: RuntimeConfigurationView;
    agentClassRef: string;
  }): boolean {
    const resolved = this.resolveRegistration(input);
    return Boolean(resolved?.registration.driver.supportsResponseOnly);
  }

  private resolveRegistration(input: {
    configuration: RuntimeConfigurationView;
    agentClassRef: string;
  }): {
    harness: HarnessDefinition;
    registration: RegisteredHarnessDriver;
  } | null {
    const agentClass = input.configuration.agentClasses[input.agentClassRef];
    if (!agentClass?.enabled || agentClass.kind !== 'executor') return null;
    const harness = input.configuration.harnesses[agentClass.harnessRef];
    if (!harness?.enabled || harness.kind !== 'executor') return null;
    const registration = this.registrations.get(harness.driverId);
    return registration ? { harness, registration } : null;
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function requireRevision(
  configurationRevision: string,
  authorizedBinding: AuthorizedExecutorBinding,
  runtimeBinding: RuntimePrivateConfigurationBinding,
): void {
  if (
    authorizedBinding.configurationRevision !== configurationRevision
    || runtimeBinding.revisionId !== configurationRevision
  ) {
    throw new Error(
      `Configuration revision mismatch: expected ${configurationRevision}, received `
      + `${authorizedBinding.configurationRevision}/${runtimeBinding.revisionId}`,
    );
  }
}
