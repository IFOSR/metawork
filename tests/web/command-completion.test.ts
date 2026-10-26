import { describe, expect, it } from 'vitest';
import { applyCommandSuggestion } from '../../web/src/command-completion.js';
const candidate = (start: number, end: number, text: string) => ({ value: text, label: text, description: '', replacement: { start, end, text } });
describe('server command replacement', () => {
  it('preserves the suffix, unicode and UTF-16 cursor offsets during middle edits', () => {
    expect(applyCommandSuggestion('/ta show 🙂', candidate(0, 3, '/task'))).toEqual({ text: '/task show 🙂', cursor: 5 });
    expect(applyCommandSuggestion('/task show 🙂 内容', candidate(11, 13, 'id'))).toEqual({ text: '/task show id 内容', cursor: 13 });
    expect(applyCommandSuggestion('/task sh', candidate(6, 8, 'show'))).toEqual({ text: '/task show ', cursor: 11 });
  });
  it('rejects invalid server ranges instead of corrupting the draft', () => {
    for (const [start, end] of [[-1, 1], [0, 20], [3, 2], [0.5, 2]]) {
      expect(applyCommandSuggestion('/task', candidate(start!, end!, 'x'))).toBeNull();
    }
  });
});
