import { MemoryVaultExporter } from '../memory/memory-vault-exporter.js';
import type { PreferenceScope } from '../core/types.js';
import type { CommandHandler, CommandContext, CommandResult } from './router.js';

const VALID_SCOPES = new Set<PreferenceScope>(['global', 'project', 'contact', 'task-local']);

interface ParsedMemoryArgs {
  scope?: PreferenceScope;
  type?: string;
  subject?: string;
  rest: string[];
}

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const parsed: ParsedMemoryArgs = { rest: [] };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--scope') {
      const scope = args[index + 1] as PreferenceScope | undefined;
      if (scope && VALID_SCOPES.has(scope)) {
        parsed.scope = scope;
        index += 1;
        continue;
      }
    }

    if (token === '--type') {
      const type = args[index + 1];
      if (type) {
        parsed.type = type;
        index += 1;
        continue;
      }
    }

    if (token === '--subject') {
      const subject = args[index + 1];
      if (subject) {
        parsed.subject = subject;
        index += 1;
        continue;
      }
    }

    parsed.rest.push(token);
  }

  return parsed;
}

function formatPreferenceLine(preference: {
  id: string;
  scope: string;
  subject: string | null;
  content: string;
}): string {
  const subjectText = preference.subject ? ` (${preference.subject})` : '';
  return `  #${preference.id} [${preference.scope}]${subjectText} ${preference.content}`;
}

function parseDirArg(args: string[]): string | undefined {
  const index = args.indexOf('--dir');
  return index >= 0 ? args[index + 1] : undefined;
}

export const memoryCommand: CommandHandler = {
  name: 'memory',
  aliases: [],
  description: '偏好管理：/memory [search|add|edit|delete|stats|vault]',
  async execute(args, context) {
    const action = args[0];

    if (!action) {
      // 显示所有活跃偏好
      const prefs = context.memoryEngine.list({ status: 'confirmed' });
      if (prefs.length === 0) {
        return { type: 'text', content: '暂无已确认偏好' };
      }

      const lines = prefs.map(formatPreferenceLine);
      return { type: 'text', content: `已确认偏好：\n${lines.join('\n')}` };
    }

    switch (action) {
      case 'search': {
        const keyword = args[1];
        if (!keyword) {
          return { type: 'text', content: '用法: /memory search <关键词>' };
        }
        const results = context.memoryEngine['prefRepo'].searchByKeyword(keyword);
        if (results.length === 0) {
          return { type: 'text', content: `未找到包含 "${keyword}" 的偏好` };
        }
        const lines = results.map(formatPreferenceLine);
        return { type: 'text', content: `搜索结果：\n${lines.join('\n')}` };
      }

      case 'add': {
        const parsed = parseMemoryArgs(args.slice(1));
        const content = parsed.rest.join(' ');
        if (!content) {
          return { type: 'text', content: '用法: /memory add [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <内容>' };
        }
        const pref = context.memoryEngine.addManual({
          content,
          scope: parsed.scope ?? 'global',
          type: parsed.type ?? 'domain',
          subject: parsed.subject,
        });
        return { type: 'text', content: `已添加偏好 #${pref.id}` };
      }

      case 'edit': {
        const prefId = args[1];
        const parsed = parseMemoryArgs(args.slice(2));
        const content = parsed.rest.join(' ');
        if (!prefId || (!content && parsed.scope === undefined && parsed.type === undefined && parsed.subject === undefined)) {
          return { type: 'text', content: '用法: /memory edit <id> [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <新内容>' };
        }

        const updated = context.memoryEngine.update(prefId, {
          ...(content ? { content } : {}),
          ...(parsed.scope ? { scope: parsed.scope } : {}),
          ...(parsed.type ? { type: parsed.type } : {}),
          ...(parsed.subject ? { subject: parsed.subject } : {}),
        });
        return { type: 'text', content: `已更新偏好 #${updated.id}: ${updated.content}` };
      }

      case 'delete': {
        const prefId = args[1];
        if (!prefId) {
          return { type: 'text', content: '用法: /memory delete <id>' };
        }
        context.memoryEngine.delete(prefId);
        return { type: 'text', content: `已删除偏好 #${prefId}` };
      }

      case 'stats': {
        const all = context.memoryEngine.list();
        const confirmed = all.filter(p => p.status === 'confirmed').length;
        return {
          type: 'text',
          content: `偏好统计：\n  已确认: ${confirmed}\n  总计: ${all.length}`,
        };
      }

      case 'vault': {
        const subAction = args[1];
        const vaultDir = parseDirArg(args.slice(2));
        const exporter = new MemoryVaultExporter(context.memoryEngine);
        if (subAction === 'export') {
          const result = exporter.export({ vaultDir });
          return {
            type: 'text',
            content: `Vault 导出完成：${result.vaultDir}\npreferences=${result.preferenceCount}`,
          };
        }
        if (subAction === 'status') {
          const result = exporter.status({ vaultDir });
          return {
            type: 'text',
            content: `Vault 状态：${result.vaultDir}\npreferences=${result.preferenceCount}`,
          };
        }
        return { type: 'text', content: '用法: /memory vault [export|status] [--dir <path>]' };
      }

      default:
        return { type: 'text', content: `未知操作: ${action}` };
    }
  },
};
