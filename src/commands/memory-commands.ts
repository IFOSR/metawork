import { MemoryVaultExporter } from '../memory/memory-vault-exporter.js';
import type { PreferenceScope } from '../core/types.js';
import {
  optionArg,
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

const VALID_SCOPES = new Set<string>(['global', 'project', 'contact', 'task-local']);

function scopeOption(args: ResolvedCommandArgs): PreferenceScope | undefined {
  const value = optionArg(args, '--scope');
  return value && VALID_SCOPES.has(value) ? value as PreferenceScope : undefined;
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

export async function listMemories(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const prefs = context.memoryEngine.list({ status: 'confirmed' });
  if (prefs.length === 0) {
    return { type: 'text', content: '暂无已确认偏好' };
  }
  return { type: 'text', content: `已确认偏好：\n${prefs.map(formatPreferenceLine).join('\n')}` };
}

export async function searchMemories(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const keyword = stringArg(args, 'query').trim();
  if (!keyword) {
    return { type: 'text', content: '用法: /memory search <关键词>' };
  }
  const results = context.memoryEngine.searchByKeyword(keyword);
  if (results.length === 0) {
    return { type: 'text', content: `未找到包含 "${keyword}" 的偏好` };
  }
  return { type: 'text', content: `搜索结果：\n${results.map(formatPreferenceLine).join('\n')}` };
}

export async function addMemory(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const content = stringArg(args, 'content').trim();
  if (!content) {
    return {
      type: 'text',
      content: '用法: /memory add [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <内容>',
    };
  }
  const pref = context.memoryEngine.addManual({
    content,
    scope: scopeOption(args) ?? 'global',
    type: optionArg(args, '--type') ?? 'domain',
    subject: optionArg(args, '--subject'),
  });
  return { type: 'text', content: `已添加偏好 #${pref.id}` };
}

export async function editMemory(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const prefId = stringArg(args, 'memoryId');
  const content = stringArg(args, 'content').trim();
  const scope = scopeOption(args);
  const type = optionArg(args, '--type');
  const subject = optionArg(args, '--subject');

  if (!prefId || (!content && scope === undefined && type === undefined && subject === undefined)) {
    return {
      type: 'text',
      content: '用法: /memory edit <id> [--scope <global|project|contact|task-local>] [--type <type>] [--subject <subject>] <新内容>',
    };
  }

  const updated = context.memoryEngine.update(prefId, {
    ...(content ? { content } : {}),
    ...(scope ? { scope } : {}),
    ...(type ? { type } : {}),
    ...(subject ? { subject } : {}),
  });
  return { type: 'text', content: `已更新偏好 #${updated.id}: ${updated.content}` };
}

export async function deleteMemory(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const prefId = stringArg(args, 'memoryId');
  if (!prefId) {
    return { type: 'text', content: '用法: /memory delete <id>' };
  }
  context.memoryEngine.delete(prefId);
  return { type: 'text', content: `已删除偏好 #${prefId}` };
}

export async function showMemoryStats(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const all = context.memoryEngine.list();
  const confirmed = all.filter(preference => preference.status === 'confirmed').length;
  return {
    type: 'text',
    content: `偏好统计：\n  已确认: ${confirmed}\n  总计: ${all.length}`,
  };
}

export async function exportMemoryVault(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const result = new MemoryVaultExporter(context.memoryEngine).export({ vaultDir: optionArg(args, '--dir') });
  return {
    type: 'text',
    content: `Vault 导出完成：${result.vaultDir}\npreferences=${result.preferenceCount}`,
  };
}

export async function showMemoryVaultStatus(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const result = new MemoryVaultExporter(context.memoryEngine).status({ vaultDir: optionArg(args, '--dir') });
  return {
    type: 'text',
    content: `Vault 状态：${result.vaultDir}\npreferences=${result.preferenceCount}`,
  };
}
