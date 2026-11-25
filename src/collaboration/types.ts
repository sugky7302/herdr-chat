import type { PaneInfo } from '../herdr/types';

export type CollaborationRole = 'planner' | 'worker';
export type RequestStatus = 'sending' | 'running' | 'awaiting_report' | 'needs_input' | 'completed' | 'failed' | 'wait_expired';
export type TaskStatus = 'active' | 'handoff_pending' | 'archived';

/** A Herdr pane can be reused; retain its original agent/session as well as its location. */
export interface AgentIdentity {
  paneId: string;
  tabId: string;
  harness: string;
  name?: string;
  terminalId?: string;
  session?: { kind: 'id' | 'path'; value: string; source: string };
}

export interface CollaborationRequest {
  id: string;
  taskId: string;
  requestedBy: AgentIdentity;
  target: AgentIdentity;
  generation: number;
  prompt: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  /** Revision changes when answering a question, so an old native wait cannot overwrite the continuation. */
  revision: number;
  report?: { status: 'completed' | 'needs_input' | 'failed'; text: string; at: string; reportId: string };
  reports: { status: 'completed' | 'needs_input' | 'failed'; text: string; at: string; reportId: string; revision: number }[];
  replies: { text: string; at: string; by: AgentIdentity }[];
  runtimeStatus?: string;
  error?: string;
}

export interface CollaborationEvent {
  id: string;
  at: string;
  type: 'task_created' | 'planner_selected' | 'planner_enabled' | 'user_message' | 'checkpoint_created' | 'task_archived' | 'agent_created' | 'delegated' | 'state_changed' | 'reported' | 'answered' | 'handoff_started' | 'handoff_sent' | 'handoff_accepted' | 'handoff_delta' | 'handoff_failed' | 'memory_saved';
  text: string;
  requestId?: string;
  paneId?: string;
}

export interface Handoff {
  id: string;
  generation: number;
  from: AgentIdentity;
  target?: AgentIdentity;
  status: 'preparing' | 'awaiting_accept' | 'accepted' | 'failed';
  createdAt: string;
  acceptedAt?: string;
  checkpoint: string;
  /** Event watermark included in the checkpoint; subsequent results are sent after acceptance. */
  checkpointEventId?: string;
  error?: string;
}

export interface CollaborationTask {
  id: string;
  tabId: string;
  title: string;
  repositoryRoot: string;
  checkoutPath: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  generation: number;
  enabled: boolean;
  plannerDelivery?: { status: 'sending' | 'sent' | 'uncertain'; at: string; error?: string };
  planner: AgentIdentity;
  participants: AgentIdentity[];
  requests: CollaborationRequest[];
  events: CollaborationEvent[];
  handoffs: Handoff[];
  goal?: string;
  userMessages: { paneId: string; text: string; at: string }[];
  checkpoint?: { text: string; capturedAt: string };
  memoryReferences: MemoryReference[];
}

export interface MemoryReference {
  id: number | string;
  title?: string;
  text?: string;
  project?: string;
  source?: { paneId?: string; role?: string; messageIndex?: number; text?: string };
  savedAt: string;
}

export interface LivePane extends PaneInfo { terminal_id?: string }

export interface CollaborationPreset {
  id: string;
  label: string;
  kind?: string;
  models?: string[];
  efforts?: string[];
  defaultModel?: string;
  defaultEffort?: string;
}

export interface CollaborationHost {
  /** Must read fresh Herdr state (not only the last UI snapshot). */
  listPanes(): Promise<LivePane[]>;
  /** Configured native-agent presets that the planner may actually spawn. */
  listPresets?(): CollaborationPreset[];
  /** The host routes to agent.prompt with native wait options when supplied. */
  prompt(paneId: string, text: string, options?: { wait: boolean; timeoutMs: number }): Promise<{ agent?: { agent_status?: string } } | void>;
  /** Create inside this existing tab, preserving the user's focused pane. */
  createAgent(presetId: string, tabId: string, model?: string, effort?: string): Promise<string>;
  /** Stop only the old planner's active turn, preserving its session and all workers. */
  pausePlanner?(paneId: string): Promise<void>;
  /** Return available original conversation text, without requiring an LLM summary. */
  captureCheckpoint(task: CollaborationTask): Promise<string>;
  publish(tasks: CollaborationTask[]): void;
}

export interface CollaborationOptions {
  storageDir: string;
  cliPath: string;
  host: CollaborationHost;
  /** Defaults to node; use a standalone Node executable, not VS Code/Electron. */
  nodeCommand?: string;
  nativeTimeoutMs?: number;
}

export interface EnsureTaskInput {
  tabId: string;
  title: string;
  repositoryRoot: string;
  checkoutPath: string;
  plannerPaneId: string;
}

export interface Caller {
  paneId: string;
  generation: number;
  sessionValue?: string;
}

export interface RpcInput {
  command: 'status' | 'spawn' | 'delegate' | 'wait' | 'report' | 'answer' | 'accept';
  taskId: string;
  caller: Caller;
  args: Record<string, unknown>;
}

export interface HandoffInput { targetPaneId?: string; presetId?: string; model?: string; effort?: string }
