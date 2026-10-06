export type DesktopMenuAction = 'new-conversation' | 'search' | 'settings' | 'toggle-sidebar';
export interface DesktopDraft { text: string; attachments: unknown[] }
export interface DesktopViewport { turnId: string; offset: number; bottom: boolean }
export interface DesktopPreferences {
  theme: 'system' | 'light' | 'dark';
  drafts: Record<string, DesktopDraft>;
  viewports?: Record<string, DesktopViewport>;
  route?: string;
}
export interface DesktopBridge {
  version: 1;
  selectWorkspaceDirectory(): Promise<string | null>;
  saveArtifact(artifactId: string): Promise<string | null>;
  showDownloadedArtifact(downloadId: string): Promise<void>;
  readPreferences(): Promise<DesktopPreferences>;
  setTheme(theme: DesktopPreferences['theme']): Promise<void>;
  setDraft(conversationId: string, draft: DesktopDraft | null): Promise<void>;
  clearDrafts(): Promise<void>;
  setViewport(conversationId: string, viewport: DesktopViewport | null): Promise<void>;
  setRoute(route: string): Promise<void>;
  reconnect(): Promise<void>;
  onMenu(listener: (action: DesktopMenuAction) => void): () => void;
}
export interface ShellState {
  phase: 'connecting' | 'ready' | 'error' | 'setup';
  message: string;
}
export interface DesktopSetupInput { baseUrl: string; apiKey: string; modelId: string }
export interface DesktopShellBridge {
  state(): Promise<ShellState>;
  retry(): Promise<void>;
  setup(input: DesktopSetupInput): Promise<void>;
  onState(listener: (state: ShellState) => void): () => void;
}
