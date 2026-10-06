import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WindowBounds { x?: number; y?: number; width: number; height: number }
export interface WindowState { bounds: WindowBounds; maximized: boolean; closeExplained: boolean }
export async function readWindowState(path: string, displays: WindowBounds[]): Promise<WindowState> {
  const fallback = { bounds: { width: 1280, height: 860 }, maximized: false, closeExplained: false };
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as WindowState;
    const b = value.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)
      || b.width < 800 || b.height < 600 || b.width > 10000 || b.height > 10000) return fallback;
    if (!displays.some(d => b.x! + b.width > (d.x ?? 0) + 100 && b.x! < (d.x ?? 0) + d.width - 100
      && b.y! >= (d.y ?? 0) && b.y! < (d.y ?? 0) + d.height - 100)) return fallback;
    return { bounds: b, maximized: value.maximized === true, closeExplained: value.closeExplained === true };
  } catch { return fallback; }
}
export async function writeWindowState(path: string, value: WindowState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
