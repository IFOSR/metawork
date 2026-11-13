import type { MemoryApiClient, MemoryAssetView } from './api/memory';

const TYPE_NAMES: Record<string, string> = {
  instruction: '偏好与要求', persona: '个人背景', episodic: '事件记录',
  knowledge: '知识', procedural: '做事方法',
};

const TOPIC_RULES: Array<[string, RegExp]> = [
  ['投资与市场', /投资|期货|股票|黄金|金价|合约|定价|金融|资产|price.?in/iu],
  ['生活与日程', /生活|跑步|运动|日程|公园|家庭|旅行|健康/iu],
  ['商业与调研', /调研|供应商|服务商|小红书|营销|GEO|竞品|市场调查/iu],
  ['沟通与表达', /表达|沟通|语言|中文|英文|语气|格式|文风|写作|汇报|表格|简洁/iu],
  ['工作与协作', /工作|项目|团队|协作|任务|职业|岗位|业务|客户|管理|流程/iu],
  ['技术与工具', /代码|开发|技术|软件|系统|工具|编程|模型|数据|产品|设计/iu],
  ['学习与成长', /学习|成长|研究|课程|知识|目标|计划|习惯|复盘/iu],
  ['个人背景', /个人|家庭|居住|城市|年龄|身份|经历|偏好|兴趣/iu],
];

export interface MemoryProfile {
  total: number;
  enabled: number;
  layers: Record<'l1' | 'l2' | 'l3', number>;
  types: Array<{ label: string; count: number }>;
  topics: Array<{ label: string; count: number }>;
  portrait: string;
  highlights: MemoryAssetView[];
}

export function buildMemoryProfile(assets: MemoryAssetView[]): MemoryProfile {
  const layers = { l1: 0, l2: 0, l3: 0 };
  const typeCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const asset of assets) {
    layers[asset.layer] += 1;
    const label = Object.hasOwn(TYPE_NAMES, asset.type) ? TYPE_NAMES[asset.type]! : '其他';
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
    const text = `${asset.title} ${asset.preview}`;
    const matched = TOPIC_RULES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
    for (const label of matched.length ? matched : ['其他内容']) topicCounts.set(label, (topicCounts.get(label) ?? 0) + 1);
  }
  const types = [...typeCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  const topics = [...topicCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  const top = topics.slice(0, 2).map(item => item.label);
  const portrait = assets.length === 0 ? '还没有形成记忆画像。随着相关对话被整理，偏好、背景和经验会逐步呈现在这里。'
    : top.length ? `已保存的内容主要围绕${top.join('、')}展开，其中 ${layers.l3} 条为用户画像。`
      : `目前已整理 ${assets.length} 条信息，画像主题仍在形成中。`;
  const highlights = [...assets].sort((a, b) => Number(b.enabled) - Number(a.enabled)
    || b.layer.localeCompare(a.layer) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  return { total: assets.length, enabled: assets.filter(asset => asset.enabled).length, layers, types, topics, portrait, highlights };
}

/** Read a bounded, unfiltered account overview; never pass page filters here. */
export async function loadMemoryProfile(api: MemoryApiClient, signal: AbortSignal): Promise<{ profile: MemoryProfile; partial: boolean }> {
  const assets = new Map<string, MemoryAssetView>();
  let expected: number | undefined;
  let partial = false;
  for (let offset = 0; offset < 10_000; offset += 200) {
    signal.throwIfAborted();
    const page = await api.listAssets({ limit: 200, offset }, signal);
    signal.throwIfAborted();
    if (page.degraded || page.mode !== 'enabled') throw new Error(page.degradedReason ?? 'memory_profile_unavailable');
    if (expected !== undefined && expected !== page.total) partial = true;
    expected ??= page.total;
    for (const asset of page.items) assets.set(asset.memoryId, asset);
    if (offset + page.items.length >= page.total || page.items.length < 200) break;
  }
  return { profile: buildMemoryProfile([...assets.values()]), partial: partial || assets.size !== expected };
}
