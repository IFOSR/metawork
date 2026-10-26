import { shortTaskId } from './guidance-block';

const QUEUE_START = /^┌─\s*任务队列[^-]*─*/u;
const QUEUE_END = /^└/u;
const ITEM = /^(\d+)\.\s*\[([^\]]+)\]\s*#?(\S+)\s*(.*)$/u;

export interface TaskQueueItem {
  index: number;
  state: string;
  taskId: string;
  title: string;
  meta: string[];
}

export interface TaskQueueBlock {
  trigger: string | null;
  overview: Array<{ label: string; count: number }>;
  items: TaskQueueItem[];
}

export interface SplitTaskQueueResult {
  block: TaskQueueBlock | null;
  remainder: string;
}

/**
 * The CLI prints the task queue as bordered text with 64-character ids. The Web
 * client renders it as a list so a blocked task reads as "state · title · why"
 * instead of wrapped monospace art.
 */
export function splitTaskQueueBlock(value: string): SplitTaskQueueResult {
  const lines = value.split('\n');
  const start = lines.findIndex(line => QUEUE_START.test(line.trim()));
  if (start < 0) return { block: null, remainder: value };
  const end = lines.findIndex((line, index) => index > start && QUEUE_END.test(line.trim()));
  if (end < 0) return { block: null, remainder: value };
  const block = parseQueueLines(lines.slice(start, end + 1));
  if (!block) return { block: null, remainder: value };
  return {
    block,
    remainder: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').trim(),
  };
}

function parseQueueLines(lines: readonly string[]): TaskQueueBlock | null {
  const block: TaskQueueBlock = { trigger: null, overview: [], items: [] };
  let current: TaskQueueItem | null = null;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/^│/u, '').trim();
    if (!line || QUEUE_END.test(line) || QUEUE_START.test(line)) continue;
    const item = line.match(ITEM);
    if (item) {
      const [, index, state, taskId, rest] = item;
      const segments = (rest ?? '').split('|').map(segment => segment.trim()).filter(Boolean);
      const [title, ...meta] = segments;
      current = {
        index: Number(index),
        state: state!.trim(),
        taskId: taskId!,
        title: (title ?? '').replace(/#\S+/u, '').trim() || shortTaskId(taskId!),
        meta,
      };
      block.items.push(current);
      continue;
    }
    if (line.startsWith('触发：')) { block.trigger = line.slice(3).trim(); current = null; continue; }
    if (line.startsWith('总览：')) {
      const body = line.slice(3).trim();
      for (const part of body.split('/')) {
        const match = part.trim().match(/^(\S+?)\s*(\d+)$/u);
        if (match) block.overview.push({ label: match[1]!, count: Number(match[2]) });
      }
      current = null;
      continue;
    }
    if (current && line) current.meta.push(line);
  }
  return block.items.length > 0 || block.overview.length > 0 ? block : null;
}
