/**
 * 账户级 Task/AgentClass/执行后端服务簇（ADR-0031 第 2 节）。
 *
 * TaskRuntimeService、AgentClassService 与 AttemptExecutionBackend 是账户
 * 作用域的 runtime-wide 服务，按账户构造一次。
 */

import type { TaskEngine } from '../task/task-engine.js';
import { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { TaskLifecyclePort } from '../task/task-lifecycle-transition-port.js';
import { AgentClassService } from '../executor/agent-class-service.js';
import type { AttemptExecutionBackend } from '../execution/attempt-execution-backend.js';
import { DockerCliAttemptExecutionBackend } from '../execution/docker-cli-attempt-execution-backend.js';
import { NativeAttemptExecutionBackend } from '../execution/native-attempt-execution-backend.js';

export interface AccountTaskServices {
  readonly taskRuntimeService: TaskRuntimeService;
  readonly agentClassService: AgentClassService;
  readonly attemptExecutionBackend: AttemptExecutionBackend;
}

export function buildAccountTaskServices(deps: {
  taskEngine: TaskEngine;
  /** The durable Task state entry. Required: there is no second status writer. */
  lifecyclePort: Pick<TaskLifecyclePort, 'applyTaskChange'>;
  agentClasses?: ConstructorParameters<typeof AgentClassService>[0]['agentClasses'];
  getAgentClasses?: ConstructorParameters<typeof AgentClassService>[0]['getAgentClasses'];
  attemptExecutionBackend?: AttemptExecutionBackend;
  nativeStateRoot?: string;
}): AccountTaskServices {
  return {
    taskRuntimeService: new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
      lifecyclePort: deps.lifecyclePort,
    }),
    agentClassService: new AgentClassService({
      agentClasses: deps.agentClasses,
      getAgentClasses: deps.getAgentClasses,
    }),
    attemptExecutionBackend: deps.attemptExecutionBackend ?? createDefaultAttemptExecutionBackend(deps.nativeStateRoot),
  };
}

export function createDefaultAttemptExecutionBackend(stateRoot?: string): AttemptExecutionBackend {
  const backend = (process.env.METACLAW_EXECUTOR_BACKEND ?? 'native').trim().toLowerCase();
  if (backend === 'docker' || backend === 'container') return new DockerCliAttemptExecutionBackend();
  // `in_place` is the retired name of the native backend. A Desktop shell that
  // still launches the Runtime with it must keep working: the running shell is
  // only replaced after this Runtime starts, so rejecting the old value would
  // deadlock the upgrade ("runtime-not-ready") and roll back forever.
  if (backend === 'native' || backend === 'in_place' || backend === '') {
    return new NativeAttemptExecutionBackend(stateRoot);
  }
  throw new Error(`Unsupported METACLAW_EXECUTOR_BACKEND: ${backend}; use native or docker`);
}
