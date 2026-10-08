import { expect, it, vi } from 'vitest';
import { checkDesktopRelease } from '../main/release-check.js';

function response(version: string, arch = 'arm64') {
  return { tag_name: `v${version}`, assets: [{ name: `MetaWork-darwin-${arch}.dmg`,
    browser_download_url: `https://github.com/IFOSR/metawork/releases/download/v${version}/MetaWork-darwin-${arch}.dmg` }] };
}
it('does not offer equal or older releases, including a local version ahead of latest', async () => {
  for (const version of ['0.1.7', '0.1.8']) {
    const request = vi.fn(async () => Response.json(response(version)));
    expect(await checkDesktopRelease('0.1.8', 'arm64', request)).toBeNull();
  }
});
it('offers only the matching architecture from the official release', async () => {
  const request = vi.fn(async () => Response.json(response('0.1.9')));
  expect(await checkDesktopRelease('0.1.8', 'arm64', request)).toEqual({ version: '0.1.9',
    downloadUrl: 'https://github.com/IFOSR/metawork/releases/download/v0.1.9/MetaWork-darwin-arm64.dmg' });
  await expect(checkDesktopRelease('0.1.8', 'x64', request)).rejects.toThrow('unavailable');
});
it('rejects unexpected download destinations and network errors', async () => {
  const release = response('0.1.9'); release.assets[0].browser_download_url = 'https://example.com/app.dmg';
  await expect(checkDesktopRelease('0.1.8', 'arm64', async () => Response.json(release))).rejects.toThrow('unavailable');
  await expect(checkDesktopRelease('0.1.8', 'arm64', async () => new Response('', { status: 503 }))).rejects.toThrow('unavailable');
});
