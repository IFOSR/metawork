export interface GuidanceTarget {
  /** Task title without the identifier prefix. */
  title: string;
  /** Full durable task id, kept for copy and tooltips. */
  taskId: string;
}

export interface GuidanceBlock {
  kind: 'guidance' | 'proposal';
  scene: string;
  action: string;
  target: GuidanceTarget | null;
  reasons: string[];
  confidence: number | null;
  policy: string | null;
}

export interface SplitGuidanceResult {
  block: GuidanceBlock | null;
  /** Everything outside the guidance box, for the ordinary markdown renderer. */
  remainder: string;
}

const BOX_START = /^┌─\s*(操作指引|操作提案)\s*─*/u;
const BOX_END = /^└/u;
const KNOWN_LABELS = new Set(['场景', '推荐动作', '动作', '目标任务', '原因', '理由', '置信度', '策略']);
const TASK_ID = /task_[a-z0-9_]*(?:_[0-9a-f]{16,})+|[0-9a-f]{32,}/iu;

/**
 * Extracts the ASCII guidance box that the presentation service emits for
 * Feishu and CLI clients so the Web client can render it as structured content
 * instead of monospace art that wraps badly in a narrow column.
 */
export function splitGuidanceBlock(value: string): SplitGuidanceResult {
  const lines = value.split('\n');
  const start = lines.findIndex(line => BOX_START.test(line.trim()));
  if (start < 0) return { block: null, remainder: value };
  const end = lines.findIndex((line, index) => index > start && BOX_END.test(line.trim()));
  if (end < 0) return { block: null, remainder: value };
  const block = parseGuidanceLines(lines.slice(start, end + 1));
  if (!block) return { block: null, remainder: value };
  return {
    block,
    remainder: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').trim(),
  };
}

function parseGuidanceLines(lines: readonly string[]): GuidanceBlock | null {
  const header = lines[0]?.match(BOX_START);
  if (!header) return null;
  const kind = header[1] === '操作提案' ? 'proposal' : 'guidance';
  const fields: { key: string; values: string[] }[] = [];
  const labelPattern = /^\s*([^：]+)：(.*)$/u;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/^│/u, '').trimEnd();
    if (!line.trim() || BOX_END.test(line.trim()) || BOX_START.test(line.trim())) continue;
    const match = line.match(labelPattern);
    // Only known labels open a field; a wrapped reason may itself contain a colon.
    if (match && KNOWN_LABELS.has(match[1]!.trim())) {
      fields.push({ key: match[1]!.trim(), values: [match[2]!.trim()] });
    } else if (fields.length > 0) {
      fields[fields.length - 1]!.values.push(line.trim());
    }
  }
  const first = (...keys: string[]): string[] => {
    for (const key of keys) {
      const field = fields.find(item => item.key === key);
      if (field) return field.values.filter(Boolean);
    }
    return [];
  };
  const scene = first('场景').join(' ');
  const action = first('推荐动作', '动作').join(' ');
  const reasons = first('原因', '理由');
  const policy = first('策略').join(' ') || null;
  const targetRaw = first('目标任务').join(' ');
  const confidenceField = first('置信度').join(' ');
  const confidence = confidenceField ? Number.parseFloat(confidenceField) : Number.NaN;
  if (!scene && !action) return null;
  return {
    kind,
    scene,
    action,
    target: parseTarget(targetRaw),
    reasons,
    confidence: Number.isFinite(confidence) ? confidence : null,
    policy,
  };
}

function parseTarget(value: string): GuidanceTarget | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '无') return null;
  const withoutHash = trimmed.replace(/^#/u, '');
  const idMatch = withoutHash.match(TASK_ID);
  if (!idMatch || idMatch.index === undefined) {
    return { title: withoutHash, taskId: '' };
  }
  const taskId = idMatch[0];
  const title = withoutHash.slice(idMatch.index + taskId.length).trim();
  return { title: title || taskId, taskId };
}

/**
 * Shortens long durable ids inside prose so a wrapped paragraph stays readable.
 * The identifier remains selectable and keeps its last 8 characters.
 */
export function shortenDurableIds(value: string): string {
  return value.replace(new RegExp(TASK_ID.source, 'giu'), id => `…${id.slice(-8)}`);
}

/** Compact display form for one id; the caller keeps the full value for copy. */
export function shortTaskId(taskId: string): string {
  if (taskId.length <= 12) return taskId;
  return `…${taskId.slice(-8)}`;
}

const TASK_ID_PREFIXED = new RegExp(`#?\\s*${TASK_ID.source}`, 'giu');

/**
 * The presentation service writes the action as one sentence that repeats the
 * full identifier and the task title shown right below it. Keep the verb phrase
 * so the card reads: what to do, then which task.
 */
export function normalizeGuidanceAction(action: string, target: GuidanceTarget | null): string {
  let value = action.replace(TASK_ID_PREFIXED, '').replace(/\s{2,}/gu, ' ').trim();
  value = value.replace(/[：:]\s*$/u, '').trim();
  if (target?.title) {
    const title = target.title.trim();
    if (value.endsWith(title)) value = value.slice(0, -title.length).replace(/[：:、,，\s]+$/u, '').trim();
    const duplicated = `：#${title}`;
    if (value.includes(duplicated)) value = value.replace(duplicated, '').trim();
  }
  value = value.replace(/#\s*$/u, '').replace(/[：:]\s*$/u, '').trim();
  return value || action.trim();
}
