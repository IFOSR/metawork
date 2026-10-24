import { describe, expect, it } from 'vitest';
import {
  normalizeGuidanceAction,
  shortenDurableIds,
  shortTaskId,
  splitGuidanceBlock,
} from '../../web/src/guidance-block.js';
import { parseSystemOutput } from '../../web/src/system-output.js';
import { splitTaskQueueBlock } from '../../web/src/task-queue.js';

const TASK_ID = 'task_plan_event_proposal_78d021cec7ec82421140e58284103ed0e8d753c175351cb9b4fdeaa74a585ef1';

const guidanceText = [
  '┌─ 操作指引 ───────────────────────────────────────┐',
  '│ 场景：resume after capacity block',
  `│ 推荐动作：继续处理任务 #${TASK_ID}：统计“26.10 未”目录文件并生成表格与图表`,
  `│ 目标任务：#${TASK_ID} 统计“26.10 未”目录文件并生成表格与图表`,
  '│ 原因：处理条件已满足，任务重新具备执行条件',
  '└──────────────────────────────────────────────────┘',
  '',
  `任务 #${TASK_ID} 已获 Kernel 授权，等待执行调度；实际启动状态请查看执行轨迹`,
].join('\n');

describe('guidance block parsing', () => {
  it('extracts the guidance box into structured fields and keeps the prose', () => {
    const result = splitGuidanceBlock(guidanceText);
    expect(result.block).toMatchObject({
      kind: 'guidance',
      scene: 'resume after capacity block',
      target: { taskId: TASK_ID, title: '统计“26.10 未”目录文件并生成表格与图表' },
      reasons: ['处理条件已满足，任务重新具备执行条件'],
      confidence: null,
    });
    expect(result.block?.action).toContain('继续处理任务');
    expect(result.remainder).toContain('已获 Kernel 授权');
    expect(result.remainder).not.toContain('操作指引');
    expect(result.remainder).not.toContain('┌');
  });

  it('parses proposals with confidence and policy lines', () => {
    const proposal = [
      '┌─ 操作提案 ───────────────────────────────────────┐',
      '│ 场景：plan follow-up',
      '│ 动作：创建新任务',
      `│ 目标任务：#${TASK_ID} 续作交付`,
      '│ 理由：上一轮已收敛',
      '│       仍有后续步骤',
      '│ 置信度：0.82',
      '│ 策略：无需用户确认；高置信提案自动执行，低置信提案自动跳过',
      '└──────────────────────────────────────────────────┘',
    ].join('\n');
    const result = splitGuidanceBlock(proposal);
    expect(result.block?.kind).toBe('proposal');
    expect(result.block?.reasons).toEqual(['上一轮已收敛', '仍有后续步骤']);
    expect(result.block?.confidence).toBeCloseTo(0.82);
    expect(result.block?.policy).toContain('无需用户确认');
    expect(result.remainder).toBe('');
  });

  it('leaves unrelated command output untouched', () => {
    const text = '已清空全部会话：取消 2 个任务';
    expect(splitGuidanceBlock(text)).toEqual({ block: null, remainder: text });
    expect(splitGuidanceBlock('┌─ 操作指引 ─┐\n│ 场景：x').block).toBeNull();
  });

  it('shortens durable ids without losing the tail', () => {
    const shortened = shortenDurableIds(`任务 #${TASK_ID} 已获授权`);
    expect(shortened).toBe('任务 #…4a585ef1 已获授权');
    expect(shortTaskId(TASK_ID)).toBe('…4a585ef1');
    expect(shortTaskId('task_short')).toBe('task_short');
  });
});

describe('guidance action normalization', () => {
  it('drops the identifier and repeated title so the card leads with the verb', () => {
    const target = { taskId: TASK_ID, title: '统计“26.10 未”目录文件并生成表格与图表' };
    expect(normalizeGuidanceAction(
      `继续处理任务 #${TASK_ID}：统计“26.10 未”目录文件并生成表格与图表`,
      target,
    )).toBe('继续处理任务');
    expect(normalizeGuidanceAction(`创建新任务 #${TASK_ID}`, target)).toBe('创建新任务');
    expect(normalizeGuidanceAction('等待用户确认', null)).toBe('等待用户确认');
  });
});

describe('system output notes', () => {
  it('drops executor dispatch chatter that the execution panel already shows', () => {
    const value = [
      `任务 #${TASK_ID} 已获 Kernel 授权，等待执行调度；实际启动状态请查看执行轨迹`,
      '【Executor: Pi Research｜派发准备】',
      '→ Executor: Pi Research 将处理该任务',
    ].join('\n');
    const parsed = parseSystemOutput(value);
    expect(parsed.structured).toBe(true);
    expect(parsed.notes).toEqual(['任务 #…4a585ef1 已获 Kernel 授权，等待执行调度；实际启动状态请查看执行轨迹']);
  });

  it('leaves ordinary prose alone', () => {
    const parsed = parseSystemOutput('已清空全部会话：取消 2 个任务');
    expect(parsed).toEqual({ notes: ['已清空全部会话：取消 2 个任务'], structured: false });
  });
});

describe('task queue block', () => {
  const ID_A = 'task_plan_event_proposal_85eb5b039e99682004c49ecee54b846f5399b090fe0edbb594af55fc12dfc379';
  const ID_B = 'task_plan_event_proposal_87b433fc2700cea77dc758e0acfc6c84ce20765d624300fb5f0b717e11374ca7';
  const text = [
    '┌─ 任务队列前五 ───────────────────────────────────┐',
    '│ 触发：task state changed',
    '│ 总览：执行中 0 / 待执行 0 / 挂起 0 / 需要处理 1',
    `│ 1. [执行中] #${ID_A} 制作上海植物园 3 页 | 优先级 16.0 | 进度 0%`,
    `│ 2. [需要处理] #${ID_B} 重构 8789 页面 | 优先级 31.0 | 需要处理 | execution result is quarantined`,
    '└──────────────────────────────────────────────────┘',
    '请先执行 /task recovery',
  ].join('\n');

  it('parses the CLI queue into rows without a 64-character id', () => {
    const parsed = splitTaskQueueBlock(text);
    expect(parsed.block?.trigger).toBe('task state changed');
    expect(parsed.block?.overview).toEqual([
      { label: '执行中', count: 0 }, { label: '待执行', count: 0 },
      { label: '挂起', count: 0 }, { label: '需要处理', count: 1 },
    ]);
    expect(parsed.block?.items).toHaveLength(2);
    expect(parsed.block?.items[1]).toMatchObject({ state: '需要处理', title: '重构 8789 页面' });
    expect(parsed.block?.items[1]?.meta.join(' ')).toContain('quarantined');
    expect(parsed.remainder).toBe('请先执行 /task recovery');
  });

  it('leaves other output untouched', () => {
    expect(splitTaskQueueBlock('已清空全部会话')).toEqual({ block: null, remainder: '已清空全部会话' });
  });
});
