import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/components/', import.meta.url);

describe('Detailed conversation view', () => {
  it('renders safe detailed Planner, Kernel, Executor, verification, and final answer sections', async () => {
    const [view, turn, narrative, step, styles] = await Promise.all([
      readFile(new URL('ConversationView.tsx', root), 'utf8'),
      readFile(new URL('ConversationTurn.tsx', root), 'utf8'),
      readFile(new URL('ExecutionNarrative.tsx', root), 'utf8'),
      readFile(new URL('ExecutionStep.tsx', root), 'utf8'),
      readFile(new URL('../styles.css', root), 'utf8'),
    ]);

    expect(view).toContain('ConversationTurnView');
    expect(view).toContain('liveExecutionPanel');
    expect(view).toContain("closest<HTMLElement>('.workspace-canvas')");
    expect(view).toContain('canvas.scrollTo');
    expect(turn).toContain("turn.status !== 'running'");
    expect(turn).toContain('liveExecutionPanel');
    expect(turn).toContain('MarkdownContent');
    expect(turn).toContain('system-command-result');
    expect(turn).toContain('hasTaskExecution');
    expect(turn).not.toContain('<strong>最终答案</strong>');
    expect(narrative).toContain('Planner');
    expect(narrative).toContain('授权与路由');
    expect(narrative).toContain('执行');
    expect(narrative).toContain('验证与交付');
    expect(narrative).toContain('executionTimeline');
    expect(narrative).toContain('progressHistory');
    expect(narrative).toContain('hasStageContent');
    expect(narrative).toContain('attempt.attemptLabel');
    expect(narrative).toContain('attempt.displayStatus');
    expect(narrative).not.toContain("attempt.attemptId ?? 'attempt'");
    expect(narrative).not.toContain('attempt.status ?? attempt.result}</strong>');
    expect(step).toContain('<details');
    expect(step).toContain('event.details');
    expect(step).not.toContain('rawPrompt');
    expect(step).not.toContain('reasoningText');
    expect(styles).toMatch(/\.user-message\s*\{[^}]*background: var\(--surface-user-message\);/u);
    expect(styles).toMatch(/\.user-message\s*\{[^}]*color: var\(--text-user-message\);/u);
    expect(styles).toContain('--surface-user-message: #e6eee4');
    expect(styles).toContain('--text-user-message: var(--text-primary)');
  });

  it('supports collapsible execution narrative and click-locked auto-scroll', async () => {
    const [view, narrative, styles] = await Promise.all([
      readFile(new URL('ConversationView.tsx', root), 'utf8'),
      readFile(new URL('ExecutionNarrative.tsx', root), 'utf8'),
      readFile(new URL('../styles.css', root), 'utf8'),
    ]);

    // 执行细节可折叠/展开（默认展开）。
    expect(narrative).toContain('collapsed');
    expect(narrative).toContain('narrative-toggle');
    expect(narrative).toContain('折叠');
    expect(narrative).toContain('展开');
    expect(narrative).toContain('!collapsed');

    // 点击锁定视野；滚回底部/回到最新解锁恢复跟随。
    expect(view).toContain('locked');
    expect(view).toContain('lockedRef');
    expect(view).toContain('back-to-latest');
    expect(view).toContain('回到最新');
    expect(view).toContain('pointerdown');

    expect(styles).toContain('.narrative-toggle');
    expect(styles).toContain('.back-to-latest');
  });
});
