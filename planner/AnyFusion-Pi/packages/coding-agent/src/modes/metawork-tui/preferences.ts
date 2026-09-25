/**
 * MetaWork TUI 客户端偏好（统一 TUI 设计 §5、§12）。
 *
 * 只保存 UI 偏好（主题等），独立于 Planner home、SecretStore 和 Configuration
 * Control Plane。默认不持久化草稿、结果、权限请求、Task 状态或完整历史。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface MetaWorkTuiPreferences {
	readonly theme?: string;
}

export interface MetaWorkTuiPreferencesStore {
	load(): MetaWorkTuiPreferences;
	save(preferences: MetaWorkTuiPreferences): void;
}

const ALLOWED_KEYS = new Set(["theme"]);

/** 客户端偏好路径：显式覆盖优先，其次 MetaWork 配置目录。 */
export function resolvePreferencesPath(env: NodeJS.ProcessEnv): string {
	const explicit = env.METAWORK_TUI_PREFERENCES?.trim();
	if (explicit) return explicit;
	const configHome = env.METAWORK_CONFIG_HOME?.trim()
		|| join(homedir(), ".config", "metawork");
	return join(configHome, "tui-preferences.json");
}

/** 文件偏好存储：读取/写入失败一律降级为默认值，绝不因偏好崩溃界面。 */
export function createFilePreferencesStore(path: string): MetaWorkTuiPreferencesStore {
	return {
		load(): MetaWorkTuiPreferences {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				return sanitizePreferences(parsed);
			} catch {
				return {};
			}
		},
		save(preferences: MetaWorkTuiPreferences): void {
			try {
				const sanitized = sanitizePreferences(preferences);
				mkdirSync(dirname(path), { recursive: true });
				const temporary = `${path}.tmp`;
				writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
				renameSync(temporary, path);
			} catch {
				// 偏好写入失败不影响业务；界面继续使用当前进程内设置。
			}
		},
	};
}

/** 白名单化：未知字段（可能来自旧版本或被篡改的文件）一律丢弃。 */
export function sanitizePreferences(value: unknown): MetaWorkTuiPreferences {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const preferences: { theme?: string } = {};
	for (const key of Object.keys(record)) {
		if (!ALLOWED_KEYS.has(key)) continue;
		if (key === "theme" && typeof record.theme === "string" && record.theme.trim()) {
			preferences.theme = record.theme.trim().slice(0, 128);
		}
	}
	return preferences;
}
