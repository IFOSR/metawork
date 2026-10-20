/** Presentation only: separate known runtime receipts from business Markdown. */
export function conversationOutput(value: string): { body: string; receipts: string[] } {
  const body: string[] = [];
  const receipts: string[] = [];
  let queue: string[] | null = null;
  let fence: string | null = null;
  for (const line of value.split(/\r?\n/u)) {
    const text = line.trim();
    if (queue) {
      if (/^[│└]/u.test(text)) {
        queue.push(line);
        if (/^└/u.test(text)) {
          receipts.push(queue.join('\n'));
          queue = null;
        }
        continue;
      }
      // A truncated snapshot must not consume the business text after it.
      receipts.push(queue.join('\n'));
      queue = null;
    }
    const marker = /^(\x60{3,}|~{3,})/u.exec(text)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && text === marker) fence = null;
      body.push(line);
      continue;
    }
    if (fence) { body.push(line); continue; }
    if (/^┌─ 任务队列前五/u.test(text)) { queue = [line]; continue; }
    if (/^【Executor: .+｜派发准备】$/u.test(text)
      || /^→ Executor: .+ 将处理该任务$/u.test(text)
      || /^Execution needs attention:/u.test(text)) {
      receipts.push(line);
      continue;
    }
    body.push(line);
  }
  if (queue) receipts.push(queue.join('\n'));
  return { body: body.join('\n').trim(), receipts: [...new Set(receipts)] };
}
