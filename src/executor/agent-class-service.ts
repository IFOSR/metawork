// Provides AgentClass persistence helpers. Runtime WorkUnits are provisioned after authorization.
import type Database from 'better-sqlite3';
import type { AgentClass, AgentClassKind } from '../core/types.js';
import { seedDefaultAgentClasses, seedDefaultWorkUnits } from './agent-class-seeder.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { isBuiltinExecutorName } from './builtin-executor-catalog.js';

export interface AgentClassServiceDeps {
  db: Database.Database;
  defaultExecutorName: string;
  availableCommands?: Set<string>;
}

/** Owns the static AgentClass catalog; executor WorkUnits are provisioned by Runtime. */
export class AgentClassService {
  private readonly agentClassRepo: AgentClassRepo;
  private readonly workUnitRepo: WorkUnitRepo;

  constructor(private readonly deps: AgentClassServiceDeps) {
    this.agentClassRepo = new AgentClassRepo(deps.db);
    this.workUnitRepo = new WorkUnitRepo(deps.db);
  }

  seedDefaults(): void {
    seedDefaultAgentClasses(this.agentClassRepo, {
      defaultExecutorName: this.deps.defaultExecutorName,
      availableCommands: this.deps.availableCommands,
    });
    seedDefaultWorkUnits(this.workUnitRepo, {
      executorAgentClassName: this.deps.defaultExecutorName,
    });
  }

  listAgentClasses(): AgentClass[] {
    return this.agentClassRepo.findAll();
  }

  listByKind(kind: AgentClassKind): AgentClass[] {
    return this.agentClassRepo.findByKind(kind);
  }

  findByName(name: string): AgentClass | null {
    return this.agentClassRepo.findByName(name);
  }

  setResolvedImageId(name: string, imageId: string): void {
    this.agentClassRepo.setResolvedImageId(name, imageId);
  }

  upsert(agentClass: AgentClass): void {
    if (isBuiltinExecutorName(agentClass.name)) {
      throw new Error(`Cannot overwrite canonical Executor AgentClass: ${agentClass.name}`);
    }
    this.agentClassRepo.upsert(agentClass);
  }
}
