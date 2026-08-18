import { describe, expect, it } from 'vitest';
import { renderNativeLauncher } from '../../src/installation/native-launcher.js';

describe('renderNativeLauncher', () => {
  it('does not override revisioned Planner runtime configuration with legacy paths', () => {
    const launcher = renderNativeLauncher('/Users/test/.anyfusion');

    expect(launcher).not.toContain('METACLAW_PLANNER_HOME=');
    expect(launcher).not.toContain('ANYFUSION_PLANNER_HOME=');
    expect(launcher).not.toContain('METACLAW_PLANNER_ENV_FILE=');
    expect(launcher).toContain(
      'METACLAW_PLANNER_SESSION_DIR="$ANYFUSION_INSTALL_ROOT/data/planner-sessions"',
    );
  });
});
