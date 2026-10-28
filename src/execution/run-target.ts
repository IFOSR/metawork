/**
 * Target-project resolution for a follow-up run operation.
 *
 * A Conversation's Workspace can hold several delivered projects. A follow-up
 * Turn ("启动刚才的网站") names one of them, and the Runtime must resolve *that*
 * project from durable facts instead of inheriting whatever service
 * specification happens to sit at the Workspace root
 * (2026-10-28 transparent execution §optional service specification).
 *
 * This module is pure: it only classifies Workspace-relative paths. Reading
 * files, validating specifications and starting processes stay in the Runtime.
 */

export const LOCAL_SERVICE_MANIFEST_FILENAME = '.metawork-service.json';

/** Files whose presence makes their directory a runnable project candidate. */
const ENTRY_FILENAMES = new Set([
  'package.json',
  'server.js',
  'server.mjs',
  'server.cjs',
  'index.js',
  'index.mjs',
  'app.js',
  'app.mjs',
  'main.js',
  'main.mjs',
  'server.py',
  'app.py',
  'main.py',
]);

export interface RunTargetCandidate {
  /**
   * Workspace-relative project directory. `''` is the published Workspace
   * root; `deliverables/ai-radar-site` is a project inside it.
   */
  targetPath: string;
  /** Why this directory is a run candidate. */
  evidence: 'manifest' | 'artifact';
}

/**
 * Resolve the run-target candidates of one Task.
 *
 * The Task's own delivered artifacts decide the target. A Workspace-root
 * manifest is only a candidate when the Task delivered no project artifact of
 * its own — an old service file at the root must never become the target of a
 * newly delivered project.
 */
export function resolveRunTargetCandidates(input: {
  artifactPaths: readonly string[];
  /** Workspace-relative manifests the Runtime observed for this Task. */
  manifestPaths?: readonly string[];
}): RunTargetCandidate[] {
  const manifests = new Set(
    (input.manifestPaths ?? []).flatMap(path => {
      const normalized = normalizeRelativePath(path);
      return normalized && baseName(normalized) === LOCAL_SERVICE_MANIFEST_FILENAME
        ? [dirName(normalized)]
        : [];
    }),
  );
  const found = new Map<string, RunTargetCandidate>();
  for (const path of input.artifactPaths) {
    const normalized = normalizeRelativePath(path);
    if (!normalized) continue;
    const name = baseName(normalized);
    if (!ENTRY_FILENAMES.has(name)) continue;
    const targetPath = dirName(normalized);
    found.set(targetPath, {
      targetPath,
      evidence: manifests.has(targetPath) ? 'manifest' : 'artifact',
    });
  }
  // A manifest defines a target only when the Task delivered no runnable
  // project of its own. Otherwise an old file at the Workspace root would
  // compete with the project the user just received.
  if (found.size === 0) {
    for (const targetPath of manifests) {
      found.set(targetPath, { targetPath, evidence: 'manifest' });
    }
  }
  return [...found.values()].sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

/**
 * The project that contains `targetPath`, or `targetPath` itself. Used to keep
 * a root manifest from overriding a resolved sub-project.
 */
export function isWithinTarget(candidatePath: string, targetPath: string): boolean {
  if (targetPath === '') return true;
  return candidatePath === targetPath || candidatePath.startsWith(`${targetPath}/`);
}

function normalizeRelativePath(value: string): string | null {
  if (!value || typeof value !== 'string') return null;
  const unified = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!unified || unified.startsWith('/') || /^[a-zA-Z]:/u.test(unified)) return null;
  const segments = unified.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.includes('..')) return null;
  return segments.join('/');
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}
