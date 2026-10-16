import type { ArtifactProjection } from '../api/session-types';
import { MarkdownContent } from './MarkdownContent';

export function ArtifactAwareMarkdownContent(props: {
  value: string;
  artifacts: ArtifactProjection[];
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
}) {
  return <MarkdownContent {...props} />;
}
