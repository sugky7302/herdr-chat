import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HerdrClient, HerdrError, HerdrEvents, resolveSocketPath } from './herdr/client';
import type { PaneInfo, Snapshot, WorktreeList } from './herdr/types';
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
import type { AgentView, CompletionItem, ProjectState, QueuedView, TabView, ToWebview, Transcript, WorktreeView } from './shared';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { Commands } from './commands';
import { TranscriptSource } from './transcript/source';
import { effortLabel, menuKind, nextKey, normalizeLabel, parseDialog, parseMenu, type MenuKind } from './codexMenu';

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

  constructor(
    private readonly memento: vscode.Memento,
    private readonly post: (message: ToWebview) => void,
    globalMemento?: vscode.Memento,
  ) {
    this.client = new HerdrClient(resolveSocketPath(config().get<string>('socketPath')));
    this.transcripts = new TranscriptSource(this.client, () => config().get<number>('transcriptLines') ?? 400);
    this.events = new HerdrEvents(this.client);
    this.commands = new Commands(globalMemento ?? memento);
    this.events.on('change', () => this.scheduleRefresh(150));
    this.events.on('connected', () => this.scheduleRefresh(0));
    this.events.on('disconnected', () => this.scheduleRefresh(0));
    this.events.on('subscribeFailed', () => this.scheduleRefresh(500));
    this.events.start();
    // 事件可能漏接（例如終端機標題改變），所以另外每 5 秒檢查一次。
    this.pollTimer = setInterval(() => this.scheduleRefresh(0), 5000);
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

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearInterval(this.pollTimer);
    this.events.dispose();
    this.disposables.forEach((item) => item.dispose());
  }

  /** 選項清單。專案設定 herdr.agentDefaults 會覆蓋選項的預設模型與 effort。 */
  presets(): AgentPreset[] {
    const defaults = this.projectConfig().get<Record<string, { model?: string; effort?: string }>>('agentDefaults') ?? {};
    return normalizePresets(config().get('agentPresets')).map((preset) => {
      const local = defaults[preset.id];
      if (!local) return preset;
      return { ...preset, defaultModel: local.model || preset.defaultModel, defaultEffort: local.effort || preset.defaultEffort };
    });
  }

  /** 讀取目前專案資料夾範圍的設定，讓 .vscode/settings.json 生效。 */
  private projectConfig(): vscode.WorkspaceConfiguration {
    const folder = this.gitRoot ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.gitRoot)) : undefined;
    return vscode.workspace.getConfiguration('herdr', folder?.uri);
  }

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
        this.publish({ ...base, error: '目前的 VS Code 視窗沒有開啟 git 專案。' });
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
          branch: tree.branch ?? (tree.is_detached ? `（detached）${shortPath(tree.path)}` : path.basename(tree.path)),
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
            const kind = agent.agent ?? null;
            const presetId = memory[pane.pane_id]?.presetId ?? presetForKind(presets, kind)?.id ?? null;
            return {
              paneId: pane.pane_id,
              label: pane.label || null,
              name: agent.name ?? null,
              kind: agent.display_agent ?? kind,
              presetId,
              status: kind ? (agent.agent_status ?? 'unknown') : 'shell',
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
        transcript: { paneId, source: 'terminal', messages: [{ role: 'notice', text: '這個 pane 已經關閉。' }] },
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
      const dialog = screen && pane.agent ? parseDialog(screen) : [];
      if (dialog.length) transcript.dialog = dialog;
      if (this.screenPanes.has(paneId) || dialog.length || pane.agent_status === 'blocked') transcript.screen = screen;
    }
    transcript.queue = (this.queues.get(paneId) ?? []).map(({ id, text, attachments }) => ({ id, text, attachments }));
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
    if (!this.gitRoot) throw new Error('目前沒有 git 專案。');
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
    if (!this.gitRoot) throw new Error('目前沒有 git 專案。');
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
    await this.createTab('新對話');
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
      const paneId = tabId ? await this.splitPane(tabId) : await this.createTab('終端機');
      await this.refresh();
      return paneId;
    }
    const preset = this.presets().find((item) => item.id === presetId);
    if (!preset) throw new Error(`找不到選項 ${presetId}。`);
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
      await this.client.request('pane.send_input', {
        pane_id: paneId,
        text: buildShellCommand(preset, model, effort),
        keys: ['enter'],
      });
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
    if (!pane) throw new Error('這個 pane 已經關閉。');
    const message: QueuedMessage = {
      id: this.nextQueueId++,
      text,
      attachments: options.attachments ?? [],
      model: options.model,
      effort: options.effort,
    };
    const busy = pane.agent_status === 'working' || pane.agent_status === 'blocked';
    const queue = this.queues.get(paneId) ?? [];
    if (options.mode !== 'now' && (busy || queue.length || this.delivering.has(paneId))) {
      queue.push(message);
      this.queues.set(paneId, queue);
      await this.pushTranscript();
      return;
    }
    if (options.mode === 'now' && busy && (message.model || message.effort)) {
      throw new Error('agent 工作中無法切換模型或 effort。請等它完成，或改用佇列送出。');
    }
    await this.deliver(paneId, message);
  }

  removeQueued(paneId: string, id: number): void {
    const queue = this.queues.get(paneId) ?? [];
    this.queues.set(paneId, queue.filter((item) => item.id !== id));
    void this.pushTranscript();
  }

  /** 把佇列中的訊息立刻送出（插入正在進行的回合）。 */
  async insertQueued(paneId: string, id: number): Promise<void> {
    const queue = this.queues.get(paneId) ?? [];
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    this.queues.set(paneId, queue.filter((entry) => entry.id !== id));
    await this.deliver(paneId, { ...item, model: undefined, effort: undefined });
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
      if (pane.agent && pane.agent_status !== 'idle' && pane.agent_status !== 'done') continue;
      const item = queue.shift()!;
      void this.deliver(paneId, item).catch((error) => this.post({ type: 'error', text: describe(error) }));
    }
  }

  /** 把附加檔案轉成 agent 認得的引用：專案內用相對路徑，前面加 @。 */
  private withAttachments(text: string, attachments: string[]): string {
    if (!attachments.length) return text;
    const root = this.selectedWorktreePath();
    const refs = attachments.map((file) => {
      const relative = path.relative(root, file);
      const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
      return /\s/.test(shown) ? `@"${shown}"` : `@${shown}`;
    });
    return `${text}\n\n${refs.join(' ')}`.trim();
  }

  private async deliver(paneId: string, item: QueuedMessage): Promise<void> {
    this.delivering.add(paneId);
    try {
      await this.deliverNow(paneId, this.withAttachments(item.text, item.attachments), item.model, item.effort);
    } finally {
      this.delivering.delete(paneId);
      this.scheduleRefresh(300);
    }
  }

  private async deliverNow(paneId: string, text: string, model?: string, effort?: string): Promise<void> {
    const pane = this.pane(paneId);
    if (!pane) throw new Error('這個 pane 已經關閉。');
    const memory = this.paneMemory()[paneId];
    const preset =
      this.presets().find((item) => item.id === memory?.presetId) ?? presetForKind(this.presets(), pane.agent);
    const next: PaneMemory = { presetId: preset?.id ?? memory?.presetId ?? '', model: memory?.model, effort: memory?.effort };

    if (!pane.agent) {
      // herdr 沒有辨識出 agent（例如自訂指令），直接把文字送進終端機。
      await this.client.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
      return;
    }
    if (preset?.switchStyle === 'codex-menu' && (model || effort)) {
      const current = await this.transcripts.read(pane).catch(() => null);
      const nextModel = model ?? current?.model ?? memory?.model;
      const nextEffort = effort ?? current?.effort ?? memory?.effort;
      if (!nextModel || !nextEffort) throw new Error('無法得知 Codex 目前的模型或 effort，請兩個都選擇後再送出。');
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
    await this.client.request('agent.prompt', { target: paneId, text });
    this.scheduleRefresh(300);
  }

  /** 送出斜線指令並等待 agent 回到可輸入狀態。 */
  private async prompt(paneId: string, text: string): Promise<void> {
    await this.client.request('agent.prompt', { target: paneId, text });
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
    if (pane?.agent) await this.client.request('agent.send_keys', { target: paneId, keys });
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
      throw new Error(`無法切換 Codex 設定：${reason}`);
    };
    await this.client.request('agent.prompt', { target: paneId, text: '/model' });
    const opened = await this.waitForMenu(paneId, ['model']);
    if (opened.kind !== 'model') return fail('沒有出現模型選單。');
    if (!(await this.highlight(paneId, 'model', normalizeLabel(model)))) return fail(`選單中找不到模型 ${model}。`);
    await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
    if ((await this.waitForMenu(paneId, ['effort'])).kind !== 'effort') return fail('沒有出現 effort 選單。');
    const label = effortLabel(effort);
    let menu: MenuKind = 'effort';
    if (!parseMenu(await this.readScreen(paneId)).some((option) => option.name === label)) {
      // Max 與 Ultra 在「More reasoning…」子選單內。
      if (!(await this.highlight(paneId, 'effort', 'more-reasoning'))) return fail(`選單中找不到 effort ${effort}。`);
      await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
      if ((await this.waitForMenu(paneId, ['advanced'])).kind !== 'advanced') return fail('沒有出現進階 effort 選單。');
      menu = 'advanced';
    }
    if (!(await this.highlight(paneId, menu, label))) return fail(`選單中找不到 effort ${effort}。`);
    await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['s'] });
    const closed = await this.waitForMenu(paneId, ['none'], 3000);
    if (closed.kind !== 'none') return fail('選單沒有關閉。');
  }

  // ---------- tab 與 pane 管理 ----------

  async renameTab(tabId: string): Promise<void> {
    const tab = this.snapshot?.tabs.find((item) => item.tab_id === tabId);
    const label = await vscode.window.showInputBox({ title: '重新命名對話（tab）', value: tab?.label ?? '', prompt: '輸入新名稱' });
    if (label === undefined || !label.trim()) return;
    await this.client.request('tab.rename', { tab_id: tabId, label: label.trim() });
    await this.refresh();
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.snapshot?.tabs.find((item) => item.tab_id === tabId);
    const agents = (this.snapshot?.panes ?? []).filter((pane) => pane.tab_id === tabId && pane.agent).length;
    const detail = agents ? `其中 ${agents} 個 agent 會一起結束。` : '其中的終端機會一起關閉。';
    const choice = await vscode.window.showWarningMessage(`關閉對話「${tab?.label ?? tabId}」？`, { modal: true, detail }, '關閉');
    if (choice !== '關閉') return;
    await this.client.request('tab.close', { tab_id: tabId });
    await this.refresh();
  }

  async renamePane(paneId: string): Promise<void> {
    const pane = this.pane(paneId);
    const label = await vscode.window.showInputBox({
      title: '重新命名 pane',
      value: pane?.label ?? pane?.name ?? '',
      prompt: '輸入新名稱。留空會清除名稱。',
    });
    if (label === undefined) return;
    await this.client.request('pane.rename', { pane_id: paneId, label: label.trim() || null });
    await this.refresh();
  }

  async closePane(paneId: string): Promise<void> {
    const pane = this.pane(paneId);
    const name = pane?.label || pane?.name || pane?.agent || paneId;
    const detail = pane?.agent ? '這個 pane 中的 agent 會結束。' : '這個終端機會關閉。';
    const choice = await vscode.window.showWarningMessage(`關閉「${name}」？`, { modal: true, detail }, '關閉');
    if (choice !== '關閉') return;
    await this.client.request('pane.close', { pane_id: paneId });
    this.queues.delete(paneId);
    await this.refresh();
  }

  /** 在確認畫面選擇第 number 個選項：用方向鍵移動再按 Enter。 */
  async chooseOption(paneId: string, number: number): Promise<void> {
    for (let step = 0; step < 20; step++) {
      const options = parseDialog(await this.readScreen(paneId));
      const current = options.find((option) => option.highlighted);
      if (!current) throw new Error('確認畫面已經關閉。');
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
    if (!pane?.agent) throw new Error('這個 pane 沒有 agent。');
    if (pane.agent_status !== 'idle' && pane.agent_status !== 'done') throw new Error('請等 agent 空閒後再更新指令清單。');
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
      openLabel: '附加',
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
    if (pane?.agent) await this.client.request('agent.send_keys', { target: paneId, keys: ['esc'] });
    else await this.client.request('pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] });
  }

  currentState(): ProjectState | null {
    return this.state;
  }

  private requireWorkspace(): ProjectState & { workspaceId: string } {
    if (!this.state?.workspaceId) throw new Error('這個專案在 herdr 還沒有 workspace。請先建立 workspace。');
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
    return `${error.message}。請確認 herdr 正在執行（終端機執行 herdr status）。`;
  }
  return error instanceof Error ? error.message : String(error);
}
