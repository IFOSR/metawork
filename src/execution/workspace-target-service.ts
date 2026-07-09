// Ensures filesystem target directories exist before executors write task artifacts.
import { mkdirSync } from 'fs';

/** Creates requested workspace target directories for execution outputs. */
export class WorkspaceTargetService {
  ensureTargets(targetPaths: string[]): void {
    for (const targetPath of targetPaths) {
      mkdirSync(targetPath, { recursive: true });
    }
  }
}
