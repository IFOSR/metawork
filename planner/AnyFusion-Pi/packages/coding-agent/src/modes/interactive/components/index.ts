// UI components still shared by non-interactive surfaces (CLI startup, tools, MetaWork TUI).
export { type RenderDiffOptions, renderDiff } from "./diff.ts";
export { DynamicBorder } from "./dynamic-border.ts";
export { ExtensionInputComponent } from "./extension-input.ts";
export { ExtensionSelectorComponent } from "./extension-selector.ts";
export {
	FirstTimeSetupComponent,
	type FirstTimeSetupOptions,
	type FirstTimeSetupResult,
} from "./first-time-setup.ts";
export { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
export { SessionSelectorComponent } from "./session-selector.ts";
export { truncateToVisualLines, type VisualTruncateResult } from "./visual-truncate.ts";
