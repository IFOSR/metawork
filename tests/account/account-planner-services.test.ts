import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { buildAccountPlannerServices } from '../../src/account/account-planner-services.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import {
  getDefaultPlannerProcessSupervisor,
  PlannerProcessSupervisor,
} from '../../src/planning/planner-process-supervisor.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

describe('buildAccountPlannerServices', () => {
  it('requires a revision-bound Planner supervisor in production composition', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    runMigrations(db);

    try {
      expect(() => buildAccountPlannerServices({
        db,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        contextRecaller: new ContextRecaller(db),
        plannerBinding: {
          agentClassRef: 'planner',
          harnessRef: 'anyfusion-planner',
          providerRef: 'deepseek',
          modelRef: 'deepseek-model',
          permissionProfileRef: null,
          configurationRevision: 'revision-deepseek',
        },
        plannerBindingFingerprint: 'sha256:planner',
        plannerModelId: 'deepseek-v4-pro',
      })).toThrow('revision-bound Planner supervisor is required');
    } finally {
      db.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      vi.unstubAllEnvs();
    }
  });

  it('rejects an explicitly injected Planner supervisor without a revision binding', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    runMigrations(db);

    try {
      expect(() => buildAccountPlannerServices({
        db,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        contextRecaller: new ContextRecaller(db),
        plannerBinding: {
          agentClassRef: 'planner',
          harnessRef: 'anyfusion-planner',
          providerRef: 'deepseek',
          modelRef: 'deepseek-model',
          permissionProfileRef: null,
          configurationRevision: 'revision-deepseek',
        },
        plannerBindingFingerprint: 'sha256:planner',
        plannerModelId: 'deepseek-v4-pro',
        plannerSupervisor: getDefaultPlannerProcessSupervisor(),
      })).toThrow('revision-bound Planner supervisor is required');
    } finally {
      db.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      vi.unstubAllEnvs();
    }
  });

  it('rejects a Planner supervisor whose expected model differs from the authorized model', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    runMigrations(db);
    const plannerSupervisor = new PlannerProcessSupervisor({
      configurationRevision: 'revision-deepseek',
      bindingFingerprint: 'sha256:planner',
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-wrong-model',
      },
      runtimeEnvironment: {
        OPENAI_BASE_URL: 'https://api.deepseek.example/v1',
        OPENAI_API_KEY: 'secret',
        OPENAI_API_KEY__DEEPSEEK: 'secret',
        OPENAI_MODEL: 'deepseek-wrong-model',
      },
    });

    try {
      expect(() => buildAccountPlannerServices({
        db,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        contextRecaller: new ContextRecaller(db),
        plannerBinding: {
          agentClassRef: 'planner',
          harnessRef: 'anyfusion-planner',
          providerRef: 'deepseek',
          modelRef: 'deepseek-model',
          permissionProfileRef: null,
          configurationRevision: 'revision-deepseek',
        },
        plannerBindingFingerprint: 'sha256:planner',
        plannerModelId: 'deepseek-v4-pro',
        plannerSupervisor,
      })).toThrow('Planner supervisor binding mismatch for revision revision-deepseek');
    } finally {
      db.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      vi.unstubAllEnvs();
    }
  });

  it('rejects a Planner supervisor without a resolved runtime environment', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    runMigrations(db);
    const plannerSupervisor = new PlannerProcessSupervisor({
      configurationRevision: 'revision-deepseek',
      bindingFingerprint: 'sha256:planner',
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
    });

    try {
      expect(() => buildAccountPlannerServices({
        db,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        contextRecaller: new ContextRecaller(db),
        plannerBinding: {
          agentClassRef: 'planner',
          harnessRef: 'anyfusion-planner',
          providerRef: 'deepseek',
          modelRef: 'deepseek-model',
          permissionProfileRef: null,
          configurationRevision: 'revision-deepseek',
        },
        plannerBindingFingerprint: 'sha256:planner',
        plannerModelId: 'deepseek-v4-pro',
        plannerSupervisor,
      })).toThrow('revision-bound Planner supervisor is required');
    } finally {
      db.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      vi.unstubAllEnvs();
    }
  });

  it('rejects conflicting generic and Provider-specific Planner credentials', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    runMigrations(db);
    const plannerSupervisor = new PlannerProcessSupervisor({
      configurationRevision: 'revision-deepseek',
      bindingFingerprint: 'sha256:planner',
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      runtimeEnvironment: {
        OPENAI_BASE_URL: 'https://api.deepseek.example/v1',
        OPENAI_API_KEY: 'legacy-secret',
        OPENAI_API_KEY__DEEPSEEK: 'revision-secret',
        OPENAI_MODEL: 'deepseek-v4-pro',
      },
    });

    try {
      expect(() => buildAccountPlannerServices({
        db,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        contextRecaller: new ContextRecaller(db),
        plannerBinding: {
          agentClassRef: 'planner',
          harnessRef: 'anyfusion-planner',
          providerRef: 'deepseek',
          modelRef: 'deepseek-model',
          permissionProfileRef: null,
          configurationRevision: 'revision-deepseek',
        },
        plannerBindingFingerprint: 'sha256:planner',
        plannerModelId: 'deepseek-v4-pro',
        plannerSupervisor,
      })).toThrow('revision-bound Planner supervisor is required');
    } finally {
      db.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      vi.unstubAllEnvs();
    }
  });
});
