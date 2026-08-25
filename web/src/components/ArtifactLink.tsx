import type { ArtifactProjection } from '../api/session-types';

export function ArtifactLink({
  artifact,
  onOpen,
}: {
  artifact: ArtifactProjection;
  onOpen: (artifact: ArtifactProjection) => void;
}) {
  return (
    <button
      type="button"
      className="artifact-link"
      data-preview-kind={artifact.previewKind}
      onClick={() => onOpen(artifact)}
      title={`${artifact.displayName} · ${formatBytes(artifact.byteLength)}`}
    >
      <span className="artifact-link-icon" aria-hidden>
        {artifact.previewKind === 'markdown' ? '📝' : artifact.previewKind === 'code' ? '🧩' : artifact.previewKind === 'text' ? '📄' : '📦'}
      </span>
      <span className="artifact-link-name">{artifact.displayName}</span>
      <span className="artifact-link-path">{artifact.relativePath}</span>
    </button>
  );
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
