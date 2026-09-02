import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { ArtifactProjection } from '../api/session-types';
import { findArtifactReferences } from '../artifact-reference';
import { ArtifactReferenceLink } from './ArtifactLink';
import { MarkdownContent } from './MarkdownContent';

export function ArtifactAwareMarkdownContent({
  value,
  artifacts,
  onOpenArtifact,
}: {
  value: string;
  artifacts: ArtifactProjection[];
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
}) {
  const matches = useMemo(
    () => findArtifactReferences(value, artifacts),
    [value, artifacts],
  );
  if (matches.length === 0 || !onOpenArtifact) return <MarkdownContent value={value} />;

  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) {
      parts.push(
        <MarkdownContent
          key={`text-${index}`}
          value={value.slice(cursor, match.start)}
        />,
      );
    }
    parts.push(
      <ArtifactReferenceLink
        key={`artifact-${match.artifact.artifactId}-${index}`}
        artifact={match.artifact}
        onOpen={onOpenArtifact}
      />,
    );
    cursor = match.end;
  });
  if (cursor < value.length) {
    parts.push(<MarkdownContent key="text-tail" value={value.slice(cursor)} />);
  }
  return <div className="artifact-aware-markdown">{parts}</div>;
}
