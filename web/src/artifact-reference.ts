import type { ArtifactProjection } from './api/session-types';

export interface ArtifactReferenceMatch {
  start: number;
  end: number;
  text: string;
  artifact: ArtifactProjection;
}

interface ArtifactReferenceCandidate {
  text: string;
  artifact: ArtifactProjection;
}

/**
 * Finds artifact paths/names in delivered text without exposing a new URL
 * scheme. The caller renders each match as a button backed by artifactId.
 */
export function findArtifactReferences(
  value: string,
  artifacts: ArtifactProjection[],
): ArtifactReferenceMatch[] {
  const candidates = uniqueCandidates(artifacts)
    .sort((left, right) => right.text.length - left.text.length);
  if (candidates.length === 0) return [];

  const pattern = new RegExp(
    candidates.map(candidate => escapeRegExp(candidate.text)).join('|'),
    'g',
  );
  const matches: ArtifactReferenceMatch[] = [];
  for (const match of value.matchAll(pattern)) {
    const text = match[0];
    const start = match.index ?? -1;
    if (start < 0) continue;
    const candidate = candidates.find(item => item.text === text);
    if (!candidate) continue;
    const previous = value[start - 1];
    const next = value[start + text.length];
    if (
      text === candidate.artifact.displayName
      && isFilenameCharacter(previous)
      && isFilenameCharacter(next)
    ) {
      continue;
    }
    matches.push({
      start,
      end: start + text.length,
      text,
      artifact: candidate.artifact,
    });
  }
  return matches;
}

function uniqueCandidates(artifacts: ArtifactProjection[]): ArtifactReferenceCandidate[] {
  const seen = new Set<string>();
  const candidates: ArtifactReferenceCandidate[] = [];
  for (const artifact of artifacts) {
    for (const value of [
      artifact.relativePath,
      artifact.relativePath.replaceAll('/', '\\'),
      artifact.displayName,
    ]) {
      const text = value.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      candidates.push({ text, artifact });
    }
  }
  return candidates;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isFilenameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_.-]/u.test(value);
}
