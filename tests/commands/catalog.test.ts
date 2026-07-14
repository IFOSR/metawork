import { describe, expect, it, vi } from 'vitest';
import {
  CommandCatalog,
  type CommandContext,
  type CommandNode,
} from '../../src/commands/catalog.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';

const context = {} as CommandContext;

function createCatalog(): CommandCatalog {
  const nodes: CommandNode[] = [
    {
      kind: 'group',
      name: 'task',
      summary: '任务',
      children: [
        {
          kind: 'action',
          name: 'list',
          summary: '列表',
          effect: '列出任务',
          usages: ['/task list [all|done]'],
          examples: ['/task list done'],
          arguments: [{
            name: 'scope',
            kind: 'enum',
            description: '范围',
            optional: true,
            values: [
              { value: 'all', description: '全部' },
              { value: 'done', description: '完成' },
            ],
          }],
          execute: vi.fn(async args => ({
            type: 'text' as const,
            content: String(args.positionals.scope ?? 'all'),
          })),
        },
        {
          kind: 'action',
          name: 'block',
          summary: '阻塞',
          effect: '阻塞任务',
          usages: ['/task block <taskId> <reason...>'],
          examples: ['/task block task-1 "等待 review"'],
          arguments: [
            { name: 'taskId', kind: 'text', description: '任务 ID' },
            { name: 'reason', kind: 'rest', description: '原因' },
          ],
          execute: vi.fn(async args => ({
            type: 'text' as const,
            content: String(args.positionals.taskId) + ':' + String(args.positionals.reason),
          })),
        },
      ],
    },
    {
      kind: 'action',
      name: 'help',
      summary: '帮助',
      effect: '展示帮助',
      usages: ['/help [<commandPath...>]'],
      examples: ['/help task block'],
      arguments: [{ name: 'commandPath', kind: 'command-path', description: '路径', optional: true }],
      builtin: 'help',
    },
  ];
  return new CommandCatalog(nodes);
}

describe('CommandCatalog', () => {
  it('uses one tree for action listing and help descriptions', async () => {
    const catalog = createCatalog();
    expect(catalog.listActions()).toEqual(['/task list', '/task block', '/help']);
    expect(catalog.describe()).toContain('/task');
    expect((await catalog.execute('/help task block', context)).content)
      .toContain('/task block <taskId> <reason...>');
  });

  it('parses quotes, escapes, enums, optional args and rest text', async () => {
    expect((await createCatalog().execute('/task block task-1 "等待 review"', context)).content)
      .toBe('task-1:等待 review');
    expect((await createCatalog().execute('/task block task-1 等待\\ review', context)).content)
      .toBe('task-1:等待 review');
    expect((await createCatalog().execute('/task list done', context)).content).toBe('done');
    expect((await createCatalog().execute('/task list invalid', context)).content).toContain('值无效');
    expect((await createCatalog().execute('/task block task-1 "未闭合', context)).content).toContain('未闭合');
  });

  it('completes one level and returns an exact replacement range in the middle', () => {
    const catalog = createCatalog();
    const root = catalog.complete({ text: '/', cursor: 1, context });
    expect(root.suggestions.map(item => item.value)).toEqual(['task', 'help']);

    const child = catalog.complete({ text: '/task ', cursor: 6, context });
    expect(child.suggestions.map(item => item.value)).toEqual(['list', 'block']);

    const middle = catalog.complete({ text: '/task li done', cursor: 8, context });
    expect(middle.suggestions[0]?.replacement).toEqual({ start: 6, end: 8, text: 'list' });
  });

  it('offers a nearest command node as a Tab replacement without making the typo executable', () => {
    const catalog = createCatalog();
    const rootTypo = catalog.complete({ text: '/taks', cursor: 5, context });
    expect(rootTypo.state).not.toBe('executable');
    expect(rootTypo.suggestions[0]?.replacement).toEqual({ start: 0, end: 5, text: '/task' });

    const nestedTypo = catalog.complete({ text: '/task lsit ', cursor: 11, context });
    expect(nestedTypo.state).toBe('invalid');
    expect(nestedTypo.suggestions[0]?.replacement).toEqual({ start: 6, end: 10, text: 'list' });
  });

  it('loads a dynamic reference provider once when validation and suggestions use the same prefix', () => {
    const candidates = vi.fn(() => [{ value: 'item-1', label: 'item-1', description: 'first item' }]);
    const catalog = new CommandCatalog([{
      kind: 'action',
      name: 'pick',
      summary: 'pick item',
      effect: 'pick item',
      usages: ['/pick <itemId>'],
      examples: ['/pick item-1'],
      arguments: [{
        name: 'itemId',
        kind: 'reference',
        description: 'item',
        candidates,
      }],
      execute: vi.fn(),
    }]);

    const completion = catalog.complete({ text: '/pick item-1', cursor: 12, context });
    expect(completion.state).toBe('executable');
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('distinguishes directories, incomplete actions and executable actions', () => {
    const catalog = createCatalog();
    expect(catalog.complete({ text: '/task', cursor: 5, context }).state).toBe('incomplete');
    expect(catalog.complete({ text: '/task block', cursor: 11, context }).state).toBe('incomplete');
    expect(catalog.complete({ text: '/task block task-1 reason', cursor: 25, context }).state).toBe('executable');
  });

  it('contains the migrated command tree without old roots or aliases', () => {
    const catalog = createDefaultCommandCatalog();
    const actions = catalog.listActions();
    const expectedActions = `
/task dashboard
/task list
/task clear
/task show
/task pause
/task resume
/task block
/task unblock
/task cancel
/task complete
/task attach
/task history
/task index rebuild
/task index search
/executor list
/executor show
/executor register <executorName>
/executor register wizard
/executor unregister
/executor route
/executor feedback
/memory list
/memory search
/memory add
/memory edit
/memory delete
/memory candidates
/memory confirm
/memory reject
/memory stats
/memory recent
/memory auto-captured
/memory timeline
/memory applied
/memory undo
/memory explain
/memory evidence
/memory relations
/memory vault export
/memory vault status
/memory review-policy list
/memory review-policy revoke
/profile user
/profile project
/profile executor
/learning candidates
/learning approve
/learning reject
/learning promote
/learning skill-feedback
/learning patch candidates
/learning patch approve
/learning patch promote
/learning cards
/learning skills
/learning weekly
/learning summary
/config
/help
/exit
`.trim().split('\n');
    expect(new Set(actions)).toEqual(new Set(expectedActions));
    const help = catalog.describe();
    for (const commandPath of actions) expect(help).toContain(commandPath);
    expect(actions).toContain('/task dashboard');
    expect(actions).toContain('/task index search');
    expect(actions).toContain('/executor register <executorName>');
    expect(actions).toContain('/executor register wizard');
    expect(actions).toContain('/memory review-policy revoke');
    expect(actions).toContain('/learning patch promote');
    expect(actions).toContain('/profile user');
    expect(actions).toContain('/config');
    expect(actions).toContain('/help');
    expect(actions).toContain('/exit');
    expect(actions).not.toContain('/tasks');
    expect(actions).not.toContain('/dashboard');
    expect(actions).not.toContain('/quit');
  });
});
