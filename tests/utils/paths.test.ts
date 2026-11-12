import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { isPathInsideDirectory, resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses a resolved product installation root override', () => {
    expect(resolveMetaclawDir('./tmp/metawork-root', '/Users/demo')).toMatch(/tmp\/metawork-root\/data$/);
  });

  it('falls back to ~/.metawork/data when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo')).toBe('/Users/demo/.metawork/data');
  });
});

describe('isPathInsideDirectory', () => {
  it('accepts children and rejects the directory itself, siblings, and escapes', () => {
    const directory = resolve('root', 'data');
    expect(isPathInsideDirectory(resolve(directory, 'conv_1'), directory)).toBe(true);
    expect(isPathInsideDirectory(resolve(directory, 'conv_1', 'file.bin'), directory)).toBe(true);
    expect(isPathInsideDirectory(directory, directory)).toBe(false);
    expect(isPathInsideDirectory(resolve(`${directory}-sibling`, 'conv_1'), directory)).toBe(false);
    expect(isPathInsideDirectory(resolve(directory, '..', 'elsewhere'), directory)).toBe(false);
  });

  it('accepts native Windows children derived through either separator', () => {
    const directory = 'C:\\metawork\\data';
    expect(isPathInsideDirectory('C:\\metawork\\data\\conv_1', directory)).toBe(true);
    expect(isPathInsideDirectory('C:\\metawork\\data\\conv_1\\a.bin', directory)).toBe(true);
    expect(isPathInsideDirectory('C:\\metawork\\data-evil\\conv_1', directory)).toBe(false);
    expect(isPathInsideDirectory('D:\\metawork\\data\\conv_1', directory)).toBe(false);
  });
});
