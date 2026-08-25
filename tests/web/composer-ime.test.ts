import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Composer IME-aware Enter behavior', () => {
  it('separates IME composition Enter from the normal send Enter', async () => {
    const composer = await readFile(new URL('components/Composer.tsx', root), 'utf8');

    // composition 状态跟踪：compositionstart / compositionend。
    expect(composer).toContain('onCompositionStart');
    expect(composer).toContain('onCompositionEnd');
    expect(composer).toContain('composingRef');
    // composition 刚结束时的一次 Enter 不发送（Safari 时序），下一次普通 Enter 恢复发送。
    expect(composer).toContain('justEndedCompositionRef');
    // keydown 三重判断：isComposing、keyCode === 229 与内部 ref。
    expect(composer).toContain('nativeEvent.isComposing');
    expect(composer).toContain('nativeEvent.keyCode === 229');
    // IME 合成期间不调用 preventDefault()，不触发发送。
    const guardIndex = composer.indexOf('if (\n      nativeEvent.isComposing');
    expect(guardIndex).toBeGreaterThan(-1);
    const guardBody = composer.slice(guardIndex, composer.indexOf('}', guardIndex));
    expect(guardBody).not.toContain('preventDefault');
    expect(guardBody).not.toContain('submit()');
  });

  it('keeps Shift+Enter as newline and supports explicit Ctrl/Cmd+Enter send', async () => {
    const composer = await readFile(new URL('components/Composer.tsx', root), 'utf8');

    expect(composer).toContain("event.key !== 'Enter'");
    // Shift+Enter 交给浏览器默认换行行为。
    expect(composer).toContain('event.shiftKey && !event.ctrlKey && !event.metaKey');
    expect(composer).toContain('插入换行');
    // Ctrl/Cmd+Enter 显式发送与普通 Enter 发送共用 preventDefault + submit。
    expect(composer).toContain('显式强制发送');
    expect(composer).toContain('event.preventDefault();\n    submit();');
    // form submit 与键盘发送不会重复提交：submit 只在 form onSubmit 或 keydown 中调用一次。
    const submitCalls = composer.match(/submit\(\);/gu) ?? [];
    expect(submitCalls.length).toBe(2);
    expect(composer).toContain('if (!composingRef.current) submit()');
  });

  it('shows a keyboard hint for send semantics', async () => {
    const [composer, styles] = await Promise.all([
      readFile(new URL('components/Composer.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    expect(composer).toContain('Enter 发送 · Shift+Enter 换行');
    expect(styles).toContain('.composer-key-hint');
  });
});
