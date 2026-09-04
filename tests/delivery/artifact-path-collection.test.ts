import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerificationAndDeliveryService } from '../../src/delivery/verification-and-delivery-service.js';

function workspace(): { root: string; service: VerificationAndDeliveryService } {
  const root = mkdtempSync(join(tmpdir(), 'mw-artifact-paths-'));
  mkdirSync(resolve(root, 'files'), { recursive: true });
  writeFileSync(resolve(root, 'files', 'report.md'), '# report\n');
  writeFileSync(resolve(root, 'chart.png'), 'png');
  return { root, service: new VerificationAndDeliveryService() };
}

describe('VerificationAndDeliveryService artifact collection', () => {
  it('captures workspace-relative artifact paths reported by executors', () => {
    const { root, service } = workspace();
    const result = service.prepare({
      output: [
        '研究完成，报告已保存：files/report.md',
        '图表保存在 chart.png',
      ].join('\n'),
      durationMs: 1000,
      evidenceText: '',
      workspaceContext: {
        allowFilesystem: true,
        targetPaths: [root],
      },
      acceptanceCriteria: [],
      nextStep: 'none',
    } as never);

    expect(result.artifactPaths).toContain(resolve(root, 'files', 'report.md'));
    expect(result.artifactPaths).toContain(resolve(root, 'chart.png'));
    // The completion notice lists absolute paths so downstream Feishu sync
    // can actually find the files.
    expect(result.completionLines.join('\n')).toContain(
      `→ 已记录 2 个任务产物`,
    );
    expect(result.completionLines.join('\n')).toContain(resolve(root, 'files', 'report.md'));
  });

  it('keeps collecting absolute paths and ignores non-existent candidates', () => {
    const { root, service } = workspace();
    const absolute = resolve(root, 'files', 'report.md');
    const result = service.prepare({
      output: `写入 ${absolute}，未找到 files/missing.md`,
      durationMs: 1000,
      evidenceText: '',
      workspaceContext: { allowFilesystem: true, targetPaths: [root] },
      acceptanceCriteria: [],
      nextStep: 'none',
    } as never);

    expect(result.artifactPaths).toEqual([absolute]);
  });
});
