// Tracks executor progress events as verifier evidence without exposing process logs to users.
import type Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorProgressEvent } from '../executor/adapter.js';
import { parseSkillUsageEventLine } from '../executor/skill-usage-event-parser.js';
import { SkillUsageEventRepo } from '../storage/skill-usage-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface ExecutionProgressTracker {
  readonly evidenceText: string[];
  onProgress(event: ExecutorProgressEvent, executor: ExecutorAdapter): void;
}

export interface ExecutionProgressTrackerInput {
  taskId: string;
  executionId: string;
}

/** Creates per-execution trackers that retain only structured, redacted skill evidence. */
export class ExecutionProgressService {
  constructor(private readonly db: Database.Database) {}

  createTracker(input: ExecutionProgressTrackerInput): ExecutionProgressTracker {
    const skillUsageEventRepo = new SkillUsageEventRepo(this.db);
    const evidenceText: string[] = [];
    return {
      evidenceText,
      onProgress: (event, executor) => {
        const parsedSkillEvent = event.skillEvent ?? parseSkillUsageEventLine(event.text);
        if (!parsedSkillEvent) {
          return;
        }
        evidenceText.push([
          `skill_event=${parsedSkillEvent.eventType}`,
          `skill=${parsedSkillEvent.skillName}`,
          `message=${parsedSkillEvent.message}`,
          `payload=${JSON.stringify(parsedSkillEvent.payload)}`,
        ].join(' '));
        skillUsageEventRepo.insert({
          id: `sue_${generateInteractionId()}`,
          taskId: input.taskId,
          executionId: input.executionId,
          executorName: executor.name,
          skillName: parsedSkillEvent.skillName,
          skillVersion: parsedSkillEvent.skillVersion,
          eventType: parsedSkillEvent.eventType,
          message: parsedSkillEvent.message,
          payload: parsedSkillEvent.payload,
          createdAt: new Date().toISOString(),
        });
      },
    };
  }
}
