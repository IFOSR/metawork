/**
 * MetaWork 唯一 TUI 入口（统一 TUI 设计 §6）。
 *
 * `metawork` / `metawork tui` 通过 TuiClientLauncher 以 `--gateway-socket` 进入
 * 这里；可选 Conversation 与 cwd hint 语义不变。客户端只做 Gateway 客户端：
 * 不创建本地 Agent 会话运行时、不执行模型调用、不管理 Pi 会话文件。
 */

import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { GatewayClient } from "../../anyfusion/gateway-client.ts";
import {
	GATEWAY_CAPABILITY_COMMAND_COMPLETION,
	GATEWAY_CAPABILITY_TASK_VIEW,
} from "../../anyfusion/gateway-protocol.ts";
import { GatewaySocketTransport } from "../../anyfusion/gateway-socket-transport.ts";
import { initTheme, stopThemeWatcher } from "../interactive/theme/theme.ts";
import { MetaWorkTuiApp } from "./app.ts";
import { MetaWorkTuiController } from "./controller.ts";
import { createFilePreferencesStore, resolvePreferencesPath } from "./preferences.ts";

export interface RunMetaWorkTuiInput {
	readonly socketPath: string;
	readonly conversationId?: string;
	readonly workspaceHint?: string;
	/** 测试注入；生产使用 TUI(ProcessTerminal)。 */
	readonly ui?: TUI;
	readonly env?: NodeJS.ProcessEnv;
}

/** 新 TUI 要求的必需能力：缺失时明确提示升级，不静默丢面板。 */
export const METAWORK_TUI_REQUIRED_CAPABILITIES: readonly string[] = [
	GATEWAY_CAPABILITY_COMMAND_COMPLETION,
	GATEWAY_CAPABILITY_TASK_VIEW,
	"conversation_observation_v1",
	"conversation_resources_v1",
	"multi_client_control_v1",
];

export async function runMetaWorkTui(input: RunMetaWorkTuiInput): Promise<void> {
	const env = input.env ?? process.env;
	const preferences = createFilePreferencesStore(resolvePreferencesPath(env));
	initTheme(preferences.load().theme ?? "dark", true);
	const ui = input.ui ?? new TUI(new ProcessTerminal());
	const transport = new GatewaySocketTransport(input.socketPath);
	const gateway = new GatewayClient(transport);
	let app: MetaWorkTuiApp | null = null;
	const controller = new MetaWorkTuiController({
		gateway,
		conversationId: input.conversationId,
		workspaceHint: input.workspaceHint,
		requiredCapabilities: METAWORK_TUI_REQUIRED_CAPABILITIES,
		onStateChange: (view) => app?.handleView(view),
		onExit: () => stop(),
	});
	let stopped = false;
	let finish!: () => void;
	const completed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stop = () => {
		if (stopped) return;
		stopped = true;
		controller.stop();
		transport.close();
		app?.stop();
		ui.stop();
		finish();
	};
	app = new MetaWorkTuiApp({ ui, controller, preferences, onExit: stop });
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		app.start();
		await controller.start();
		await completed;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		stop();
		stopThemeWatcher();
	}
}
