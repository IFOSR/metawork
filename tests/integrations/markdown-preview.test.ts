import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createMarkdownPreviewLinks,
  createMarkdownPreviewUrl,
  isPreviewableMarkdownPath,
  MarkdownPreviewServer,
} from '../../src/integrations/markdown-preview.js';

describe('Markdown preview helpers', () => {
  it('creates preview URLs only for Markdown files under metaclaw-tasks', () => {
    expect(createMarkdownPreviewUrl(
      'http://127.0.0.1:8790',
      '/repo',
      '/repo/metaclaw-tasks/task_doc/report.md',
    )).toBe('http://127.0.0.1:8790/preview/metaclaw-tasks%2Ftask_doc%2Freport.md');

    expect(createMarkdownPreviewUrl(
      'http://127.0.0.1:8790',
      '/repo',
      '/repo/README.md',
    )).toBeNull();

    expect(createMarkdownPreviewUrl(
      'http://127.0.0.1:8790',
      '/repo',
      '/repo/metaclaw-tasks/task_doc/data.json',
    )).toBeNull();
  });

  it('builds deduplicated preview links for generated Markdown artifacts', () => {
    const links = createMarkdownPreviewLinks([
      '/repo/metaclaw-tasks/task_doc/report.md',
      '/repo/metaclaw-tasks/task_doc/report.md',
      '/repo/metaclaw-tasks/task_doc/notes.markdown',
      '/repo/metaclaw-tasks/task_doc/data.json',
    ], {
      baseUrl: 'https://preview.example.com/',
      workspaceRoot: '/repo',
    });

    expect(links).toEqual([
      {
        path: '/repo/metaclaw-tasks/task_doc/report.md',
        title: 'report.md',
        url: 'https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md',
      },
      {
        path: '/repo/metaclaw-tasks/task_doc/notes.markdown',
        title: 'notes.markdown',
        url: 'https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Fnotes.markdown',
      },
    ]);
  });

  it('recognizes Markdown extensions case-insensitively', () => {
    expect(isPreviewableMarkdownPath('REPORT.MD')).toBe(true);
    expect(isPreviewableMarkdownPath('notes.MarkDown')).toBe(true);
    expect(isPreviewableMarkdownPath('report.html')).toBe(false);
  });

  it('can stop idempotently after its listen attempt fails', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('test port is unavailable');
    const preview = new MarkdownPreviewServer({
      enabled: true,
      host: '127.0.0.1',
      port: address.port,
    }, '/repo');

    await expect(preview.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(preview.stop()).resolves.toBeUndefined();
    await expect(preview.stop()).resolves.toBeUndefined();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  });
});
