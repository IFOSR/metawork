import { shortenDurableIds } from './guidance-block';

/** Executor dispatch chatter that the live execution panel already shows. */
const DISPATCH_LABEL = /^【Executor:\s*(.+?)｜派发准备】$/u;
const DISPATCH_LINE = /^→\s*Executor:\s*(.+?)\s*将处理该任务$/u;

export interface SystemOutputNotes {
  /** Plain status sentences, with long durable ids shortened. */
  notes: string[];
  /** True when CLI-only chatter was removed, so the caller should not fall back to markdown. */
  structured: boolean;
}

/**
 * Slash-command output mixes prose with CLI affordances such as bordered
 * dispatcher lines. Those belong to the execution panel, not to the transcript,
 * so they are dropped and the remaining sentences render as quiet notes.
 */
export function parseSystemOutput(value: string): SystemOutputNotes {
  let structured = false;
  const notes: string[] = [];
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (DISPATCH_LABEL.test(line) || DISPATCH_LINE.test(line)) {
      structured = true;
      continue;
    }
    notes.push(shortenDurableIds(line));
  }
  return { notes, structured };
}
