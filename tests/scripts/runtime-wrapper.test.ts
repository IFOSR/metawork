import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('runtime shell wrappers', () => {
  it('uses metawork.sh as the canonical implementation', () => {
    const source = readFileSync('metawork.sh', 'utf8');

    expect(source).toContain('MetaWork production launcher');
    expect(source).toContain('APP_ENTRY="$SCRIPT_DIR/dist/index.js"');
    expect(source).not.toContain('exec "${SCRIPT_DIR}/metaclaw.sh"');
  });

  it.each(['anyfusion.sh', 'metaclaw.sh'])('%s delegates without changing arguments', file => {
    const source = readFileSync(file, 'utf8');

    expect(source).toContain('exec "${SCRIPT_DIR}/metawork.sh" "$@"');
    expect(source).not.toContain('APP_ENTRY=');
  });
});
