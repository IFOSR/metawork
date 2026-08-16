/**
 * 按下标幂等合并输出行：服务端回放（from=0）与增量（from=N）共用这一条路径，
 * 同一行号覆盖同一内容，因此 WebSocket 重连的全量回放不会产生重复。
 */
export function mergeOutputLines(previous: string[], from: number, lines: string[]): string[] {
  const next = previous.slice(0, from);
  for (let index = 0; index < lines.length; index += 1) {
    next[from + index] = lines[index]!;
  }
  return next;
}
