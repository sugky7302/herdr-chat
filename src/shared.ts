// extension 與 webview 共用的訊息格式。

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface PresetView {
  id: string;
  label: string;
  models: string[];
  efforts: string[];
  defaultModel?: string;
  defaultEffort?: string;
  canSwitchModel: boolean;
  canSwitchEffort: boolean;
}

export interface WorktreeView {
  path: string;
  branch: string;
  workspaceId: string | null;
  current: boolean;
}

export interface AgentView {
  paneId: string;
  name: string | null;
  kind: string | null;
  presetId: string | null;
  status: AgentStatus | 'shell';
  title: string;
  focused: boolean;
}

export interface TabView {
  tabId: string;
  label: string;
  number: number;
  focused: boolean;
  status: AgentStatus | 'shell';
  agents: AgentView[];
}

export interface ProjectState {
  connected: boolean;
  error?: string;
  /** VS Code 目前沒有開啟 git 專案時為 null。 */
  repoName: string | null;
  repoRoot: string | null;
  worktrees: WorktreeView[];
  /** 目前 worktree 對應的 herdr workspace。尚未建立時為 null。 */
  workspaceId: string | null;
  workspaceLabel: string | null;
  tabs: TabView[];
  presets: PresetView[];
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'terminal' | 'notice';

export interface ChatMessage {
  role: ChatRole;
  text: string;
  /** 工具呼叫的名稱，例如 Bash。 */
  tool?: string;
}

export interface Transcript {
  paneId: string;
  source: 'claude' | 'codex' | 'terminal';
  messages: ChatMessage[];
  model?: string;
  effort?: string;
  /** 終端機目前的畫面。agent 等待回應或使用者開啟終端機檢視時才有。 */
  screen?: string;
}

export type ToWebview =
  | { type: 'state'; state: ProjectState }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'navigate'; view: 'history' | 'newAgent' }
  | { type: 'openedPane'; paneId: string }
  | { type: 'busy'; busy: boolean; text?: string }
  | { type: 'error'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openPane'; paneId: string | null }
  | { type: 'focusTab'; tabId: string }
  | { type: 'focusPaneInHerdr'; paneId: string }
  | { type: 'newTab' }
  | { type: 'newAgent'; presetId: string; tabId: string | null; model?: string; effort?: string; saveAsDefault?: boolean }
  | { type: 'send'; paneId: string; text: string; model?: string; effort?: string }
  | { type: 'interrupt'; paneId: string }
  | { type: 'keys'; paneId: string; keys: string[] }
  | { type: 'showScreen'; paneId: string; show: boolean }
  | { type: 'switchWorktree'; path: string }
  | { type: 'createWorktree'; branch: string }
  | { type: 'createWorkspace' }
  | { type: 'openSettings' };
