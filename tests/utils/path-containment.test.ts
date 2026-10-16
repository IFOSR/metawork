import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInside,
  isPathStrictlyInside,
} from '../../src/utils/path-containment.js';

const root = resolve(sep, 'root', 'records');

describe('path containment', () => {
  it('accepts real children and rejects siblings, parents and traversal', () => {
    expect(isPathInside(root, join(root, 'conv_1.json'))).toBe(true);
    expect(isPathInside(root, join(root, 'a', 'b', 'c.json'))).toBe(true);
    expect(isPathInside(root, root)).toBe(true);

    expect(isPathInside(root, join(root, '..', 'sibling', 'file.json'))).toBe(false);
    expect(isPathInside(root, resolve(sep, 'root'))).toBe(false);
    // A prefix-only match must not be mistaken for containment.
    expect(isPathInside(root, `${root}-other${sep}file.json`)).toBe(false);
  });

  it('separates strict containment from equality', () => {
    expect(isPathStrictlyInside(root, root)).toBe(false);
    expect(isPathStrictlyInside(root, join(root, 'file.json'))).toBe(true);
  });

  it('handles traversal that resolves back inside the root', () => {
    expect(isPathStrictlyInside(root, join(root, 'a', '..', 'file.json'))).toBe(true);
    expect(isPathStrictlyInside(root, join(root, '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('accepts Windows children resolved with backslashes', () => {
    const windowsRoot = resolve('C:\\', 'data', 'conversations');
    expect(isPathStrictlyInside(windowsRoot, join(windowsRoot, 'conv_1.json'))).toBe(true);
    // The regression this guards: `${root}/` never matches a backslash path.
    expect(`${join(windowsRoot, 'conv_1.json')}`.startsWith(`${windowsRoot}/`)).toBe(false);
  });
});
