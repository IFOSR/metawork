// 容器部署的首启配置引导（ADR-0056）。
//
// 容器直接运行镜像内代码，不再经过 install-cli；全新 PVC 上没有任何 active 配置，
// server 启动会因 `active configuration is missing` 失败。本模块只在
// METAWORK_CONTAINER_BOOTSTRAP=1 且配置缺失时播种最小配置——形状与 main 安装器
// "无 Provider 安装"一致：providers/models 为空，角色（总管/助理/分析师）预置为
// enabled: false + 未绑定（schema 对禁用角色豁免交叉校验），设置页的默认角色与
// 模型绑定引导接管后续绑定。用户随后在设置页完成登录与模型配置。
//
// 原生 macOS 路径没有该环境变量，保持原有"提示先运行 install"行为不变。
import { ConfigurationService } from './configuration-service.js';
import { DEFAULT_AGENT_ROLES } from './default-agent-roles.js';
import type { AnyFusionConfigurationV2 } from './types.js';

export interface ContainerBootstrapResult {
  readonly revisionId: string;
}


/** 容器首启是否应播种配置：显式环境开关，原生路径永不触发。 */
export function containerBootstrapRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.METAWORK_CONTAINER_BOOTSTRAP?.trim() === '1';
}

/**
 * 播种最小配置并激活。校验/编译失败会抛错——播种内容是常量骨架，失败只能说明
 * 当前代码与校验规则不匹配，静默跳过只会把失败推迟到更难排查的位置。
 *
 * 传入的 service 应使用**直通 probe**（`probe: async () => ({ ok: true, issues: [] })`）
 * 与**语义化 id 工厂**（`createRevisionId: () => createConfigurationRevisionId('bootstrap', <时间戳>)`）：
 * 占位 Provider 没有有效凭据，真实探测必然失败，而 activateDraft 强制要求先 probe；
 * 语义化 id 让控制台的修订列表可直接辨认首启修订。生产装配层在 main() 的引导分支
 * 里注入这两者；正常激活路径不受影响。
 */
export async function bootstrapContainerConfiguration(
  service: ConfigurationService,
): Promise<ContainerBootstrapResult> {
  const draft = service.createDraft(containerSeedConfiguration(), null);
  const validation = service.validateDraft(draft.revisionId);
  if (!validation.ok) {
    throw new Error(
      `container bootstrap configuration is invalid: ${validation.issues
        .map(issue => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  service.compileDraft(draft.revisionId);
  // probe 为直通实现（见下）：占位 Provider 无有效凭据，真探测必然失败；租户首启
  // 不应被探测阻断。activateDraft 的 probed 前置校验由直通结果满足。
  await service.probeDraft(draft.revisionId);
  const activated = await service.activateDraft(draft.revisionId, null);
  if (!activated.ok) {
    const issues: unknown = 'issues' in activated ? activated.issues : undefined;
    const detail = Array.isArray(issues)
      ? issues.map(item => String(item)).join('; ')
      : String(activated.code);
    throw new Error(`container bootstrap activation failed: ${detail}`);
  }
  return { revisionId: draft.revisionId };
}

/**
 * 与 main 安装器"无 Provider 安装"的形状一致（ADR-0056）：
 * providers/models 为空，三套 harness 与角色（总管/助理/分析师）预置但
 * enabled: false、modelPolicy 指向尚未存在的 default-model 引用——schema
 * 对禁用角色豁免交叉校验，运行时带着惰性角色直接启动。
 *
 * 用户在设置页添加 Provider 与模型并绑定角色后，走正常的"暂存 → 校验 →
 * 激活"流程；默认角色与模型绑定引导（isDefaultAgentSetupPending）负责
 * 识别这个未绑定状态并展示指引。
 */
export function containerSeedConfiguration(): AnyFusionConfigurationV2 {
  const modelRef = 'default-model';
  return {
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:pi',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'pi-engineering-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'pi-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        ...DEFAULT_AGENT_ROLES.planner,
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: ['metaclaw-planner'],
        mcpServers: ['metaclaw-planner'],
        plugins: [],
        generatedRuntimeRef: 'planner',
        enabled: false,
      },
      'pi-engineering': {
        ...DEFAULT_AGENT_ROLES['pi-engineering'],
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering', 'document-processing'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing'],
        avoidUseCases: ['current public-web research requiring source-backed delivery'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-engineering',
        enabled: false,
      },
      'pi-research': {
        ...DEFAULT_AGENT_ROLES['pi-research'],
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'public-web-research',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['current public-web research', 'source verification'],
        avoidUseCases: ['repository modification and engineering verification'],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-research',
        enabled: false,
      },
    },
    permissionProfiles: {
      'workspace-engineering': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: { maxAdditionalReadPartitions: 8 },
      },
      'public-web-research': {
        profileId: 'public-web-research',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  };
}

export const BOOTSTRAP_PLACEHOLDER_CREDENTIAL = 'bootstrap-placeholder-unset';

/**
 * 自愈占位凭据：占位 Provider 是 enabled 的，而启动期凭据解析失败关断——
 * 缺凭据 = 容器崩溃循环，实例被锁死。每次容器启动补写缺失的凭据：
 *  - 首启：bootstrap 播种配置后立即补上；
 *  - 存量卷：历史上播种的配置可能没有任何凭据（旧种子的 Provider 也没有
 *    systemManaged 标记），重启即自愈——因此判定是"enabled 且凭据缺失"，
 *    不能按任何标记圈范围，否则缺标记的存量卷永远修不好。
 *
 * 补进去的是明确的占位值：针对它的调用会得到供应商 401（设置页可见、可替换），
 * 而不是把实例锁死在崩溃循环里。绝不覆盖已存在的非空凭据。
 */

/**
 * 自愈/晋升启用 Provider 的凭据（ADR-0056）：
 *  - 正式槽位（providers/<ref>）已有非空凭据 → 不动（绝不覆盖用户密钥）；
 *  - 正式槽位是我们自己写过的占位值（bootstrap-placeholder-unset）且
 *    pending/<ref> 有用户真实密钥 → 晋升覆盖（占位值只会导致 401，
 *    晋升后任务即可用）；
 *  - 正式槽位缺失 → 有 pending 先晋升，否则补占位值（保实例不进崩溃循环）。
 *
 * pending 槽位的值只会来自用户在设置页显式输入的密钥，因此晋升是安全的。
 */
export async function ensureBootstrapProviderCredentials(input: {
  config: AnyFusionConfigurationV2;
  secretStore: {
    get(reference: string): Promise<string>;
    put(reference: string, value: string): Promise<void>;
  };
}): Promise<string[]> {
  const healed: string[] = [];
  for (const [providerRef, provider] of Object.entries(input.config.providers)) {
    if (!provider.enabled) continue;
    const activeRef = provider.apiKeyRef;
    const pendingRef = activeRef.replace('/providers/', '/pending/');
    let active = null;
    try { active = await input.secretStore.get(activeRef); } catch { /* missing */ }
    if (active !== null && active.trim().length > 0 && active !== BOOTSTRAP_PLACEHOLDER_CREDENTIAL) continue;
    let pendingValue = null;
    try { pendingValue = await input.secretStore.get(pendingRef); } catch { /* missing */ }
    if (pendingValue !== null && pendingValue.trim().length > 0) {
      await input.secretStore.put(activeRef, pendingValue.trim());
      healed.push(providerRef);
      continue;
    }
    if (active === null || active.trim().length === 0) {
      await input.secretStore.put(activeRef, BOOTSTRAP_PLACEHOLDER_CREDENTIAL);
      healed.push(providerRef);
    }
  }
  return healed;
}
