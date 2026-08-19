/** 会话输出流的最小快照投影：adapter 只读 output。 */
export interface SessionStreamSnapshot {
  output: string[];
}

/** 传输层所需的会话窄接口：subscribe（推 output 增量）与 submit。 */
export interface SessionStreamSource {
  subscribe(listener: (snapshot: SessionStreamSnapshot) => void): () => void;
  submit(text: string): Promise<{ exitRequested: boolean }>;
}

/** Gateway 每连接构造的会话：输出流 + 可选初始化/系统消息 + dispose。 */
export interface GatewaySession extends SessionStreamSource {
  initialize?(options?: { showDashboard?: boolean }): Promise<void> | void;
  appendSystemMessage?(...lines: string[]): void;
  dispose(): Promise<void>;
}

export interface WebSessionRuntimeSession {
  initialize(options?: { showDashboard?: boolean }): Promise<void> | void;
  subscribe(listener: (snapshot: import('./session-types.js').SessionSnapshot) => void): () => void;
  getSnapshot(): import('./session-types.js').SessionSnapshot;
  getSwitchingState?(): import('./session-types.js').SessionSwitchingState;
  subscribeInteractionTrace(
    listener: (trace: import('../management/interaction-trace.js').InteractionTrace | null) => void,
  ): () => void;
  getInteractionTrace(): import('../management/interaction-trace.js').InteractionTrace | null;
  submit(text: string): Promise<{ exitRequested: boolean }>;
  dispose(): Promise<void>;
}

export interface SessionStreamCallbacks {
  /**
   * 输出增量。`from` 是 `lines[0]` 在 session 完整输出中的绝对行号（稳定游标）：
   * 新连接会收到 from=0 的全量回放，接收方按下标幂等合并即可去重。
   */
  onOutput: (lines: string[], from: number) => void;
  onExitRequested?: () => void;
  onSubmitStarted?: (text: string, outputFrom: number) => void | Promise<void>;
  onSubmitCompleted?: (text: string) => void | Promise<void>;
  onSubmitFailed?: (text: string, error: unknown) => void | Promise<void>;
}

/**
 * 传输无关的 session 输出流：封装 subscribe（推 output 增量）与 submit。
 * gateway 的 per-connection 会话与 web 的单例会话都复用它；
 * session 的生命周期（new / dispose）由传输层管理，adapter 不碰。
 *
 * adapter 只依赖窄接口 SessionStreamSource，不 import MetaclawSession 具体类
 * （ADR-0031：客户端传输层不得依赖具体 Session 实现）。
 */
export class SessionStreamAdapter {
  private observedOutputLength = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly session: SessionStreamSource,
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
    await this.callbacks.onSubmitStarted?.(text, this.observedOutputLength);
    let result;
    try {
      result = await this.session.submit(text);
    } catch (error) {
      await this.callbacks.onSubmitFailed?.(text, error);
      throw error;
    }
    await this.callbacks.onSubmitCompleted?.(text);
    if (result.exitRequested) {
      this.callbacks.onExitRequested?.();
    }
  }
}
