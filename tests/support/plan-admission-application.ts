import type Database from 'better-sqlite3';
import { PlanAdmissionApplicationService } from '../../src/execution/plan-admission-application-service.js';
import { PlanAdmissionResultRepo } from '../../src/storage/plan-admission-result-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import type { PlanProposalStore } from '../../src/execution/plan-proposal-store.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import type { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import type { TaskRuntimeService } from '../../src/task/task-runtime-service.js';

/** Real owner services over one in-memory database, as account composition builds them. */
export function testPlanAdmissionApplication(deps: {
  db: Database.Database;
  taskRuntimeService: TaskRuntimeService;
  planProposals?: PlanProposalStore;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  conversationGit?: boolean;
}): {
  service: PlanAdmissionApplicationService;
  admissionResults: PlanAdmissionResultRepo;
  workGraphRuntimeService: WorkGraphRuntimeService;
} {
  const subtaskRepo = new SubtaskRepo(deps.db);
  const workGraphRuntimeService = new WorkGraphRuntimeService(
    subtaskRepo,
    new TaskEventRepo(deps.db),
    new WorkGraphRevisionRepo(deps.db),
    new TaskExecutionEvidenceRepo(deps.db),
  );
  const admissionResults = new PlanAdmissionResultRepo(deps.db);
  return {
    admissionResults,
    workGraphRuntimeService,
    service: new PlanAdmissionApplicationService({
      db: deps.db,
      taskRuntimeService: deps.taskRuntimeService,
      workGraphRuntimeService,
      // The admission application always reads the account proposal store; a
      // caller that only needs the graph/result half still gets the real one.
      planProposals: deps.planProposals ?? new PlanProposalRepo(deps.db),
      admissionResults,
      ...(deps.conversationTaskSchedulerRepo
        ? { conversationTaskSchedulerRepo: deps.conversationTaskSchedulerRepo }
        : {}),
      conversationGit: deps.conversationGit ?? false,
    }),
  };
}

/** Dependency bundle for `SessionControlRuntime` in tests. */
export function testPlanAdmissionDeps(
  db: Database.Database,
  taskRuntimeService: TaskRuntimeService,
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo,
): {
  planAdmissionResults: PlanAdmissionResultRepo;
  planAdmissionApplication: PlanAdmissionApplicationService;
} {
  // A graph revision requires its configuration revision; account composition
  // always supplies one, so the fixture mirrors that guarantee.
  db.prepare(`INSERT OR IGNORE INTO configuration_revisions
    (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-test', 'sha256:test', 'native', '2026-11-09T00:00:00.000Z')`).run();
  const bundle = testPlanAdmissionApplication({
    db,
    taskRuntimeService,
    ...(conversationTaskSchedulerRepo ? { conversationTaskSchedulerRepo } : {}),
  });
  return {
    planAdmissionResults: bundle.admissionResults,
    planAdmissionApplication: bundle.service,
  };
}
