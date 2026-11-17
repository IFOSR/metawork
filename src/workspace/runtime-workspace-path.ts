/** Reserved Runtime scratch, never a business change or a published Git file. */
export function isRuntimeWorkspacePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) return false;
  return segments[0] === '.metawork-tmp'
    || segments.some(segment => segment.startsWith('.metawork-write-'));
}
