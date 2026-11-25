// extension 與 webview 共用的訊息格式。
import type { CollaborationTask } from './collaboration/types';

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
  /** 自動啟動與等待需要 Herdr 能識別的 agent kind。 */
  canAutomate?: boolean;
}

export interface WorktreeView {
  path: string;
  branch: string;
  workspaceId: string | null;
  current: boolean;
}

export interface AgentView {
  paneId: string;
  /** pane 標籤（使用者自訂名稱）。 */
  label: string | null;
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

export interface Usage {
  /** 目前上下文使用的 token 數（最後一次請求）。 */
  contextTokens?: number;
  /** 模型的上下文上限。紀錄中沒有時為 undefined。 */
  contextWindow?: number;
  /** 整段對話累計的 token 數（輸入含快取 + 輸出）。 */
  totalTokens?: number;
  outputTokens?: number;
  /** 方案額度已使用的百分比（Codex 才有）。 */
  rateLimitPercent?: number;
  rateLimitWindowMinutes?: number;
  /** 方案額度的重設時間（Unix 秒）。 */
  rateLimitResetsAt?: number;
  /** 第二個額度視窗（例如 Claude 的 7 天用量）。 */
  secondaryPercent?: number;
  secondaryWindowMinutes?: number;
  secondaryResetsAt?: number;
}

export interface CompletionItem {
  label: string;
  insert: string;
  description?: string;
  kind: 'command' | 'file';
}

export interface QueuedView {
  id: number;
  text: string;
  attachments: string[];
}

export interface Transcript {
  paneId: string;
  source: 'claude' | 'codex' | 'agy' | 'terminal';
  messages: ChatMessage[];
  model?: string;
  effort?: string;
  usage?: Usage;
  /** 等待送出的訊息（agent 工作中時排隊）。 */
  queue?: QueuedView[];
  /** agent 跳出的確認畫面中的選項。 */
  dialog?: { number: number; text: string; highlighted: boolean; description?: string }[];
  dialogTitle?: string;
  dialogQuestion?: string;
  /** 終端機目前的畫面。agent 等待回應或使用者開啟終端機檢視時才有。 */
  screen?: string;
}

export type ToWebview =
  | { type: 'state'; state: ProjectState }
  | { type: 'collaborationState'; tasks: CollaborationTask[] }
  | { type: 'taskOperation'; tabId: string; operationId: string; kind: 'memory' | 'handoff' | 'delegate' | 'planner' | 'checkpoint' | 'answer'; error?: string; memoryId?: number; checkpoint?: string }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'navigate'; view: 'history' | 'newAgent' }
  | { type: 'openedPane'; paneId: string }
  | { type: 'completions'; requestId: number; items: CompletionItem[] }
  | { type: 'attachments'; paneId: string; paths: string[] }
  | { type: 'queuedUpdated'; paneId: string; id: number; error?: string }
  | { type: 'busy'; busy: boolean; text?: string }
  | { type: 'error'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openPane'; paneId: string | null }
  | { type: 'openTask'; tabId: string }
  | { type: 'saveTaskMemory'; tabId: string; operationId: string; title: string; text: string; source?: { paneId: string; messageIndex: number; role: ChatRole; text: string } }
  | { type: 'prepareHandoff'; tabId: string; operationId: string }
  | { type: 'requestHandoff'; tabId: string; operationId: string; target: { paneId: string } | { presetId: string }; reason?: string }
  | { type: 'delegateTask'; tabId: string; operationId: string; target: { paneId: string } | { presetId: string }; text: string }
  | { type: 'assignPlanner'; tabId: string; paneId: string; operationId: string }
  | { type: 'copyCollaborationPrompt'; tabId: string }
  | { type: 'answerTaskRequest'; tabId: string; requestId: string; operationId: string; text: string }
  | { type: 'focusTab'; tabId: string }
  | { type: 'focusPaneInHerdr'; paneId: string }
  | { type: 'newTab' }
  | { type: 'newAgent'; presetId: string; tabId: string | null; model?: string; effort?: string; saveAsDefault?: boolean }
  | {
      type: 'send';
      paneId: string;
      text: string;
      model?: string;
      effort?: string;
      attachments?: string[];
      /** now：agent 工作中也立刻插入；queue（預設）：工作中先排隊。 */
      mode?: 'queue' | 'now';
    }
  | { type: 'removeQueued'; paneId: string; id: number }
  | { type: 'updateQueued'; paneId: string; id: number; text: string }
  | { type: 'insertQueued'; paneId: string; id: number }
  | { type: 'chooseOption'; paneId: string; number: number }
  | { type: 'renameTab'; tabId: string }
  | { type: 'closeTab'; tabId: string }
  | { type: 'renamePane'; paneId: string }
  | { type: 'closePane'; paneId: string }
  | { type: 'complete'; requestId: number; paneId: string; trigger: '/' | '@'; query: string }
  | { type: 'pickFiles'; paneId: string }
  | { type: 'dropUris'; paneId: string; uris: string[] }
  | { type: 'dropFiles'; paneId: string; files: { name: string; base64: string }[] }
  | { type: 'refreshCommands'; paneId: string }
  | { type: 'interrupt'; paneId: string }
  | { type: 'keys'; paneId: string; keys: string[] }
  | { type: 'showScreen'; paneId: string; show: boolean }
  | { type: 'switchWorktree'; path: string }
  | { type: 'createWorktree'; branch: string }
  | { type: 'createWorkspace' }
  | { type: 'openSettings' };
