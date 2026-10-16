/** Planner-owned relative file names, or dedicated directory prefixes ending in '/'. */
export function isValidFileOutput(path: string): boolean {
  if (!path || path.length > 500 || path !== path.trim() || /[\\:*?"<>|\x00-\x1f\x7f]/u.test(path)) return false;
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..'
    && !['.git', '.metaclaw'].includes(part.toLowerCase()));
}

export function matchesFileOutput(path: string, output: string): boolean {
  return output.endsWith('/') ? path.startsWith(output) : path === output;
}
