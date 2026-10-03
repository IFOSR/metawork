import type {
	ConversationActivityView,
	ConversationTaskSummary,
} from "../../anyfusion/conversation-observation-protocol.ts";
import type { MetaWorkConversationSummary } from "./model.ts";

export interface TaskOverviewRow extends ConversationTaskSummary {
	readonly conversationId: string;
	readonly conversationTitle: string;
}

export interface TaskOverviewState {
	readonly rows: readonly TaskOverviewRow[];
	readonly loading: boolean;
	readonly error: string | null;
	readonly more: readonly string[];
	readonly previous: readonly string[];
}

/** Disposable activity resources for the loaded directory, never execution state. */
export class WorkspaceTaskOverview {
	private workspaceId: string | null = null;
	private generation = 0;
	private summaries: readonly MetaWorkConversationSummary[] = [];
	private readonly pages = new Map<string, ConversationActivityView>();
	private readonly versions = new Map<string, number>();
	private loading = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private cursor = 0;
	private readonly pageCursors = new Map<string, string>();
	private readonly read: (id: string, cursor?: string) => Promise<ConversationActivityView>;
	private readonly changed: () => void;
	private readonly errors = new Map<string, string>();

	constructor(read: (id: string, cursor?: string) => Promise<ConversationActivityView>, changed: () => void) {
		this.read = read;
		this.changed = changed;
	}

	state(): TaskOverviewState {
		return {
			rows: this.summaries.flatMap((summary) =>
				(this.pages.get(summary.conversationId)?.tasks ?? []).map((task) => ({
					...task,
					conversationId: summary.conversationId,
					conversationTitle: summary.title,
				})),
			),
			previous: [...this.pageCursors.keys()],
			loading: this.loading,
			error: this.errors.values().next().value ?? null,
			more: this.summaries
				.filter((summary) => this.pages.get(summary.conversationId)?.nextCursor)
				.map((summary) => summary.conversationId),
		};
	}

	update(workspaceId: string | null, summaries: readonly MetaWorkConversationSummary[]): void {
		if (workspaceId !== this.workspaceId) {
			this.clear();
			this.workspaceId = workspaceId;
		}
		this.summaries = summaries.filter((item) => item.workspaceId === workspaceId);
		const ids = new Set(this.summaries.map((item) => item.conversationId));
		for (const id of this.pages.keys())
			if (!ids.has(id)) {
				this.pages.delete(id);
				this.versions.delete(id);
				this.pageCursors.delete(id);
				this.errors.delete(id);
			}
		if (!this.timer && !this.loading && this.summaries.length) this.schedule(0);
	}

	observe(id: string, view: ConversationActivityView): void {
		if (!this.summaries.some((item) => item.conversationId === id)) return;
		this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
		if (!this.pageCursors.has(id)) this.pages.set(id, view);
	}

	async loadMore(id: string): Promise<void> {
		const page = this.pages.get(id);
		if (!page?.nextCursor || this.loading) return;
		await this.load(id, page.nextCursor);
	}

	async first(id: string): Promise<void> {
		if (!this.loading) await this.load(id);
	}

	clear(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.pages.clear();
		this.versions.clear();
		this.pageCursors.clear();
		this.errors.clear();
		this.summaries = [];
		this.loading = false;
		this.cursor = 0;
	}

	private schedule(ms: number): void {
		this.timer = setTimeout(() => {
			this.timer = null;
			const summary = this.summaries[this.cursor % this.summaries.length];
			this.cursor++;
			if (summary) void this.load(summary.conversationId, this.pageCursors.get(summary.conversationId));
		}, ms);
		this.timer.unref?.();
	}

	private async load(id: string, cursor?: string): Promise<void> {
		const generation = this.generation;
		const version = this.versions.get(id) ?? 0;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.loading = true;
		this.changed();
		try {
			const page = await this.read(id, cursor);
			if (generation !== this.generation || !this.summaries.some((item) => item.conversationId === id)) return;
			if ((this.versions.get(id) ?? 0) !== version) return;
			if (!Array.isArray(page.tasks)) throw new Error("任务概览暂不可用");
			this.pages.set(id, page);
			this.errors.delete(id);
			if (cursor) this.pageCursors.set(id, cursor);
			else this.pageCursors.delete(id);
		} catch (error) {
			if (generation !== this.generation) return;
			this.pages.delete(id);
			this.errors.set(id, error instanceof Error ? error.message : String(error));
		} finally {
			if (generation === this.generation) {
				this.loading = false;
				this.changed();
				// At most two background resource requests per second; leave room for selected detail.
				if (this.timer) clearTimeout(this.timer);
				if (this.summaries.length) this.schedule(Math.max(500, 3_000 / this.summaries.length));
			}
		}
	}
}
