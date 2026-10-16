import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../web/src/api/http.js';

const ppt = {
  artifactId: 'ppt-id', displayName: '销售方案.pptx', relativePath: '销售方案.pptx',
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  previewable: false, previewKind: 'unsupported', byteLength: 32000,
};

afterEach(() => vi.unstubAllGlobals());

describe('artifact preview loading', () => {
  it('fetches rich content even when a historical PPT retained the unsupported storage kind', async () => {
    const artifact = { ...ppt, previewable: true, documentFormat: 'pptx' };
    const result = { artifact, content: 'data:application/octet-stream;base64,AA==' };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ artifact })).mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new HttpClient().getArtifactPreview('ppt-id')).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens an authorized PPT as file details without calling the unsupported preview endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ artifact: ppt }));
    vi.stubGlobal('fetch', fetchMock);
    const http = new HttpClient();
    await expect(http.getArtifactPreview('ppt-id')).resolves.toEqual({ artifact: ppt, content: '' });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/artifacts/ppt-id']);
    expect(http.artifactDownloadUrl('ppt-id')).toBe('/api/artifacts/ppt-id/download');
  });

  it('still fetches content for supported files', async () => {
    const artifact = { ...ppt, previewable: true, previewKind: 'markdown', displayName: '报告.md' };
    const result = { artifact, content: '# 报告', renderedHtml: '<h1>报告</h1>' };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ artifact }))
      .mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpClient().getArtifactPreview('ppt-id')).resolves.toEqual(result);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/artifacts/ppt-id', '/api/artifacts/ppt-id/preview']);
  });

  it('preserves the original download when a supported file exceeds the preview limit', async () => {
    const artifact = { ...ppt, previewable: true, previewKind: 'text' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ artifact }))
      .mockResolvedValueOnce(Response.json({ error: 'unsupported' }, { status: 415 })));
    await expect(new HttpClient().getArtifactPreview('ppt-id')).resolves.toEqual({
      artifact: { ...artifact, previewable: false }, content: '',
    });
  });

  it.each([403, 404, 410])('does not offer an unavailable or unauthorized file after HTTP %s', async status => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'unavailable' }, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new HttpClient().getArtifactPreview('ppt-id')).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not hide an expired session as an unsupported preview', async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ artifact: { ...ppt, previewable: true, previewKind: 'text' } }))
      .mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 })));
    await expect(new HttpClient(unauthorized).getArtifactPreview('ppt-id')).rejects.toThrow('HTTP 401');
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
