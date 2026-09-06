import type { Config } from '../core/types.js';
import { createFeishuBridge, type FeishuBridge, type FeishuSessionPort } from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig } from './feishu-config.js';

type CreateFeishuBridge = (config: Config, session: FeishuSessionPort) => FeishuBridge | null;

export interface StartedFeishuRuntimeBridge {
  bridge: FeishuBridge;
  stop(): Promise<void>;
}

export async function startFeishuRuntimeBridge(
  config: Config,
  session: FeishuSessionPort,
  createBridge: CreateFeishuBridge = createFeishuBridge,
): Promise<StartedFeishuRuntimeBridge | null> {
  let bridge: FeishuBridge | null = null;
  try {
    bridge = createBridge(config, session);
  } catch (error) {
    session.appendSystemMessage(`⚠️ 飞书应用桥接未启动: ${(error as Error).message}`);
    return null;
  }

  if (!bridge) {
    return null;
  }

  const feishuMode = resolveFeishuGatewayConfig(config).connectionMode;
  try {
    await bridge.start();
    session.appendSystemMessage(
      feishuMode === 'webhook'
        ? '→ 飞书 Webhook 桥接已启动，等待飞书回调'
        : '→ 飞书长连接桥接已启动，等待飞书消息',
    );
    session.appendSystemMessage(
      '→ 飞书权限自检清单（长任务卡片/云文档需要）: '
      + 'im:message（发消息）、im:message:update（卡片原地更新）、'
      + 'im:file（文件上传）、docx 文档导入权限。缺失时进度卡片降级为低频新发并在审计中记录。',
    );
  } catch (error) {
    session.appendSystemMessage(`⚠️ 飞书应用桥接启动失败: ${(error as Error).message}`);
    return null;
  }

  return {
    bridge,
    stop: () => bridge!.stop(),
  };
}

export class FeishuRuntimeManager {
  private active: StartedFeishuRuntimeBridge | null = null;
  private fingerprint: string | null = null;

  constructor(private readonly deps: {
    session: FeishuSessionPort;
    createBridge?: CreateFeishuBridge;
  }) {}

  async applyConfiguration(config: Config): Promise<void> {
    const fingerprint = JSON.stringify({
      gateway: config.gateway?.platforms?.feishu ?? null,
      integration: (
        config.integrations as { feishu?: unknown } | undefined
      )?.feishu ?? null,
    });
    if (fingerprint === this.fingerprint) return;
    await this.active?.stop();
    this.active = await startFeishuRuntimeBridge(
      config,
      this.deps.session,
      this.deps.createBridge,
    );
    this.fingerprint = fingerprint;
  }

  async stop(): Promise<void> {
    await this.active?.stop();
    this.active = null;
    this.fingerprint = null;
  }
}
