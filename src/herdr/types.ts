export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentSession {
  agent: string;
  kind: 'id' | 'path';
  source: string;
  value: string;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  active_tab_id?: string;
  agent_status?: AgentStatus;
  tab_count?: number;
  pane_count?: number;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status?: AgentStatus;
  pane_count?: number;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string | null;
  display_agent?: string | null;
  /** agent 名稱。只在 snapshot.agents 中出現。 */
  name?: string | null;
  /** pane 標籤。 */
  label?: string | null;
  title?: string | null;
  agent_status?: AgentStatus;
  agent_session?: AgentSession;
  terminal_title?: string;
  terminal_title_stripped?: string;
}

export interface Snapshot {
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: PaneInfo[];
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  label?: string;
  is_linked_worktree: boolean;
  is_detached: boolean;
  is_bare: boolean;
  is_prunable?: boolean;
  open_workspace_id?: string | null;
}

export interface WorktreeList {
  source: {
    repo_root: string;
    repo_name: string;
    source_checkout_path: string;
    source_workspace_id?: string | null;
  };
  worktrees: WorktreeInfo[];
}
