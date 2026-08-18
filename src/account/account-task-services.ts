/**
 * 账户级 Task/AgentClass/执行后端服务簇（ADR-0031 第 2 节）。
 *
 * TaskRuntimeService、AgentClassService 与 AttemptExecutionBackend 是账户
 * 作用域的 runtime-wide 服务，按账户构造一次。
 */

import type { TaskEngine } from '../task/task-engine.js';
import { TaskRuntimeService } from '../task/task-runtime-service.js';
import { AgentClassService } from '../executor/agent-class-service.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import { DockerCliAttemptExecutionBackend } from '../execution/docker-cli-attempt-execution-backend.js';
import { WorktreeAttemptExecutionBackend } from '../execution/worktree-attempt-execution-backend.js';

export interface AccountTaskServices {
  readonly taskRuntimeService: TaskRuntimeService;
  readonly agentClassService: AgentClassService;
  readonly attemptExecutionBackend: AttemptExecutionBackend;
}

export function buildAccountTaskServices(deps: {
  taskEngine: TaskEngine;
  agentClasses: ConstructorParameters<typeof AgentClassService>[0]['agentClasses'];
  attemptExecutionBackend?: AttemptExecutionBackend;
}): AccountTaskServices {
  return {
    taskRuntimeService: new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
    }),
    agentClassService: new AgentClassService({
      agentClasses: deps.agentClasses,
    }),
    attemptExecutionBackend: deps.attemptExecutionBackend ?? createDefaultAttemptExecutionBackend(),
  };
}

function createDefaultAttemptExecutionBackend(): AttemptExecutionBackend {
  const backend = (process.env.METACLAW_EXECUTOR_BACKEND ?? 'worktree').trim().toLowerCase();
  if (backend === 'docker' || backend === 'container') return new DockerCliAttemptExecutionBackend();
  if (backend === 'worktree' || backend === 'native' || backend === '') return new WorktreeAttemptExecutionBackend();
  throw new Error(`Unsupported METACLAW_EXECUTOR_BACKEND: ${backend}`);
}
