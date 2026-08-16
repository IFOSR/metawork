import type { MetaclawSession } from './metaclaw-session.js';

export interface SessionStreamCallbacks {
  /**
   * 输出增量。`from` 是 `lines[0]` 在 session 完整输出中的绝对行号（稳定游标）：
   * 新连接会收到 from=0 的全量回放，接收方按下标幂等合并即可去重。
   */
  onOutput: (lines: string[], from: number) => void;
  onExitRequested?: () => void;
}

/**
 * 传输无关的 session 输出流：封装 subscribe（推 output 增量）与 submit。
 * gateway 的 per-connection 会话与 web 的单例会话都复用它；
 * session 的生命周期（new / dispose）由传输层管理，adapter 不碰。
 */
export class SessionStreamAdapter {
  private observedOutputLength = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly session: MetaclawSession,
    private readonly callbacks: SessionStreamCallbacks,
  ) {}

  /**
   * 订阅输出。subscribe 会立即回放当前完整 output，
   * 因此单例 session 的重连 / 多 tab 场景天然拿到全量。
   */
  attach(): void {
    this.unsubscribe = this.session.subscribe(snapshot => {
      const from = Math.min(this.observedOutputLength, snapshot.output.length);
      const newLines = snapshot.output.slice(from);
      this.observedOutputLength = snapshot.output.length;
      if (newLines.length > 0) {
        this.callbacks.onOutput(newLines, from);
      }
    });
  }

  /** 取消订阅；不 dispose session（session 生命周期由传输层管理）。 */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async submit(text: string): Promise<void> {
    const result = await this.session.submit(text);
    if (result.exitRequested) {
      this.callbacks.onExitRequested?.();
    }
  }
}
