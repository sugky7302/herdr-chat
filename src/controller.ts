import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { effortLabel, menuKind, nextKey, normalizeLabel, parseDialog, parseMenu, parsePrompt, type MenuKind } from './codexMenu';
import { CollaborationService } from './collaboration/service';
import type { AgentIdentity, CollaborationTask, LivePane } from './collaboration/types';
import { Commands } from './commands';
import { HerdrClient, HerdrError, HerdrEvents, resolveSocketPath } from './herdr/client';
import type { PaneInfo, Snapshot, WorktreeList } from './herdr/types';
import { t } from './l10n.ts';
import { ClaudeMemClient, memoryFingerprint } from './memory/claudeMem';
import {
  agentName,
  buildShellCommand,
  buildStartArgs,
  normalizePresets,
  presetForKind,
  switchCommand,
  toPresetView,
  type AgentPreset,
} from './presets';
import type { AgentView, CompletionItem, FromWebview, ProjectState, QueuedView, TabView, ToWebview, Transcript, WorktreeView } from './shared';
import { TranscriptSource } from './transcript/source';
import { DeepseekUsageTracker } from './deepseekUsage';

const run = promisify(execFile);

/** 每個 pane 由擴充功能記住的設定。herdr 不保存這些資料。 */
interface QueuedMessage extends QueuedView {
  model?: string;
  effort?: string;
}

interface PaneMemory {
  presetId: string;
  model?: string;
  effort?: string;
}

interface TranscriptSnapshot {
  identity: AgentIdentity;
  transcript: Transcript;
}

function paneIdentity(pane: LivePane): AgentIdentity {
  return {
    paneId: pane.pane_id, tabId: pane.tab_id, harness: pane.agent ?? pane.display_agent ?? 'terminal',
    terminalId: pane.terminal_id,
    session: pane.agent_session ? { kind: pane.agent_session.kind, value: pane.agent_session.value, source: pane.agent_session.source } : undefined,
  };
}

function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.paneId === b.paneId && a.tabId === b.tabId && a.harness === b.harness
    && a.terminalId === b.terminalId && a.session?.kind === b.session?.kind && a.session?.value === b.session?.value;
}

const PANE_MEMORY_KEY = 'herdr.paneMemory';
/** 新增空白終端機 pane 的特殊選項代號。 */
export const SHELL_PRESET = '__shell__';
const SELECTED_WORKTREE_KEY = 'herdr.selectedWorktree';

export class Controller implements vscode.Disposable {
  readonly client: HerdrClient;
  private readonly events: HerdrEvents;
  private readonly transcripts: TranscriptSource;
  private snapshot: Snapshot | null = null;
  private worktrees: WorktreeList | null = null;
  private gitRoot: string | null = null;
  private state: ProjectState | null = null;
  private openPaneId: string | null = null;
  /** 使用者開啟「終端機畫面」的 pane。 */
  private screenPanes = new Set<string>();
  /** 每個 pane 的訊息佇列。agent 回到空閒後依序送出。 */
  private queues = new Map<string, QueuedMessage[]>();
  private delivering = new Set<string>();
  private nextQueueId = 1;
  private readonly commands: Commands;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly disposables: vscode.Disposable[] = [];
  private disposal?: Promise<void>;
  readonly collaboration: CollaborationService;
  private readonly collaborationReady: Promise<void>;
  private collaborationError: string | undefined;
  private readonly memoryClient: ClaudeMemClient;
  private readonly transcriptSnapshots = new Map<string, TranscriptSnapshot>();
  private readonly deepseek = new DeepseekUsageTracker();
  private readonly checkpointTimes = new Map<string, number>();
  private readonly checkpointing = new Set<string>();

  constructor(
    private readonly memento: vscode.Memento,
    private readonly post: (message: ToWebview) => void,
    globalMemento?: vscode.Memento,
    integration?: { storageDir: string; cliPath: string },
  ) {
    this.client = new HerdrClient(resolveSocketPath(config().get<string>('socketPath')));
    this.transcripts = new TranscriptSource(this.client, () => config().get<number>('transcriptLines') ?? 400);
    this.events = new HerdrEvents(this.client);
    this.commands = new Commands(globalMemento ?? memento);
    this.memoryClient = new ClaudeMemClient(() => ({
      baseUrl: config().get<string>('claudeMemUrl'),
      settingsPath: config().get<string>('claudeMemSettingsPath'),
    }));
    this.collaboration = new CollaborationService({
      storageDir: integration?.storageDir ?? path.join(os.homedir(), '.herdr-chat', 'collaboration'),
      cliPath: integration?.cliPath ?? path.join(__dirname, 'herdr-collab.cjs'),
      nodeCommand: config().get<string>('collaborationNodePath') || 'node',
      host: {
        listPanes: () => this.livePanes(),
        listPresets: () => this.presets().filter((preset) => preset.kind && preset.enabled !== false).map((preset) => ({
          id: preset.id, label: preset.label, kind: preset.kind!, models: preset.models, efforts: preset.efforts,
        })),
        prompt: (paneId, text, options) => this.client.request('agent.prompt', {
          target: paneId, text,
          ...(options?.wait ? { wait: { until: ['idle', 'done', 'blocked'], timeout_ms: options.timeoutMs } } : {}),
        }, options?.wait ? options.timeoutMs + 5000 : 15000),
        createAgent: (presetId, tabId, model, effort) => this.createCollaborationAgent(presetId, tabId, model, effort),
        pausePlanner: async (paneId) => {
          await this.client.request('agent.send_keys', { target: paneId, keys: ['esc'] });
        },
        captureCheckpoint: (task) => this.captureCheckpoint(task),
        publish: (tasks) => this.publishCollaboration(tasks),
      },
    });
    this.collaborationReady = this.collaboration.initialize().catch((error) => {
      this.collaborationError = describe(error);
    });
    this.events.on('change', () => this.scheduleRefresh(150));
    this.events.on('connected', () => this.scheduleRefresh(0));
    this.events.on('disconnected', () => this.scheduleRefresh(0));
    this.events.on('subscribeFailed', () => this.scheduleRefresh(500));
    this.events.start();
    // 事件可能漏接（例如終端機標題改變或執行中的對話紀錄更新），所以工作中每 1.5 秒、平時每 3 秒檢查一次。
    this.pollTimer = setInterval(() => {
      const pane = this.openPaneId ? this.pane(this.openPaneId) : undefined;
      if (pane?.agent_status === 'working' || pane?.agent_status === 'blocked') void this.pushTranscript();
      this.scheduleRefresh(0);
    }, 1500);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.gitRoot = null;
        this.scheduleRefresh(0);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('herdr.socketPath')) {
          this.client.socketPath = resolveSocketPath(config().get<string>('socketPath'));
          this.events.reconnectNow();
        }
        if (event.affectsConfiguration('herdr')) this.scheduleRefresh(0);
      }),
    );
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    clearTimeout(this.refreshTimer);
    clearInterval(this.pollTimer);
    this.events.dispose();
    this.disposal = this.collaboration.dispose().catch(() => undefined);
    this.disposables.forEach((item) => item.dispose());
    return this.disposal;
  }

  /** 選項清單。專案設定 herdr.agentDefaults 會覆蓋選項的預設模型與 effort。 */
  presets(): AgentPreset[] {
    const defaults = this.projectConfig().get<Record<string, { model?: string; effort?: string }>>('agentDefaults') ?? {};
    return normalizePresets(this.projectConfig().get('agentPresets')).map((preset) => {
      const local = defaults[preset.id];
      if (!local) return preset;
      return { ...preset, defaultModel: local.model || preset.defaultModel, defaultEffort: local.effort || preset.defaultEffort };
    });
  }

  /** 讀取目前專案資料夾範圍的設定，讓 .vscode/settings.json 生效。 */
  private projectConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('herdr', this.settingsWorkspace().resource);
  }

  /** Settings follow VS Code's folder scope; Skills follow the checkout where new agents start. */
  settingsWorkspace(): { resource?: vscode.Uri; root?: string } {
    const root = this.gitRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const folder = (root ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) : undefined)
      ?? vscode.workspace.workspaceFolders?.[0];
    return { resource: folder?.uri, root: this.gitRoot ? this.selectedWorktreePath() : root };
  }

  clearCommandCache(): void { this.commands.clearDiskCache(); }

  /** 把模型與 effort 存成這個專案的預設值（寫入工作區設定）。 */
  async saveProjectDefault(presetId: string, model?: string, effort?: string): Promise<void> {
    const settings = this.projectConfig();
    const current = { ...(settings.get<Record<string, { model?: string; effort?: string }>>('agentDefaults') ?? {}) };
    const entry: { model?: string; effort?: string } = {};
    if (model) entry.model = model;
    if (effort) entry.effort = effort;
    if (Object.keys(entry).length) current[presetId] = entry;
    else delete current[presetId];
    const folder = this.gitRoot ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.gitRoot)) : undefined;
    const target = folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Workspace;
    await settings.update('agentDefaults', current, target);
  }

  setOpenPane(paneId: string | null): void {
    this.openPaneId = paneId;
    if (paneId) void this.pushTranscript();
  }

  scheduleRefresh(delay: number): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  /** 重新讀取 herdr 狀態。同時只執行一次，期間的新請求合併成下一次。 */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const presets = this.presets();
    const base: ProjectState = {
      connected: false,
      repoName: null,
      repoRoot: null,
      worktrees: [],
      workspaceId: null,
      workspaceLabel: null,
      tabs: [],
      presets: presets.map(toPresetView),
    };
    try {
      this.gitRoot ??= await findGitRoot();
      this.snapshot = await this.client.snapshot();
      base.connected = true;
      if (!this.gitRoot) {
        this.publish({ ...base, error: t("No Git project is open in this VS Code window.") });
        return;
      }
      this.worktrees = await this.client
        .request<WorktreeList>('worktree.list', { cwd: this.gitRoot })
        .catch(() => null);
      const selected = this.selectedWorktreePath();
      const worktrees: WorktreeView[] = (this.worktrees?.worktrees ?? [])
        .filter((tree) => !tree.is_bare && !tree.is_prunable)
        .map((tree) => ({
          path: tree.path,
          branch: tree.branch ?? (tree.is_detached ? t("(detached) {0}", shortPath(tree.path)) : path.basename(tree.path)),
          workspaceId: tree.open_workspace_id ?? null,
          current: samePath(tree.path, selected),
        }));
      const current = worktrees.find((tree) => tree.current);
      const workspaceId = current?.workspaceId ?? this.workspaceByCwd(selected);
      const workspace = this.snapshot.workspaces.find((item) => item.workspace_id === workspaceId);
      const state: ProjectState = {
        ...base,
        repoName: this.worktrees?.source.repo_name ?? path.basename(this.gitRoot),
        repoRoot: this.worktrees?.source.repo_root ?? this.gitRoot,
        worktrees,
        workspaceId: workspace ? workspace.workspace_id : null,
        workspaceLabel: workspace?.label ?? null,
        tabs: workspace ? this.buildTabs(workspace.workspace_id, presets) : [],
      };
      this.events.watchPanes(
        this.snapshot.panes.filter((pane) => pane.workspace_id === state.workspaceId).map((pane) => pane.pane_id),
      );
      this.publish(state);
      await this.collaborationReady;
      if (!this.collaborationError) {
        const liveTabs = new Map(this.snapshot.tabs.map((tab) => [tab.tab_id, tab]));
        for (const task of this.collaboration.getTasks()) {
          if (task.status !== 'archived' && !liveTabs.has(task.tabId)) await this.collaboration.archiveTask(task.tabId);
          const label = liveTabs.get(task.tabId)?.label;
          if (task.status !== 'archived' && label && label !== task.title) await this.collaboration.updateTaskTitle(task.id, label);
        }
        this.publishCollaboration();
        this.scheduleCheckpoints();
      }
      this.drainQueues();
      if (this.openPaneId) await this.pushTranscript();
    } catch (error) {
      this.publish({ ...base, error: describe(error) });
    }
  }

  private publish(state: ProjectState): void {
    this.state = state;
    this.post({ type: 'state', state });
  }

  private publishCollaboration(tasks = this.collaboration.getTasks()): void {
    this.post({ type: 'collaborationState', tasks: tasks.filter((task) => this.gitRoot && samePath(task.repositoryRoot, this.gitRoot)) });
  }

  private async livePanes(): Promise<LivePane[]> {
    const snapshot = await this.client.snapshot();
    const agents = new Map(snapshot.agents.map((agent) => [agent.pane_id, agent]));
    return snapshot.panes.map((pane) => ({ ...pane, ...agents.get(pane.pane_id) }));
  }

  /** Bind every action before its first await; selecting another worktree cannot retarget it. */
  async openTask(tabId: string): Promise<CollaborationTask> {
    const tab = this.state?.tabs.find((item) => item.tabId === tabId);
    const repositoryRoot = this.gitRoot;
    const workspaceId = this.snapshot?.tabs.find((item) => item.tab_id === tabId)?.workspace_id ?? (tab ? this.state?.workspaceId : undefined);
    const checkoutPath = repositoryRoot ? (
      this.worktrees?.worktrees.find((tree) => workspaceId && tree.open_workspace_id === workspaceId)?.path
      ?? this.state?.worktrees.find((tree) => workspaceId && tree.workspaceId === workspaceId)?.path
      ?? this.state?.worktrees.find((tree) => tree.current)?.path
      ?? this.selectedWorktreePath()
    ) : undefined;
    await this.collaborationReady;
    if (this.collaborationError) throw new Error(t("Collaboration history could not be started: {0}", this.collaborationError));
    const existing = this.collaboration.getTaskForTab(tabId)
      ?? this.collaboration.getTasks().find((task) => task.tabId === tabId && task.status === 'archived');
    if (existing) {
      if (!repositoryRoot || !samePath(existing.repositoryRoot, repositoryRoot)) throw new Error(t("This task does not belong to the current project."));
      this.publishCollaboration();
      if (tab && existing.status !== 'archived' && existing.title !== tab.label) return this.collaboration.updateTaskTitle(existing.id, tab.label);
      return existing;
    }
    if (!tab || !repositoryRoot || !checkoutPath) throw new Error(t("The current task could not be found. Refresh and try again."));
    const agents = tab.agents.filter((agent) => agent.status !== 'shell' && agent.kind);
    const planner = agents.find((agent) => agent.presetId === 'claude') ?? agents[0];
    if (!planner) throw new Error(t("Start an agent in this task first."));
    return this.collaboration.ensureTask({ tabId, title: tab.label, repositoryRoot, checkoutPath, plannerPaneId: planner.paneId });
  }

  async prepareHandoff(tabId: string): Promise<string> {
    const task = await this.openTask(tabId);
    const prepared = await this.collaboration.prepareCheckpoint(task.id);
    return prepared.checkpoint?.text ?? '';
  }

  async requestHandoff(tabId: string, target: { paneId: string } | { presetId: string }): Promise<void> {
    const task = await this.openTask(tabId);
    if (task.status === 'archived') throw new Error(t("This task is archived. Open an active task in Herdr first."));
    await this.collaboration.beginHandoff(task.id, 'paneId' in target ? { targetPaneId: target.paneId } : { presetId: target.presetId });
  }

  async assignPlanner(tabId: string, paneId: string): Promise<void> {
    const task = await this.openTask(tabId);
    await this.collaboration.setPlannerFromUser(task.id, paneId);
    await this.collaboration.enablePlanner(task.id);
  }

  async copyCollaborationPrompt(tabId: string): Promise<void> {
    const task = await this.openTask(tabId);
    await vscode.env.clipboard.writeText(this.collaboration.getCollaborationPrompt(task.id));
    void vscode.window.showInformationMessage(t("The collaboration instructions for this task have been copied. Paste them into the planner."));
  }

  async delegateTask(tabId: string, target: { paneId: string } | { presetId: string }, text: string): Promise<void> {
    if (!text.trim()) throw new Error(t("Enter the work to delegate."));
    const task = await this.openTask(tabId);
    const paneId = 'paneId' in target ? target.paneId : await this.createCollaborationAgent(target.presetId, task.tabId);
    await this.collaboration.delegateFromUser(task.id, paneId, text.trim());
  }

  async answerTaskRequest(tabId: string, requestId: string, text: string): Promise<void> {
    const task = await this.openTask(tabId);
    await this.collaboration.answerFromUser(task.id, requestId, text);
  }

  async saveTaskMemory(message: Extract<FromWebview, { type: 'saveTaskMemory' }>): Promise<number> {
    const task = await this.openTask(message.tabId);
    if (task.status === 'archived') throw new Error(t("This task is archived. Its memories are read-only."));
    if (message.text.length > 200_000 || message.title.length > 500) throw new Error(t("The memory is too long. Select the passages you want to keep."));
    if (message.source) {
      const source = message.source;
      const cached = this.transcriptSnapshots.get(source.paneId);
      const live = (await this.livePanes()).find((pane) => pane.pane_id === source.paneId && pane.tab_id === task.tabId);
      if (!live || !cached || !sameIdentity(cached.identity, paneIdentity(live))) throw new Error(t("The memory source agent or session has changed. Select the source again; your draft is preserved."));
      if (!cached.transcript.messages.some((item) => item.role === source.role && item.text === source.text)) {
        throw new Error(t("The source message has changed. Select it again; your memory draft is preserved."));
      }
      await this.collaboration.registerParticipant(task.id, source.paneId);
    }
    const saved = await this.memoryClient.save({
      title: message.title, text: message.text, cwd: task.checkoutPath,
      metadata: {
        platformSource: 'herdr',
        sourceFingerprint: memoryFingerprint(task.id, message.operationId, message.title, message.text),
        herdr: { taskId: task.id, tabId: task.tabId, source: message.source },
      },
    });
    await this.collaboration.addMemoryReference(task.id, { ...saved, source: message.source });
    return saved.id;
  }

  private plannerReadOnly(paneId: string): string | undefined {
    const pane = this.pane(paneId);
    if (!pane) return undefined;
    const task = this.collaboration?.getTaskForTab(pane.tab_id);
    if (!task) return undefined;
    if (task.status === 'handoff_pending' && task.planner.paneId === paneId) return t("A planner handoff is in progress. The previous planning turn is paused.");
    if (task.status === 'handoff_pending' && task.handoffs.some((handoff) => handoff.status === 'awaiting_accept' && handoff.target?.paneId === paneId)) {
      return t("Waiting for the new planner to explicitly accept the handoff. Complete the handoff first.");
    }
    if (task.planner.paneId !== paneId && task.handoffs.some((handoff) => handoff.status === 'accepted' && handoff.from.paneId === paneId)) {
      return t("This planner has handed off the task. Continue in the current planner's conversation.");
    }
    return undefined;
  }

  private assertPlannerWritable(paneId: string): void {
    const reason = this.plannerReadOnly(paneId);
    if (reason) throw Object.assign(new Error(reason), { code: 'planner_read_only' });
  }

  private refreshQueueCheckpoint(paneId: string): void {
    const pane = this.pane(paneId);
    const task = pane && this.collaboration?.getTaskForTab?.(pane.tab_id);
    if (task && this.collaboration.prepareCheckpoint) void this.collaboration.prepareCheckpoint(task.id).catch(() => undefined);
  }

  private async recordDeliveredMessage(taskId: string | undefined, paneId: string, text: string): Promise<void> {
    if (!taskId || !text.trim()) return;
    try { await this.collaboration.recordUserMessage(taskId, paneId, text); }
    catch (error) { this.post({ type: 'error', text: t("The message was sent, but the collaboration record could not be saved. Do not send the same message again. {0}", describe(error)) }); }
  }

  /** Independent from selected pane: keep usable evidence before the old planner becomes unavailable. */
  private scheduleCheckpoints(): void {
    const now = Date.now();
    for (const task of this.collaboration.getTasks()) {
      if (!this.gitRoot || !samePath(task.repositoryRoot, this.gitRoot) || task.status !== 'active') continue;
      if (this.checkpointing.has(task.id) || now - (this.checkpointTimes.get(task.id) ?? 0) < 30_000) continue;
      this.checkpointTimes.set(task.id, now);
      this.checkpointing.add(task.id);
      void this.collaboration.prepareCheckpoint(task.id).catch(() => undefined).finally(() => this.checkpointing.delete(task.id));
    }
  }

  private async captureCheckpoint(task: CollaborationTask): Promise<string> {
    const lines = [`Working directory: ${task.checkoutPath}`, `Captured at: ${new Date().toISOString()}`];
    try {
      const [branch, commit, status] = await Promise.all([
        run('git', ['-C', task.checkoutPath, 'branch', '--show-current'], { timeout: 5000 }),
        run('git', ['-C', task.checkoutPath, 'rev-parse', 'HEAD'], { timeout: 5000 }),
        run('git', ['-C', task.checkoutPath, 'status', '--short'], { timeout: 5000 }),
      ]);
      lines.push(`Branch: ${branch.stdout.trim() || '(detached)'}`, `Commit: ${commit.stdout.trim()}`, `Current file status (workers may still be editing):\n${status.stdout.trim() || 'clean'}`);
    } catch { lines.push('Git status is currently unavailable. Verify the working directory after accepting the handoff.'); }
    const live = await this.livePanes().catch(() => []);
    for (const participant of task.participants) {
      const pane = live.find((item) => item.pane_id === participant.paneId);
      const sameSession = pane && sameIdentity(participant, paneIdentity(pane));
      const cached = this.transcriptSnapshots.get(participant.paneId);
      let transcript = cached && sameIdentity(participant, cached.identity) ? cached.transcript : undefined;
      if (pane && sameSession) {
        transcript = await this.transcripts.read(pane).catch(() => transcript);
        if (transcript) this.transcriptSnapshots.set(participant.paneId, { identity: paneIdentity(pane), transcript });
      }
      lines.push(`\n## ${participant.name ?? participant.harness} (${participant.paneId})`,
        `Session: ${participant.session?.value ?? 'unavailable'}; status: ${sameSession ? pane?.agent_status ?? 'unknown' : 'original session is offline'}`);
      if (transcript) {
        const firstUser = transcript.messages.find((message) => message.role === 'user');
        if (firstUser) lines.push(`Earliest available user request: ${firstUser.text.slice(0, 8000)}`);
        for (const message of transcript.messages.slice(-24)) lines.push(`[${message.role}${message.tool ? `:${message.tool}` : ''}] ${message.text.slice(0, 4000)}`);
      } else lines.push('The native conversation is unavailable. Refer to the saved goal, delegations, and reports.');
      const queue = sameSession ? this.queues.get(participant.paneId) ?? [] : [];
      if (queue.length) lines.push('Queued user requests (not sent yet):', ...queue.map((item) => item.text));
    }
    if (task.memoryReferences.length) lines.push('\n## Memories saved for this task', ...task.memoryReferences.map((memory) => `#${memory.id} ${memory.title ?? ''}\n${memory.text ?? '(retrieve from Claude-mem by ID)'}`));
    const text = lines.join('\n');
    return text.length > 100_000 ? `${text.slice(0, 100_000)}\n[Checkpoint text was truncated. Check the original pane or native transcript for earlier content.]` : text;
  }

  /** Spawn against the captured tab, never the worktree currently selected in the UI. */
  private async createCollaborationAgent(presetId: string, tabId: string, model?: string, effort?: string): Promise<string> {
    const task = this.collaboration.getTaskForTab(tabId);
    if (!task || task.status === 'archived') throw new Error(t("No active task is available for creating a collaborator."));
    const preset = this.presets().find((item) => item.id === presetId);
    if (!preset?.kind) throw new Error(t("Automatic collaboration requires an agent kind recognized by Herdr. Start custom shell agents manually and confirm that Herdr recognizes them."));
    if (preset.enabled === false) throw new Error(t('Agent preset {0} is disabled. Enable it in Settings before starting a new agent.', preset.label));
    const live = await this.livePanes();
    const anchor = live.find((pane) => pane.tab_id === tabId && pane.pane_id === task.planner.paneId)
      ?? live.find((pane) => pane.tab_id === tabId);
    if (!anchor) throw new Error(t("The original task tab is closed. A collaborator cannot be created in a different tab."));
    const split = await this.client.request<any>('pane.split', { target_pane_id: anchor.pane_id, direction: 'right', cwd: task.checkoutPath, focus: false });
    const paneId: string = split.pane.pane_id;
    const chosenModel = model || preset.defaultModel, chosenEffort = effort || preset.defaultEffort;
    await this.rememberPane(paneId, { presetId, model: chosenModel, effort: chosenEffort });
    await this.startWithRetry({
      name: agentName(presetId, live.map((pane) => pane.name ?? '').filter(Boolean)), kind: preset.kind, pane_id: paneId,
      args: buildStartArgs(preset, chosenModel, chosenEffort), timeout_ms: 60000,
    });
    this.scheduleRefresh(0);
    return paneId;
  }

  private selectedWorktreePath(): string {
    const stored = this.memento.get<Record<string, string>>(SELECTED_WORKTREE_KEY, {});
    const choice = this.gitRoot ? stored[this.gitRoot] : undefined;
    const exists = choice && this.worktrees?.worktrees.some((tree) => samePath(tree.path, choice));
    return exists ? choice! : this.gitRoot!;
  }

  /** worktree.list 沒有回報 workspace 時，用 pane 的工作目錄找。 */
  private workspaceByCwd(root: string): string | null {
    const pane = this.snapshot?.panes.find((item) => item.cwd && isInside(item.cwd, root));
    return pane?.workspace_id ?? null;
  }

  private buildTabs(workspaceId: string, presets: AgentPreset[]): TabView[] {
    const snapshot = this.snapshot!;
    const memory = this.paneMemory();
    const agentsByPane = new Map(snapshot.agents.map((agent) => [agent.pane_id, agent]));
    return snapshot.tabs
      .filter((tab) => tab.workspace_id === workspaceId)
      .sort((a, b) => a.number - b.number)
      .map((tab) => {
        const agents: AgentView[] = snapshot.panes
          .filter((pane) => pane.tab_id === tab.tab_id)
          .map((pane) => {
            const agent = agentsByPane.get(pane.pane_id) ?? pane;
            const remembered = memory[pane.pane_id];
            const preset = presets.find((item) => item.id === remembered?.presetId) ?? presetForKind(presets, agent.agent ?? null);
            const kind = agent.agent ?? preset?.kind ?? (remembered?.presetId === 'deepseek' ? 'dsh-tui' : null);
            const presetId = remembered?.presetId ?? preset?.id ?? null;
            return {
              paneId: pane.pane_id,
              label: pane.label || null,
              name: agent.name ?? null,
              kind: agent.display_agent ?? kind,
              presetId,
              status: kind ? (agent.agent_status ?? 'idle') : 'shell',
              title: agent.terminal_title_stripped || agent.title || pane.label || '',
              focused: pane.focused,
            };
          });
        return {
          tabId: tab.tab_id,
          label: tab.label,
          number: tab.number,
          focused: tab.focused,
          status: tab.agent_status ?? (agents.length ? 'unknown' : 'shell'),
          agents,
        };
      });
  }

  private paneMemory(): Record<string, PaneMemory> {
    return this.memento.get<Record<string, PaneMemory>>(PANE_MEMORY_KEY, {});
  }

  private async rememberPane(paneId: string, value: PaneMemory): Promise<void> {
    const memory = { ...this.paneMemory(), [paneId]: value };
    // 只保留目前還存在的 pane，避免資料一直累積。
    const live = new Set(this.snapshot?.panes.map((pane) => pane.pane_id) ?? []);
    for (const key of Object.keys(memory)) if (key !== paneId && live.size && !live.has(key)) delete memory[key];
    await this.memento.update(PANE_MEMORY_KEY, memory);
  }

  private pane(paneId: string): PaneInfo | undefined {
    const agent = this.snapshot?.agents.find((item) => item.pane_id === paneId);
    const pane = this.snapshot?.panes.find((item) => item.pane_id === paneId);
    return pane ? { ...pane, ...agent } : agent;
  }

  private async pushTranscript(): Promise<void> {
    const paneId = this.openPaneId;
    if (!paneId) return;
    const pane = this.pane(paneId);
    if (!pane) {
      this.post({
        type: 'transcript',
        transcript: { paneId, source: 'terminal', messages: [{ role: 'notice', text: t("This pane is closed.") }] },
      });
      return;
    }
    let transcript: Transcript;
    try {
      transcript = await this.transcripts.read(pane);
    } catch (error) {
      transcript = { paneId, source: 'terminal', messages: [{ role: 'notice', text: describe(error) }] };
    }
    const memory = this.paneMemory()[paneId];
    transcript.model ??= memory?.model;
    transcript.effort ??= memory?.effort;
    // herdr 不一定把確認畫面回報為 blocked（例如信任資料夾畫面是 unknown 或 idle），
    // 所以只要 pane 有 agent 就讀取畫面，偵測到選項時顯示按鈕。
    if (pane.agent || this.screenPanes.has(paneId)) {
      const screen = await this.readScreen(paneId).catch(() => undefined);
      const prompt = screen && pane.agent ? parsePrompt(screen) : { options: [] };
      const dialog = prompt.options;
      if (dialog.length) {
        transcript.dialog = dialog;
        transcript.dialogTitle = prompt.title;
        transcript.dialogQuestion = prompt.question;
      }
      if (this.screenPanes.has(paneId) || dialog.length || pane.agent_status === 'blocked') transcript.screen = screen;
    }
    if (transcript.source === 'dsh') transcript.deepseek = await this.deepseek.read();
    transcript.queue = (this.queues.get(paneId) ?? []).map(({ id, text, attachments }) => ({ id, text, attachments }));
    this.transcriptSnapshots.set(paneId, { identity: paneIdentity(pane), transcript });
    const task = this.collaboration?.getTaskForTab?.(pane.tab_id);
    if (task && pane.agent_session?.value && !task.participants.some((participant) => sameIdentity(participant, paneIdentity(pane)))) {
      void this.collaboration.registerParticipant(task.id, paneId).catch(() => undefined);
    }
    if (this.openPaneId === paneId) this.post({ type: 'transcript', transcript });
  }

  // ---------- 使用者動作 ----------

  async focusTab(tabId: string): Promise<void> {
    await this.client.request('tab.focus', { tab_id: tabId });
  }

  async focusPane(paneId: string): Promise<void> {
    await this.client.request('pane.focus', { pane_id: paneId });
  }

  async switchWorktree(worktreePath: string): Promise<void> {
    if (!this.gitRoot) return;
    const stored = { ...this.memento.get<Record<string, string>>(SELECTED_WORKTREE_KEY, {}) };
    stored[this.gitRoot] = worktreePath;
    await this.memento.update(SELECTED_WORKTREE_KEY, stored);
    await this.refresh();
  }

  async createWorktree(branch: string): Promise<void> {
    if (!this.gitRoot) throw new Error(t("No Git project is open."));
    const result = await this.client.request<any>(
      'worktree.create',
      { cwd: this.gitRoot, branch, focus: false },
      120000,
    );
    const createdPath: string | undefined = result?.worktree?.path ?? result?.path;
    await this.refresh();
    if (createdPath) await this.switchWorktree(createdPath);
  }

  /** 為目前選擇的 worktree 建立 herdr workspace。 */
  async createWorkspace(): Promise<void> {
    if (!this.gitRoot) throw new Error(t("No Git project is open."));
    const target = this.selectedWorktreePath();
    const tree = this.worktrees?.worktrees.find((item) => samePath(item.path, target));
    if (tree?.is_linked_worktree) {
      await this.client.request('worktree.open', { path: tree.path, focus: false }, 60000);
    } else {
      await this.client.request('workspace.create', {
        cwd: target,
        label: this.worktrees?.source.repo_name ?? path.basename(target),
        focus: false,
      });
    }
    await this.refresh();
  }

  /** 新增一個 tab（一個新對話）。回傳新 tab 的根 pane。 */
  private async createTab(label: string): Promise<string> {
    const state = this.requireWorkspace();
    const result = await this.client.request<any>('tab.create', {
      workspace_id: state.workspaceId,
      cwd: this.selectedWorktreePath(),
      label,
      focus: false,
    });
    return result.root_pane.pane_id;
  }

  async newTab(): Promise<void> {
    await this.createTab(t("New conversation"));
    await this.refresh();
  }

  /**
   * 新增 agent。
   * tabId 為 null 時建立新 tab；否則在該 tab 內使用空的 shell pane，沒有空 pane 時切分出新 pane。
   * 回傳新 agent 所在的 pane。
   */
  async newAgent(presetId: string, tabId: string | null, model?: string, effort?: string): Promise<string> {
    if (presetId === SHELL_PRESET) {
      this.requireWorkspace();
      const paneId = tabId ? await this.splitPane(tabId) : await this.createTab(t("Terminal"));
      await this.refresh();
      return paneId;
    }
    const preset = this.presets().find((item) => item.id === presetId);
    if (!preset) throw new Error(t("Preset {0} could not be found.", presetId));
    if (preset.enabled === false) throw new Error(t('Agent preset {0} is disabled. Enable it in Settings before starting a new agent.', preset.label));
    model ||= preset.defaultModel;
    effort ||= preset.defaultEffort;
    this.requireWorkspace();
    const paneId = tabId ? await this.paneForNewAgent(tabId) : await this.createTab(preset.label);
    await this.rememberPane(paneId, { presetId: preset.id, model, effort });
    if (preset.kind) {
      const taken = (this.snapshot?.agents ?? []).map((agent) => agent.name ?? '').filter(Boolean);
      await this.startWithRetry({
        name: agentName(preset.id, taken),
        kind: preset.kind,
        pane_id: paneId,
        args: buildStartArgs(preset, model, effort),
        timeout_ms: 60000,
      });
    } else {
      await this.waitForShell(paneId);
      if (preset.id === 'deepseek') {
        await this.syncDshPrefs(model, effort);
      }
      await this.sendShellLine(paneId, buildShellCommand(preset, model, effort));
      await this.waitForCustomAgent(paneId, preset.id);
    }
    await this.refresh();
    return paneId;
  }

  private async paneForNewAgent(tabId: string): Promise<string> {
    const panes = (this.snapshot?.panes ?? []).filter((pane) => pane.tab_id === tabId);
    const idle = panes.find((pane) => !pane.agent && !this.paneMemory()[pane.pane_id]);
    if (idle) return idle.pane_id;
    return this.splitPane(tabId);
  }

  private async splitPane(tabId: string): Promise<string> {
    const panes = (this.snapshot?.panes ?? []).filter((pane) => pane.tab_id === tabId);
    const target = panes[panes.length - 1];
    const result = await this.client.request<any>('pane.split', {
      target_pane_id: target?.pane_id ?? null,
      direction: panes.length % 2 === 1 ? 'right' : 'down',
      cwd: this.selectedWorktreePath(),
      focus: false,
    });
    return result.pane.pane_id;
  }

  /** 新 pane 的 shell 需要一點時間才會出現提示字元，所以 agent.start 失敗時重試。 */
  private async startWithRetry(params: Record<string, unknown>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.client.request('agent.start', params, 70000);
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof HerdrError)) throw error;
        // agent 已啟動，但停在確認畫面（例如信任資料夾）。名稱仍可使用，交給使用者處理。
        if (error.code === 'agent_not_ready') return;
        if (error.code !== 'agent_pane_busy') throw error;
        await sleep(500);
      }
    }
    throw lastError;
  }

  private async waitForShell(paneId: string): Promise<void> {
    await this.client
      .request('pane.wait_for_output', {
          pane_id: paneId,
          source: 'visible',
          match: { type: 'regex', value: '[$%#>❯]\\s*$' },
          timeout_ms: 5000,
        }, 7000)
      .catch(() => sleep(800));
  }

  /** 送出一行文字並按 Enter。部分 herdr 版本不接受同時帶 text 與 keys 的 pane.send_input，因此拆開或自動退回。 */
  private async sendShellLine(paneId: string, text: string): Promise<void> {
    try {
      await this.client.request('pane.send_text', { pane_id: paneId, text });
      await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
    } catch {
      await this.client.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
    }
  }

  /** 自訂指令啟動前，將選擇的模型與 effort 寫入 ~/.dsh-tui 偏好檔，讓 dsh-tui 啟動時直接套用。 */
  private async syncDshPrefs(model?: string, effort?: string): Promise<void> {
    if (!model && !effort) return;
    const dir = path.join(os.homedir(), '.dsh-tui');
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
    if (model) {
      const slash = model.indexOf('/');
      const provider = slash >= 0 ? model.slice(0, slash) : 'deepseek-official';
      const id = slash >= 0 ? model.slice(slash + 1) : model;
      await fs.writeFile(path.join(dir, 'model.json'), JSON.stringify({ provider, model: id }, null, 2)).catch(() => undefined);
    }
    if (effort) {
      await fs.writeFile(path.join(dir, 'effort.json'), JSON.stringify({ effort }, null, 2)).catch(() => undefined);
    }
  }

  /** 等待自訂指令啟動的 agent（例如 dsh-tui 透過 report-agent 回報狀態），並為其設定唯一 agent 名稱。 */
  private async waitForCustomAgent(paneId: string, presetId: string): Promise<void> {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const snap = await this.client.snapshot().catch(() => null);
      if (snap) {
        this.snapshot = snap;
        const pane = snap.panes.find((p) => p.pane_id === paneId);
        const agent = snap.agents.find((a) => a.pane_id === paneId);
        const found = pane?.agent ?? agent?.agent;
        if (found) {
          const hasName = pane?.name ?? agent?.name;
          if (!hasName) {
            const taken = snap.agents.map((a) => a.name ?? '').filter(Boolean);
            await this.client
              .request('agent.rename', { target: paneId, name: agentName(presetId, taken) })
              .catch(() => undefined);
          }
          return;
        }
      }
      await sleep(300);
    }
  }

  /**
   * 送出訊息。模型或 effort 與上次不同時，先送 agent 自己的切換指令。
   * 這與 Claude 及 Codex 的 VS Code 擴充功能相同：選單的設定在下一則訊息生效。
   */
  async send(
    paneId: string,
    text: string,
    options: { model?: string; effort?: string; attachments?: string[]; mode?: 'queue' | 'now' } = {},
  ): Promise<void> {
    const pane = this.pane(paneId);
    if (!pane) throw new Error(t("This pane is closed."));
    this.assertPlannerWritable(paneId);
    // Pending/edited/cancelled messages remain queue state; only delivered text becomes a user request.
    const task = await this.openTask(pane.tab_id).catch(() => undefined);
    this.assertPlannerWritable(paneId);
    const message: QueuedMessage = {
      id: this.nextQueueId++,
      text,
      attachments: options.attachments ?? [],
      model: options.model,
      effort: options.effort,
    };
    const busy = pane.agent_status === 'working' || pane.agent_status === 'blocked';
    // agent 停在提問畫面（例如選了「Type something.」）時，把文字直接打進畫面上的輸入欄。
    if (options.mode === 'now' && parseDialog(await this.readScreen(paneId).catch(() => '')).length) {
      this.assertPlannerWritable(paneId);
      await this.client.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
      await this.recordDeliveredMessage(task?.id, paneId, text);
      await this.sendShellLine(paneId, text);
      this.scheduleRefresh(300);
      return;
    }
    const queue = this.queues.get(paneId) ?? [];
    if (options.mode !== 'now' && (busy || queue.length || this.delivering.has(paneId))) {
      queue.push(message);
      this.queues.set(paneId, queue);
      this.refreshQueueCheckpoint(paneId);
      await this.pushTranscript();
      return;
    }
    if (options.mode === 'now' && busy && (message.model || message.effort)) {
      throw new Error(t("The model or effort cannot be changed while the agent is working. Wait for it to finish, or queue the message."));
    }
    await this.deliver(paneId, message);
  }

  /** 修改尚未送出的訊息，保留原本的順序、附件與模型設定。 */
  async updateQueued(paneId: string, id: number, text: string): Promise<void> {
    const item = this.queues.get(paneId)?.find((entry) => entry.id === id);
    if (!item) throw new Error(t("This message has already been sent or removed and cannot be edited."));
    const next = text.trim();
    if (!next && !item.attachments.length) throw new Error(t("Enter a message or keep at least one attachment."));
    item.text = next;
    this.refreshQueueCheckpoint(paneId);
    await this.pushTranscript();
  }

  removeQueued(paneId: string, id: number): void {
    const queue = this.queues.get(paneId) ?? [];
    this.queues.set(paneId, queue.filter((item) => item.id !== id));
    this.refreshQueueCheckpoint(paneId);
    void this.pushTranscript();
  }

  /** 把佇列中的訊息立刻送出（插入正在進行的回合）。 */
  async insertQueued(paneId: string, id: number): Promise<void> {
    this.assertPlannerWritable(paneId);
    const queue = this.queues.get(paneId) ?? [];
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    this.queues.set(paneId, queue.filter((entry) => entry.id !== id));
    try {
      await this.deliver(paneId, { ...item, model: undefined, effort: undefined });
    } catch (error) {
      // Only a locally rejected, definitely unsent message is restored; a transport timeout must not replay it.
      if ((error as { code?: string }).code === 'planner_read_only') {
        const remaining = this.queues.get(paneId) ?? [];
        this.queues.set(paneId, [...remaining, item].sort((a, b) => a.id - b.id));
      }
      throw error;
    }
  }

  /** agent 回到空閒時送出佇列的第一則。 */
  private drainQueues(): void {
    for (const [paneId, queue] of this.queues) {
      if (!queue.length || this.delivering.has(paneId)) continue;
      const pane = this.pane(paneId);
      if (!pane) {
        this.queues.delete(paneId);
        continue;
      }
      if (this.plannerReadOnly(paneId)) continue;
      if (pane.agent && pane.agent_status !== 'idle' && pane.agent_status !== 'done') continue;
      const item = queue.shift()!;
      void this.deliver(paneId, item).catch((error) => {
        if ((error as { code?: string }).code === 'planner_read_only') (this.queues.get(paneId) ?? queue).unshift(item);
        this.post({ type: 'error', text: describe(error) });
      });
    }
  }

  /** 把附加檔案轉成 agent 認得的引用：專案內用相對路徑，前面加 @。 */
  private withAttachments(text: string, attachments: string[], root = this.selectedWorktreePath()): string {
    if (!attachments.length) return text;
    const refs = attachments.map((file) => {
      const relative = path.relative(root, file);
      const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
      return /\s/.test(shown) ? `@"${shown}"` : `@${shown}`;
    });
    return `${text}\n\n${refs.join(' ')}`.trim();
  }

  private async deliver(paneId: string, item: QueuedMessage): Promise<void> {
    this.assertPlannerWritable(paneId);
    const pane = this.pane(paneId);
    const root = pane && this.collaboration?.getTaskForTab(pane.tab_id)?.checkoutPath;
    this.delivering.add(paneId);
    try {
      await this.deliverNow(paneId, this.withAttachments(item.text, item.attachments, root ?? pane?.foreground_cwd ?? pane?.cwd), item.model, item.effort);
    } finally {
      this.delivering.delete(paneId);
      this.scheduleRefresh(300);
    }
  }

  private async deliverNow(paneId: string, text: string, model?: string, effort?: string): Promise<void> {
    this.assertPlannerWritable(paneId);
    const pane = this.pane(paneId);
    if (!pane) throw new Error(t("This pane is closed."));
    const task = this.collaboration?.getTaskForTab(pane.tab_id);
    const memory = this.paneMemory()[paneId];
    const preset =
      this.presets().find((item) => item.id === memory?.presetId) ?? presetForKind(this.presets(), pane.agent);
    const next: PaneMemory = { presetId: preset?.id ?? memory?.presetId ?? '', model: memory?.model, effort: memory?.effort };

    if (!pane.agent) {
      // herdr 沒有辨識出 agent（例如自訂指令），直接把文字送進終端機。
      await this.client.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
      await this.recordDeliveredMessage(task?.id, paneId, text);
      await this.sendShellLine(paneId, text);
      return;
    }
    if (preset?.switchStyle === 'codex-menu' && (model || effort)) {
      const current = await this.transcripts.read(pane).catch(() => null);
      const nextModel = model ?? current?.model ?? memory?.model;
      const nextEffort = effort ?? current?.effort ?? memory?.effort;
      if (!nextModel || !nextEffort) throw new Error(t("The current Codex model or effort could not be determined. Select both before sending."));
      await this.codexSwitch(paneId, nextModel, nextEffort);
      next.model = nextModel;
      next.effort = nextEffort;
      model = effort = undefined;
    }
    if (preset && model && model !== memory?.model) {
      const command = switchCommand(preset.switchModel, 'model', model);
      if (command) {
        await this.prompt(paneId, command);
        next.model = model;
      }
    }
    if (preset && effort && effort !== memory?.effort) {
      const command = switchCommand(preset.switchEffort, 'effort', effort);
      if (command) {
        await this.prompt(paneId, command);
        next.effort = effort;
      }
    }
    if (next.presetId) await this.rememberPane(paneId, next);
    this.assertPlannerWritable(paneId);
    await this.sendAgentPrompt(paneId, text);
    await this.recordDeliveredMessage(task?.id, paneId, text);
    this.scheduleRefresh(300);
  }

  /** 送出文字給已辨識的 agent；若該 agent 尚未命名（例如自訂指令透過 report-agent 回報），先自動命名，失敗則退回直接寫入 pane。 */
  private async sendAgentPrompt(paneId: string, text: string): Promise<void> {
    const pane = this.pane(paneId);
    if (pane?.agent && !pane.name) {
      const taken = (this.snapshot?.agents ?? []).map((a) => a.name ?? '').filter(Boolean);
      const base = this.paneMemory()[paneId]?.presetId || pane.agent;
      await this.client
        .request('agent.rename', { target: paneId, name: agentName(base, taken) })
        .catch(() => undefined);
    }
    try {
      await this.client.request('agent.prompt', { target: paneId, text });
    } catch (error) {
      if (error instanceof HerdrError || /not an active named agent/i.test(describe(error))) {
        await this.sendShellLine(paneId, text);
        return;
      }
      throw error;
    }
  }

  /** 送出斜線指令並等待 agent 回到可輸入狀態。 */
  private async prompt(paneId: string, text: string): Promise<void> {
    this.assertPlannerWritable(paneId);
    await this.sendAgentPrompt(paneId, text);
    await this.client
      .request('agent.wait', { target: paneId, until: ['idle', 'done', 'blocked'], timeout_ms: 8000 }, 10000)
      .catch(() => undefined);
    await sleep(300);
  }

  async showScreen(paneId: string, show: boolean): Promise<void> {
    if (show) this.screenPanes.add(paneId);
    else this.screenPanes.delete(paneId);
    await this.pushTranscript();
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    const pane = this.pane(paneId);
    if (pane?.agent && pane.name) await this.client.request('agent.send_keys', { target: paneId, keys });
    else await this.client.request('pane.send_keys', { pane_id: paneId, keys });
    await sleep(250);
    await this.pushTranscript();
  }

  private async readScreen(paneId: string): Promise<string> {
    const result = await this.client.request<any>('pane.read', { pane_id: paneId, source: 'visible', strip_ansi: true });
    return String(result?.read?.text ?? '').replace(/\s+$/, '');
  }

  /** 等待畫面切換到指定的選單。 */
  private async waitForMenu(paneId: string, kinds: MenuKind[], timeoutMs = 4000): Promise<{ kind: MenuKind; screen: string }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.readScreen(paneId);
      const kind = menuKind(screen);
      if (kinds.includes(kind) || Date.now() > end) return { kind, screen };
      await sleep(150);
    }
  }

  /** 用方向鍵把反白移到目標選項。只用方向鍵，因為數字鍵會直接選擇並寫入全域預設值。 */
  private async highlight(paneId: string, kind: MenuKind, target: string): Promise<boolean> {
    for (let step = 0; step < 30; step++) {
      const { kind: now, screen } = await this.waitForMenu(paneId, [kind], 1500);
      if (now !== kind) return false;
      const key = nextKey(parseMenu(screen), target);
      if (key === 'found') return true;
      if (key === null) return false;
      await this.client.request('pane.send_keys', { pane_id: paneId, keys: [key] });
      await sleep(80);
    }
    return false;
  }

  /**
   * 在 Codex 的 /model 選單中選擇模型與 effort。最後按 s，只套用到目前 session。
   * 找不到選項時按 Esc 離開選單並回報錯誤。
   */
  private async codexSwitch(paneId: string, model: string, effort: string): Promise<void> {
    const fail = async (reason: string): Promise<never> => {
      for (let i = 0; i < 3; i++) {
        if (menuKind(await this.readScreen(paneId)) === 'none') break;
        await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['esc'] });
        await sleep(200);
      }
      throw new Error(t("Could not change Codex settings: {0}", reason));
    };
    await this.client.request('agent.prompt', { target: paneId, text: '/model' });
    const opened = await this.waitForMenu(paneId, ['model']);
    if (opened.kind !== 'model') return fail(t("The model menu did not appear."));
    if (!(await this.highlight(paneId, 'model', normalizeLabel(model)))) return fail(t("Model {0} was not found in the menu.", model));
    await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
    if ((await this.waitForMenu(paneId, ['effort'])).kind !== 'effort') return fail(t("The effort menu did not appear."));
    const label = effortLabel(effort);
    let menu: MenuKind = 'effort';
    if (!parseMenu(await this.readScreen(paneId)).some((option) => option.name === label)) {
      // Max 與 Ultra 在「More reasoning…」子選單內。
      if (!(await this.highlight(paneId, 'effort', 'more-reasoning'))) return fail(t("Effort {0} was not found in the menu.", effort));
      await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
      if ((await this.waitForMenu(paneId, ['advanced'])).kind !== 'advanced') return fail(t("The advanced effort menu did not appear."));
      menu = 'advanced';
    }
    if (!(await this.highlight(paneId, menu, label))) return fail(t("Effort {0} was not found in the menu.", effort));
    await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['s'] });
    const closed = await this.waitForMenu(paneId, ['none'], 3000);
    if (closed.kind !== 'none') return fail(t("The menu did not close."));
  }

  // ---------- tab 與 pane 管理 ----------

  async renameTab(tabId: string): Promise<void> {
    const tab = this.snapshot?.tabs.find((item) => item.tab_id === tabId);
    const label = await vscode.window.showInputBox({ title: t("Rename conversation (tab)"), value: tab?.label ?? '', prompt: t("Enter a new name") });
    if (label === undefined || !label.trim()) return;
    await this.client.request('tab.rename', { tab_id: tabId, label: label.trim() });
    await this.refresh();
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.snapshot?.tabs.find((item) => item.tab_id === tabId);
    const agents = (this.snapshot?.panes ?? []).filter((pane) => pane.tab_id === tabId && pane.agent).length;
    const detail = agents ? t("Closing this tab will also stop its agents ({0}).", agents) : t("The terminals in this tab will also close.");
    const choice = await vscode.window.showWarningMessage(t("Close conversation \"{0}\"?", tab?.label ?? tabId), { modal: true, detail }, t("Close"));
    if (choice !== t("Close")) return;
    await this.client.request('tab.close', { tab_id: tabId });
    await this.collaborationReady;
    if (!this.collaborationError) await this.collaboration.archiveTask(tabId);
    await this.refresh();
  }

  async renamePane(paneId: string): Promise<void> {
    const pane = this.pane(paneId);
    const label = await vscode.window.showInputBox({
      title: t("Rename pane"),
      value: pane?.label ?? pane?.name ?? '',
      prompt: t("Enter a new name. Leave it empty to clear the name."),
    });
    if (label === undefined) return;
    await this.client.request('pane.rename', { pane_id: paneId, label: label.trim() || null });
    await this.refresh();
  }

  async closePane(paneId: string): Promise<void> {
    const pane = this.pane(paneId);
    const name = pane?.label || pane?.name || pane?.agent || paneId;
    const detail = pane?.agent ? t("The agent in this pane will stop.") : t("This terminal will close.");
    const choice = await vscode.window.showWarningMessage(t("Close \"{0}\"?", name), { modal: true, detail }, t("Close"));
    if (choice !== t("Close")) return;
    await this.client.request('pane.close', { pane_id: paneId });
    this.queues.delete(paneId);
    await this.refresh();
  }

  /** 在確認畫面選擇第 number 個選項：用方向鍵移動再按 Enter。 */
  async chooseOption(paneId: string, number: number): Promise<void> {
    for (let step = 0; step < 20; step++) {
      const options = parseDialog(await this.readScreen(paneId));
      const current = options.find((option) => option.highlighted);
      if (!current) throw new Error(t("The confirmation screen has already closed."));
      if (current.number === number) break;
      await this.client.request('pane.send_keys', { pane_id: paneId, keys: [number > current.number ? 'down' : 'up'] });
      await sleep(80);
    }
    await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
    await sleep(300);
    await this.refresh();
  }

  // ---------- @ 與 / 補全 ----------

  async complete(paneId: string, trigger: '/' | '@', query: string): Promise<CompletionItem[]> {
    if (trigger === '@') return this.completeFiles(query);
    const pane = this.pane(paneId);
    const preset = this.presetOf(paneId);
    return this.commands.list(pane?.agent ?? preset?.kind ?? null, this.selectedWorktreePath(), preset?.slashCommands ?? [], query);
  }

  private async completeFiles(query: string): Promise<CompletionItem[]> {
    const root = this.selectedWorktreePath();
    const cleaned = query.replace(/[\[\]{}*?!]/g, '');
    const glob = cleaned ? `**/*${cleaned}*` : '**/*';
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/vendor/**}';
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), glob), exclude, 200);
    const lower = cleaned.toLowerCase();
    return uris
      .map((uri) => path.relative(root, uri.fsPath))
      .sort((a, b) => score(a, lower) - score(b, lower) || a.length - b.length)
      .slice(0, 40)
      .map((relative) => ({
        label: path.basename(relative),
        description: path.dirname(relative) === '.' ? '' : path.dirname(relative),
        insert: /\s/.test(relative) ? `@"${relative}" ` : `@${relative} `,
        kind: 'file' as const,
      }));
  }

  /** 從執行中的 agent 讀取完整的 / 指令清單（會在 pane 中打開選單再關閉）。 */
  async refreshCommands(paneId: string): Promise<number> {
    const pane = this.pane(paneId);
    if (!pane?.agent) throw new Error(t("There is no agent in this pane."));
    if (pane.agent_status !== 'idle' && pane.agent_status !== 'done') throw new Error(t("Wait until the agent is idle before refreshing its command list."));
    return this.commands.harvest(pane.agent, {
      type: (text) => this.client.request('pane.send_text', { pane_id: paneId, text }),
      keys: (keys) => this.client.request('pane.send_keys', { pane_id: paneId, keys }),
      read: () => this.readScreen(paneId),
    });
  }

  // ---------- 附加檔案 ----------

  async pickFiles(): Promise<string[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      defaultUri: vscode.Uri.file(this.selectedWorktreePath()),
      openLabel: t("Attach"),
    });
    return (uris ?? []).map((uri) => uri.fsPath);
  }

  /** 拖曳進來的檔案沒有路徑（例如從 Finder 或剪貼簿），先存到暫存資料夾。 */
  async saveDroppedFiles(files: { name: string; base64: string }[]): Promise<string[]> {
    const dir = path.join(os.tmpdir(), 'herdr-vscode', String(Date.now()));
    await fs.mkdir(dir, { recursive: true });
    const saved: string[] = [];
    for (const file of files) {
      const name = path.basename(file.name || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_') || 'file';
      const target = path.join(dir, name);
      await fs.writeFile(target, Buffer.from(file.base64, 'base64'));
      saved.push(target);
    }
    return saved;
  }

  private presetOf(paneId: string): AgentPreset | undefined {
    const memory = this.paneMemory()[paneId];
    return this.presets().find((item) => item.id === memory?.presetId) ?? presetForKind(this.presets(), this.pane(paneId)?.agent);
  }

  async interrupt(paneId: string): Promise<void> {
    const pane = this.pane(paneId);
    if (pane?.agent && pane.name) await this.client.request('agent.send_keys', { target: paneId, keys: ['esc'] });
    else await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] });
  }

  currentState(): ProjectState | null {
    return this.state;
  }

  private requireWorkspace(): ProjectState & { workspaceId: string } {
    if (!this.state?.workspaceId) throw new Error(t("This project does not have a Herdr workspace yet. Create one first."));
    return this.state as ProjectState & { workspaceId: string };
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('herdr');
}

async function findGitRoot(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  const ordered = preferred ? [preferred, ...folders.filter((folder) => folder !== preferred)] : folders;
  for (const folder of ordered) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      const { stdout } = await run('git', ['-C', folder.uri.fsPath, 'rev-parse', '--show-toplevel']);
      const root = stdout.trim();
      if (root) return root;
    } catch {
      // 不是 git 專案，試下一個資料夾。
    }
  }
  return null;
}

/** 顯示路徑最後兩層，例如 9d81/main。 */
function shortPath(value: string): string {
  return value.split(path.sep).slice(-2).join('/');
}

/** 檔名符合度：檔名開頭相同最好，其次檔名包含，最後路徑包含。 */
function score(relative: string, query: string): number {
  if (!query) return 0;
  const base = path.basename(relative).toLowerCase();
  if (base.startsWith(query)) return 0;
  if (base.includes(query)) return 1;
  return 2;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describe(error: unknown): string {
  if (error instanceof HerdrError && error.code === 'connection') {
    return t("{0}. Make sure Herdr is running (run herdr status in a terminal).", error.message);
  }
  return error instanceof Error ? error.message : String(error);
}
