import { describe, expect, it } from 'vitest';
import { findArtifactReferences } from '../../web/src/artifact-reference';

const imageArtifact = {
  artifactId: 'artifact_image',
  taskId: 'task_image',
  publicationId: 'publication_image',
  displayName: 'task_plan_event_proposal.png',
  relativePath: 'artifacts/images/task_plan_event_proposal_1c9f6cc917c3d361ec317b870dd32f774cd2c917cf259b2b54399569a9ba3ce7_r1_subtask-generate-enhanced-s/attempt_dispatch_event_exec_int_3nfADs8fL2_task_plan_event_proposal_1c9f6cc917c3d361ec317b870dd32f_aab886c7c0486df7_5dc0-01.png',
  mediaType: 'image/png',
  previewKind: 'image' as const,
  previewable: true,
  byteLength: 128,
  contentHash: 'sha256:image',
  publishedAt: '2026-09-02T00:00:00.000Z',
};

describe('findArtifactReferences', () => {
  it('matches a long executor path and returns the safe artifact identity', () => {
    const text = `图片已生成：${imageArtifact.relativePath}`;

    expect(findArtifactReferences(text, [imageArtifact])).toEqual([{
      start: 6,
      end: text.length,
      text: imageArtifact.relativePath,
      artifact: imageArtifact,
    }]);
  });

  it('matches a displayed filename without matching a filename fragment', () => {
    expect(findArtifactReferences(
      '请查看 task_plan_event_proposal.png，另一个是task_plan_event_proposal.pngx。',
      [imageArtifact],
    )).toHaveLength(1);
  });
});
