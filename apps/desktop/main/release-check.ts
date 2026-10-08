import { compareSemanticVersions } from '../../../src/installation/release-manifest.js';

/** Discovery only. Installation still verifies the downloaded signed payload. */
export async function checkDesktopRelease(current: string, arch: string, request: typeof fetch = fetch): Promise<{
  version: string; downloadUrl: string;
} | null> {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported architecture');
  const response = await request('https://api.github.com/repos/IFOSR/metawork/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Release check unavailable');
  const release = await response.json();
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string'
    || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('Invalid release');
  const version = release.tag_name.slice(1);
  if (compareSemanticVersions(version, current) <= 0) return null;
  const name = `MetaWork-darwin-${arch}.dmg`;
  const downloadUrl = `https://github.com/IFOSR/metawork/releases/download/${release.tag_name}/${name}`;
  if (!release.assets.some((asset: { name?: string; browser_download_url?: string }) =>
    asset.name === name && asset.browser_download_url === downloadUrl)) throw new Error('Desktop download unavailable');
  return { version, downloadUrl };
}
