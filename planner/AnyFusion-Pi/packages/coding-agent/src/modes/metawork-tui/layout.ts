/**
 * MetaWork TUI 响应式布局（统一 TUI 设计 §8.1）。
 *
 * 纯函数：给定终端尺寸返回布局方案，便于验收 80x24 / 120x36 / 160x48 基准。
 * 尺寸低于基准时优先保留可退出、可恢复焦点的提示，不因负宽度或空视口崩溃。
 */

export type MetaWorkLayoutVariant = "compact" | "standard" | "wide";

export interface MetaWorkLayout {
	readonly variant: MetaWorkLayoutVariant;
	readonly columns: number;
	readonly rows: number;
	/** 顶部栏是否显示（过小终端优先保留输入与退出）。 */
	readonly showHeader: boolean;
	/** 状态/操作行的行数。 */
	readonly actionBarRows: number;
	/** Task 面板显示方式：compact 用覆盖层，standard/wide 并列。 */
	readonly taskPanel: "hidden" | "inline" | "overlay";
	readonly taskPanelWidth: number | null;
	readonly conversationWidth: number;
	readonly editorRows: number;
	/** 视口内最多渲染的 Turn 数（不能自动展开全部历史）。 */
	readonly maxVisibleTurns: number;
	/** 是否默认展开全部过程轨迹（宽终端也不自动展开）。 */
	readonly expandAllTrace: boolean;
}

const MIN_COLUMNS = 40;
const MIN_ROWS = 10;
/** 并列布局的最小宽度（120x36 基准）。 */
const INLINE_TASK_PANEL_MIN_COLUMNS = 120;
/** 宽终端基准（160x48）：扩展正文与详情宽度。 */
const WIDE_LAYOUT_MIN_COLUMNS = 160;
const TASK_PANEL_MIN_WIDTH = 30;
const TASK_PANEL_MAX_WIDTH = 52;
const COMPACT_TASK_PANEL_WIDTH = 40;
const CONVERSATION_MIN_WIDTH = 24;
const EDITOR_MIN_ROWS = 1;
const EDITOR_MAX_ROWS = 8;

export function computeMetaWorkLayout(columns: number, rows: number): MetaWorkLayout {
	// 非有限或退化尺寸：收敛到可渲染下限而不是产生负宽度。
	const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : MIN_COLUMNS;
	const safeRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : MIN_ROWS;

	const showHeader = safeRows >= 14 && safeColumns >= 60;
	const actionBarRows = safeRows >= 6 ? 2 : 1;
	const editorRows = clamp(
		Math.round(safeRows * 0.18),
		EDITOR_MIN_ROWS,
		EDITOR_MAX_ROWS,
	);
	const maxVisibleTurns = Math.max(3, Math.floor((safeRows - editorRows - actionBarRows - 4) / 6));

	if (safeColumns < MIN_COLUMNS || safeRows < MIN_ROWS) {
		// 极小终端：只保留对话、输入与退出提示，Task 面板经覆盖层按需打开。
		return {
			variant: "compact",
			columns: safeColumns,
			rows: safeRows,
			showHeader: false,
			actionBarRows: 1,
			taskPanel: "overlay",
			taskPanelWidth: Math.min(COMPACT_TASK_PANEL_WIDTH, Math.max(1, safeColumns - 2)),
			conversationWidth: safeColumns,
			editorRows: 1,
			maxVisibleTurns: 1,
			expandAllTrace: false,
		};
	}

	if (safeColumns >= INLINE_TASK_PANEL_MIN_COLUMNS) {
		const variant: MetaWorkLayoutVariant = safeColumns >= WIDE_LAYOUT_MIN_COLUMNS
			? "wide"
			: "standard";
		const taskPanelWidth = clamp(
			Math.round(safeColumns * (variant === "wide" ? 0.28 : 0.3)),
			TASK_PANEL_MIN_WIDTH,
			TASK_PANEL_MAX_WIDTH,
		);
		return {
			variant,
			columns: safeColumns,
			rows: safeRows,
			showHeader,
			actionBarRows,
			taskPanel: "inline",
			taskPanelWidth,
			conversationWidth: Math.max(CONVERSATION_MIN_WIDTH, safeColumns - taskPanelWidth - 3),
			editorRows,
			maxVisibleTurns,
			// 宽终端扩展正文与详情宽度，但不自动展开全部历史轨迹。
			expandAllTrace: false,
		};
	}

	return {
		variant: "compact",
		columns: safeColumns,
		rows: safeRows,
		showHeader,
		actionBarRows,
		taskPanel: "overlay",
		taskPanelWidth: Math.min(COMPACT_TASK_PANEL_WIDTH, Math.max(1, safeColumns - 2)),
		conversationWidth: safeColumns,
		editorRows,
		maxVisibleTurns,
		expandAllTrace: false,
	};
}

/** 格式化任务时长；缺服务端开始时间时不补零、不猜测。 */
export function formatTaskDuration(
	startedAt: string | null,
	completedAt: string | null,
	nowMs: number,
): string | null {
	if (!startedAt) return null;
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;
	const ended = completedAt ? Date.parse(completedAt) : nowMs;
	if (!Number.isFinite(ended) || ended < started) return null;
	const seconds = Math.floor((ended - started) / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** 客户端静默时长：只表示“多久没收到更新”，不能判定 Executor 失败。 */
export function formatSilence(lastEventAt: string | null, nowMs: number): string | null {
	if (!lastEventAt) return null;
	const last = Date.parse(lastEventAt);
	if (!Number.isFinite(last)) return null;
	const seconds = Math.max(0, Math.floor((nowMs - last) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
