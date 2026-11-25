import type { AgentView, ChatMessage, FromWebview, ProjectState, TabView, ToWebview } from '../src/shared';
import type { AgentIdentity, CollaborationRequest, CollaborationTask, RequestStatus } from '../src/collaboration/types';
import type { ChatHost, ChatView } from './chat';

export type TaskPage = 'chat' | 'collaboration' | 'memory';
type Target = { paneId: string } | { presetId: string };
type Operation = Extract<ToWebview, { type: 'taskOperation' }>;

export interface MemoryDraft {
  title: string;
  text: string;
  source: { paneId: string; messageIndex: number; role: ChatMessage['role']; text: string };
  operationId?: string;
  error?: string;
}

export interface TaskUiState {
  pages: Record<string, TaskPage>;
  selectedPanes: Record<string, string>;
  memoryDrafts: Record<string, MemoryDraft>;
}

export interface TaskHost {
  h: ChatHost['h'];
  icon(name: string): HTMLElement;
  send(message: FromWebview): void;
  persist(): void;
  state(): ProjectState | null;
  chat: ChatView;
  title(tab: TabView): string;
  paneToolbar(paneId: string): HTMLElement;
  openAgent(paneId: string): void;
  history(): void;
  newAgent(tabId: string): void;
}

interface HandoffDraft {
  open: boolean;
  target: string;
  checkpoint?: string;
  preparing?: string;
  submitting?: string;
  submitted?: boolean;
  error?: string;
  previousHandoffId?: string;
}

interface DispatchDraft {
  target: string;
  text: string;
  open?: boolean;
  submitting?: string;
  error?: string;
}

const REQUEST_LABELS: Record<RequestStatus, string> = {
  sending: '正在派送',
  running: '執行中',
  awaiting_report: '等待明確回報',
  needs_input: '等待規劃者回應',
  completed: '已回報完成',
  failed: '派送失敗',
  wait_expired: '等待逾時 · 結果未知',
};

function requestLabel(request: CollaborationRequest): string {
  if (request.status === 'failed') return request.report?.status === 'failed' ? '已回報失敗' : '派送失敗';
  if (request.status === 'needs_input' && request.report?.status !== 'needs_input') return '等待原生權限或選單';
  return REQUEST_LABELS[request.status];
}

function identityName(agent: AgentIdentity): string {
  return agent.name || agent.harness || agent.paneId;
}

function paneName(agent: AgentView): string {
  return agent.label || agent.name || agent.kind || '終端機';
}

function timeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

/** One tab is one task. Pane selection only changes the conversation page. */
export class TaskView {
  private tasks: CollaborationTask[] = [];
  private tab: TabView | null = null;
  private root: HTMLElement | null = null;
  private heading: HTMLElement | null = null;
  private navigation: HTMLElement | null = null;
  private handoffSlot: HTMLElement | null = null;
  private memorySlot: HTMLElement | null = null;
  private feedback: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private contentKey = '';
  private handoffKey = '';
  private memoryKey = '';
  private dispatchKey = '';
  private recordsKey = '';
  private nextOperation = 0;
  private readonly handoffs: Record<string, HandoffDraft> = {};
  private readonly dispatches: Record<string, DispatchDraft> = {};
  private readonly feedbackByTab: Record<string, { text: string; error?: boolean; kind?: 'planner' }> = {};
  private readonly plannerOperations: Record<string, string> = {};
  private readonly answers: Record<string, { text: string; operationId?: string; error?: string }> = {};

  constructor(private readonly host: TaskHost, readonly ui: TaskUiState) {
    // An extension reload cannot tell whether an in-flight save reached Claude-mem.
    for (const draft of Object.values(ui.memoryDrafts)) {
      if (draft.operationId) {
        delete draft.operationId;
        draft.error = '上次保存的回應尚未確認，草稿已保留；請先核對記憶紀錄再重試。';
      }
    }
  }

  setTasks(tasks: CollaborationTask[]): void {
    this.tasks = tasks;
    for (const task of tasks) {
      if (task.plannerDelivery?.status === 'sent' && this.feedbackByTab[task.tabId]?.kind === 'planner') delete this.feedbackByTab[task.tabId];
    }
  }

  archivedTasks(): CollaborationTask[] {
    const state = this.host.state();
    const checkout = state?.worktrees.find((tree) => tree.current)?.path ?? state?.repoRoot;
    return this.tasks.filter((task) => task.status === 'archived' && (!checkout || task.checkoutPath === checkout));
  }

  archivedTab(tabId: string): TabView | undefined {
    const task = this.archivedTasks().find((item) => item.tabId === tabId);
    return task ? { tabId, label: task.title, number: 0, focused: false, status: 'unknown', agents: [] } : undefined;
  }

  readOnlyReason(paneId: string): string | undefined {
    const task = this.tasks.find((item) => item.participants.some((agent) => agent.paneId === paneId));
    if (!task?.enabled) return undefined;
    if (task.planner.paneId === paneId) return task.status === 'handoff_pending' ? '原規劃已暫停，等待新規劃者接手；草稿保留。' : undefined;
    if (task.handoffs.some((handoff) => handoff.status === 'accepted' && handoff.from.paneId === paneId)) return '原規劃者的對話保留為唯讀歷史，仍可保存成記憶。';
    return undefined;
  }

  private task(): CollaborationTask | undefined {
    return this.tasks.find((task) => task.tabId === this.tab?.tabId);
  }

  private page(): TaskPage {
    return this.tab ? this.ui.pages[this.tab.tabId] ?? 'chat' : 'chat';
  }

  private paneId(): string | undefined {
    return this.tab ? this.ui.selectedPanes[this.tab.tabId] : undefined;
  }

  acceptsTranscript(paneId: string): boolean {
    return Boolean(this.root?.isConnected && this.page() === 'chat' && this.paneId() === paneId);
  }

  private operationId(): string {
    return `task-${Date.now()}-${++this.nextOperation}`;
  }

  mount(tab: TabView, paneId?: string): HTMLElement {
    const { h } = this.host;
    this.heading = h('div', { class: 'task-heading' });
    this.navigation = h('div', { class: 'task-navigation', role: 'tablist', 'aria-label': '問題內容' });
    this.handoffSlot = h('div', { class: 'task-handoff-slot' });
    this.memorySlot = h('div', { class: 'task-memory-slot' });
    this.feedback = h('div', { class: 'task-feedback', role: 'status', 'aria-live': 'polite', hidden: true });
    this.content = h('div', { class: 'task-content', role: 'tabpanel' });
    this.root = h('main', { class: 'task', 'data-tab-id': tab.tabId }, this.heading, this.navigation,
      h('div', { class: 'task-editors' }, this.handoffSlot, this.memorySlot), this.feedback, this.content);
    this.contentKey = this.handoffKey = this.memoryKey = this.dispatchKey = this.recordsKey = '';
    this.refresh(tab, paneId);
    this.host.send({ type: 'openTask', tabId: tab.tabId });
    return this.root;
  }

  refresh(tab: TabView, paneId?: string): void {
    this.tab = tab;
    if (this.task()?.status === 'archived' && this.page() === 'chat') this.ui.pages[tab.tabId] = 'collaboration';
    const selected = paneId ?? this.ui.selectedPanes[tab.tabId];
    this.ui.selectedPanes[tab.tabId] = tab.agents.some((agent) => agent.paneId === selected)
      ? selected! : (tab.agents.find((agent) => agent.focused) ?? tab.agents[0])?.paneId ?? '';
    if (!this.root) return;
    this.renderHeading();
    this.renderNavigation();
    this.renderHandoff();
    this.renderMemoryEditor();
    const feedback = this.feedbackByTab[tab.tabId];
    this.feedback!.hidden = !feedback;
    this.feedback!.classList.toggle('is-error', Boolean(feedback?.error));
    this.feedback!.textContent = feedback?.text ?? '';
    this.renderContent();
  }

  private refreshCurrent(): void {
    if (this.tab) this.refresh(this.tab);
  }

  private setPage(page: TaskPage): void {
    if (!this.tab) return;
    this.ui.pages[this.tab.tabId] = page;
    this.host.persist();
    this.refreshCurrent();
  }

  jumpToPane(paneId: string): void {
    if (!this.tab?.agents.some((agent) => agent.paneId === paneId)) return;
    this.ui.pages[this.tab.tabId] = 'chat';
    this.host.persist();
    this.host.openAgent(paneId);
  }

  private renderHeading(): void {
    const { h } = this.host;
    const tab = this.tab!;
    const task = this.task();
    const pending = task?.status === 'handoff_pending';
    const planner = task?.enabled ? task.planner : undefined;
    const delivery = task?.plannerDelivery;
    const selected = tab.agents.find((agent) => agent.paneId === this.paneId() && agent.kind);
    const plannerText = task?.status === 'archived' ? `已封存 · ${planner ? `最後規劃者：${identityName(planner)}` : '未啟用協作'}` : planner
      ? pending ? `原規劃者：${identityName(planner)} · 交接暫停` : `規劃者：${identityName(planner)}`
      : '尚未啟用協作規劃';
    const toolbar = h('div', { class: 'toolbar task-title' },
      h('button', { class: 'icon-button', title: '歷史紀錄', 'aria-label': '歷史紀錄', onclick: () => this.host.history() }, this.host.icon('back')),
      h('h2', { title: this.host.title(tab) }, this.host.title(tab)),
      h('div', { class: 'spacer' }),
      task?.status !== 'archived' ? h('button', { class: 'icon-button', title: '重新命名問題', 'aria-label': '重新命名問題', onclick: () => this.host.send({ type: 'renameTab', tabId: tab.tabId }) }, this.host.icon('edit')) : null);
    const plannerRow = h('div', { class: 'task-planner' }, h('span', { class: 'task-planner-label' }, plannerText));
    if (planner && delivery && task?.status !== 'archived' && !pending) plannerRow.append(h('span', { class: 'task-planner-delivery', 'data-delivery-status': delivery.status },
      delivery.status === 'sending' ? '協作入口傳送中' : delivery.status === 'sent' ? '協作入口已送出' : '協作入口傳送結果未確認'));
    if (task?.status === 'archived') {
      plannerRow.append(h('span', { class: 'muted' }, '唯讀紀錄'));
    } else if (!planner) {
      plannerRow.append(h('button', {
        class: 'secondary small', disabled: !selected || Boolean(this.plannerOperations[tab.tabId]),
        onclick: () => {
          if (!selected) return;
          const operationId = this.operationId();
          this.plannerOperations[tab.tabId] = operationId;
          this.host.send({ type: 'assignPlanner', tabId: tab.tabId, paneId: selected.paneId, operationId });
          this.refreshCurrent();
        },
      }, this.plannerOperations[tab.tabId] ? '啟用中…' : selected ? `以 ${paneName(selected)} 規劃` : '先新增 agent'));
    } else {
      plannerRow.append(h('button', { class: 'secondary small', disabled: delivery?.status === 'sending' && !pending, onclick: () => this.openHandoff() }, pending ? '查看交接' : '交接規劃者'));
    }
    this.heading!.replaceChildren(toolbar, plannerRow);
    if (pending) {
      const handoff = task.handoffs.at(-1);
      this.heading!.append(h('div', { class: 'task-notice', role: 'status' },
        handoff?.status === 'failed' ? '交接失敗，舊規劃仍暫停。可重新選擇接手者；worker 持續執行，回覆暫存於本問題。'
          : `等待${handoff?.target ? ` ${identityName(handoff.target)} ` : '新規劃者'}接手確認。Worker 持續執行，回覆暫存於本問題。`));
    } else if (delivery?.status === 'uncertain' && task?.status !== 'archived') {
      this.heading!.append(h('div', { class: 'task-notice task-delivery-uncertain', role: 'alert' },
        h('p', {}, '協作入口的傳送結果未確認。請複製入口貼到原規劃者，執行 status 核對目前任務。'),
        delivery.error ? h('p', { class: 'muted' }, delivery.error) : null,
        h('button', { class: 'secondary small', onclick: () => this.host.send({ type: 'copyCollaborationPrompt', tabId: tab.tabId }) }, '複製協作入口')));
    }
  }

  private renderNavigation(): void {
    const { h } = this.host;
    const items: [TaskPage, string][] = [['chat', '對話'], ['collaboration', '協作'], ['memory', '記憶']];
    this.navigation!.replaceChildren(...items.map(([page, title]) => h('button', {
      id: `task-tab-${page}`, class: 'task-tab', type: 'button', role: 'tab',
      'aria-selected': String(this.page() === page), 'aria-controls': 'task-panel', 'data-task-page': page,
      disabled: page === 'chat' && this.task()?.status === 'archived', title: page === 'chat' && this.task()?.status === 'archived' ? '原 pane 已關閉' : undefined,
      onclick: () => this.setPage(page),
    }, title)));
    this.content!.id = 'task-panel';
    this.content!.setAttribute('aria-labelledby', `task-tab-${this.page()}`);
  }

  private renderContent(): void {
    const { h, chat } = this.host;
    const tab = this.tab!;
    const page = this.page();
    const paneId = this.paneId();
    this.root!.classList.toggle('pane', page === 'chat' && Boolean(paneId));
    this.root!.dataset.page = page;
    this.root!.dataset.paneId = page === 'chat' ? paneId ?? '' : '';
    this.content!.classList.toggle('task-chat', page === 'chat');
    if (page === 'chat') {
      const key = `chat:${paneId ?? ''}`;
      if (key !== this.contentKey) {
        this.contentKey = key;
        this.content!.replaceChildren(this.renderAgentSwitcher());
        if (paneId) this.content!.append(this.host.paneToolbar(paneId), ...chat.mount(paneId));
        else this.content!.append(h('p', { class: 'muted pad' }, '在這個問題新增 agent，即可開始對話。'));
        this.host.send({ type: 'openPane', paneId: paneId || null });
      } else {
        this.content!.querySelector('.task-agents')?.replaceWith(this.renderAgentSwitcher());
        if (paneId) this.content!.querySelector('.toolbar')?.replaceWith(this.host.paneToolbar(paneId));
        chat.refresh();
      }
      return;
    }
    if (this.contentKey !== page) {
      this.contentKey = page;
      this.recordsKey = this.dispatchKey = '';
      this.content!.replaceChildren();
      this.host.send({ type: 'openPane', paneId: null });
      if (page === 'collaboration') this.content!.append(h('div', { class: 'task-dispatch' }), h('div', { class: 'task-records' }));
    }
    if (page === 'collaboration') this.renderCollaboration();
    else this.renderMemories();
  }

  private renderAgentSwitcher(): HTMLElement {
    const { h } = this.host;
    const task = this.task();
    const labels: Record<string, string> = { working: '執行中', blocked: '等待操作', idle: '閒置', done: '原生回合結束', unknown: '狀態不明', shell: '終端機' };
    return h('div', { class: 'task-agents', 'aria-label': '切換對話 agent' },
      ...this.tab!.agents.map((agent) => {
        let role = task?.enabled && task.planner.paneId === agent.paneId ? task.status === 'handoff_pending' ? '原規劃者 · 交接暫停' : '規劃者' : '';
        if (!role && task?.handoffs.some((handoff) => handoff.status === 'accepted' && handoff.from.paneId === agent.paneId)) role = '原規劃者';
        const request = task ? [...task.requests].reverse().find((item) => item.target.paneId === agent.paneId) : undefined;
        const status = request ? requestLabel(request) : labels[agent.status] ?? '狀態不明';
        return h('button', {
          class: 'task-agent', 'data-agent-pane': agent.paneId, 'aria-pressed': String(this.paneId() === agent.paneId),
          title: `${paneName(agent)} · ${agent.paneId}`, onclick: () => this.host.openAgent(agent.paneId),
        }, h('span', { class: 'task-agent-name' }, paneName(agent)), h('span', { class: 'task-agent-state' }, [role, status].filter(Boolean).join(' · ')));
      }),
      h('button', { class: 'secondary small task-add-agent', onclick: () => this.host.newAgent(this.tab!.tabId) }, '＋ agent'));
  }

  openMemory(paneId: string, message: ChatMessage, messageIndex: number, selectedText?: string): void {
    const tab = this.tab;
    if (!tab || !tab.agents.some((agent) => agent.paneId === paneId)) return;
    const existing = this.ui.memoryDrafts[tab.tabId];
    if (existing) {
      this.feedbackByTab[tab.tabId] = { text: '已有尚未完成的記憶草稿；先保存或取消，再選擇另一段內容。' };
      this.refreshCurrent();
      return;
    }
    const text = selectedText?.trim() || message.text;
    this.ui.memoryDrafts[tab.tabId] = {
      title: text.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || '問題決策', text,
      source: { paneId, messageIndex, role: message.role, text: message.text },
    };
    delete this.feedbackByTab[tab.tabId];
    this.host.persist();
    this.refreshCurrent();
    this.memorySlot?.querySelector<HTMLInputElement>('input')?.focus();
  }

  private renderMemoryEditor(): void {
    const { h } = this.host;
    const tab = this.tab!;
    const draft = this.task()?.status === 'archived' ? undefined : this.ui.memoryDrafts[tab.tabId];
    const key = draft ? JSON.stringify([tab.tabId, draft.source, draft.operationId, draft.error]) : '';
    if (key === this.memoryKey) return;
    this.memoryKey = key;
    this.memorySlot!.replaceChildren();
    if (!draft) return;
    const bind = (name: 'title' | 'text', input: HTMLInputElement | HTMLTextAreaElement) => {
      input.value = draft[name];
      input.addEventListener('input', () => { draft[name] = input.value; this.host.persist(); });
      return input;
    };
    const title = bind('title', h('input', { id: 'task-memory-title', 'aria-label': '記憶標題', disabled: Boolean(draft.operationId) }));
    const text = bind('text', h('textarea', { id: 'task-memory-text', rows: 5, 'aria-label': '記憶內容', disabled: Boolean(draft.operationId) }));
    const project = this.task()?.checkoutPath ?? this.host.state()?.worktrees.find((item) => item.current)?.path ?? this.host.state()?.repoRoot ?? '';
    const sourceAgent = tab.agents.find((agent) => agent.paneId === draft.source.paneId);
    this.memorySlot!.append(h('section', { class: 'task-memory-editor', 'aria-label': '保存成記憶' },
      h('div', { class: 'task-section-title' }, h('strong', {}, '保存成記憶'), h('button', {
        class: 'link', disabled: Boolean(draft.operationId), onclick: () => { delete this.ui.memoryDrafts[tab.tabId]; this.host.persist(); this.refreshCurrent(); },
      }, '取消')),
      h('label', {}, '標題', title), h('label', {}, '內容', text),
      h('div', { class: 'task-provenance' }, h('span', {}, `專案：${project}`), h('span', {}, `來源：${this.host.title(tab)} · ${sourceAgent ? paneName(sourceAgent) : draft.source.paneId} · 訊息 ${draft.source.messageIndex + 1}`)),
      draft.error ? h('div', { class: 'task-inline-error', role: 'alert' }, draft.error) : null,
      h('button', {
        class: 'task-save-memory', disabled: Boolean(draft.operationId), onclick: () => {
          if (!draft.title.trim() || !draft.text.trim()) { draft.error = '請填寫標題與內容。'; this.refreshCurrent(); return; }
          draft.operationId = this.operationId(); delete draft.error;
          this.host.persist();
          this.host.send({ type: 'saveTaskMemory', tabId: tab.tabId, operationId: draft.operationId, title: draft.title.trim(), text: draft.text.trim(), source: draft.source });
          this.refreshCurrent();
        },
      }, draft.operationId ? '保存中…' : '保存至 Claude-mem')));
  }

  private choices(): { value: string; label: string }[] {
    const plannerId = this.task()?.planner.paneId;
    return [
      ...(this.tab?.agents ?? []).filter((agent) => agent.kind && agent.status === 'idle' && agent.paneId !== plannerId).map((agent) => ({ value: `pane:${agent.paneId}`, label: `現有 ${paneName(agent)} · ${agent.paneId}（閒置）` })),
      ...(this.host.state()?.presets ?? []).filter((preset) => preset.canAutomate === true).map((preset) => ({ value: `preset:${preset.id}`, label: `新建 ${preset.label}` })),
    ];
  }

  private target(value: string): Target | null {
    if (!this.choices().some((item) => item.value === value)) return null;
    return value.startsWith('pane:') ? { paneId: value.slice(5) } : { presetId: value.slice(7) };
  }

  private targetSelect(value: string, onChange: (value: string) => void, label: string, disabled = false): HTMLSelectElement {
    const { h } = this.host;
    const choices = this.choices();
    return h('select', {
      'aria-label': label, disabled, onchange: (event: Event) => onChange((event.target as HTMLSelectElement).value),
    }, h('option', { value: '', selected: !choices.some((item) => item.value === value) }, choices.length ? '選擇 agent…' : '沒有可用的閒置 agent 或可自動協作的 preset'),
    ...choices.map((item) => h('option', { value: item.value, selected: value === item.value }, item.label)));
  }

  private openHandoff(): void {
    const tabId = this.tab!.tabId;
    const task = this.task();
    if (!task) return;
    const latest = task.handoffs.at(-1);
    if (latest?.status === 'accepted' && this.handoffs[tabId] && this.handoffs[tabId].previousHandoffId !== latest.id) delete this.handoffs[tabId];
    const draft = this.handoffs[tabId] ??= { open: true, target: '', previousHandoffId: task.status === 'handoff_pending' ? task.handoffs.at(-2)?.id : latest?.id };
    draft.open = true;
    if (task.status === 'handoff_pending' && latest?.status !== 'failed') draft.checkpoint = latest?.checkpoint || draft.checkpoint;
    else if (!draft.preparing && !draft.submitting && (latest?.status === 'failed' || !draft.checkpoint)) {
      draft.checkpoint = task.checkpoint?.text || draft.checkpoint || latest?.checkpoint;
      draft.preparing = this.operationId(); delete draft.error;
      this.host.send({ type: 'prepareHandoff', tabId, operationId: draft.preparing });
    }
    this.refreshCurrent();
  }

  private renderHandoff(): void {
    const { h } = this.host;
    const tabId = this.tab!.tabId;
    const task = this.task();
    const draft = this.handoffs[tabId];
    const lastHandoff = task?.handoffs.at(-1);
    const latest = lastHandoff?.id === draft?.previousHandoffId ? undefined : lastHandoff;
    const pending = task?.status === 'handoff_pending';
    const key = JSON.stringify([tabId, draft, task?.status, latest, this.choices()]);
    if (key === this.handoffKey) return;
    this.handoffKey = key;
    this.handoffSlot!.replaceChildren();
    if (!draft?.open) return;
    const locked = (pending && latest?.status !== 'failed') || Boolean(draft.submitting) || (draft.submitted && latest?.status !== 'failed');
    const panel = h('section', { class: 'task-handoff', 'aria-label': '交接規劃者' },
      h('div', { class: 'task-section-title' }, h('strong', {}, '交接規劃者'), h('button', { class: 'link', onclick: () => { draft.open = false; this.refreshCurrent(); } }, '收起')),
      !locked && latest?.status !== 'accepted' ? h('label', {}, '接手者', this.targetSelect(draft.target, (value) => { draft.target = value; this.refreshCurrent(); }, '交接接手者')) : null,
      draft.preparing ? h('p', { class: 'muted', role: 'status' }, '正在從現有任務、對話與回報建立交接快照…') : null,
      h('details', { class: 'task-checkpoint', open: true }, h('summary', {}, '交接快照 · 由目前紀錄組成'), h('pre', {}, latest && pending && latest.status !== 'failed' ? latest.checkpoint || draft.checkpoint || '尚未取得快照' : draft.checkpoint || latest?.checkpoint || '尚未取得快照')),
      draft.error ? h('div', { class: 'task-inline-error', role: 'alert' }, draft.error) : null);
    if (latest?.status === 'accepted') panel.append(h('p', { class: 'task-confirmed', role: 'status' }, `${latest.target ? identityName(latest.target) : '新規劃者'} 已回報接手。原 worker request 繼續執行。`));
    else if (locked) panel.append(h('p', { class: 'task-waiting', role: 'status' }, draft.submitting ? '正在送出交接…' : pending ? '舊規劃已暫停，等待接手確認；worker 回覆暫存於本問題。' : '交接已送出，等待 agent 回報接手。'));
    else {
      if (latest?.status === 'failed') panel.append(h('p', { class: 'task-inline-error', role: 'alert' }, latest.error || '上次交接失敗；請核對後重新交接。'));
      panel.append(h('button', {
        class: 'task-submit-handoff', disabled: !draft.checkpoint || Boolean(draft.preparing) || !this.target(draft.target),
        onclick: () => {
          const target = this.target(draft.target); if (!target || !draft.checkpoint) return;
          draft.submitting = this.operationId(); delete draft.error;
          draft.previousHandoffId = task?.handoffs.at(-1)?.id;
          this.host.send({ type: 'requestHandoff', tabId, operationId: draft.submitting, target }); this.refreshCurrent();
        },
      }, '送出交接'));
    }
    this.handoffSlot!.append(panel);
  }

  private paneLink(identity: AgentIdentity): HTMLElement {
    const { h } = this.host;
    const available = this.tab!.agents.some((agent) => agent.paneId === identity.paneId);
    return available ? h('button', { class: 'link task-pane-link', title: identity.paneId, onclick: () => this.jumpToPane(identity.paneId) }, identityName(identity))
      : h('span', { title: `${identity.paneId}（pane 已關閉）` }, identityName(identity));
  }

  private renderCollaboration(): void {
    const { h } = this.host;
    const task = this.task();
    const tabId = this.tab!.tabId;
    const dispatch = this.dispatches[tabId] ??= { text: '', target: '' };
    const dispatchSlot = this.content!.querySelector<HTMLElement>('.task-dispatch')!;
    const dispatchKey = JSON.stringify([Boolean(task?.enabled), task?.status, this.choices(), dispatch.submitting, dispatch.error]);
    if (this.dispatchKey !== dispatchKey) {
      this.dispatchKey = dispatchKey;
      dispatchSlot.replaceChildren();
      if (task?.enabled && task.status !== 'archived') {
        const input = h('textarea', { id: 'task-dispatch-text', rows: 3, 'aria-label': '派工內容', placeholder: '描述交付內容、限制與要回報的結果', value: dispatch.text, disabled: Boolean(dispatch.submitting) });
        input.addEventListener('input', () => { dispatch.text = input.value; });
        dispatchSlot.append(h('div', { class: 'task-collaboration-actions' }, h('button', { class: 'secondary small', onclick: () => this.host.send({ type: 'copyCollaborationPrompt', tabId }) }, '複製協作入口')),
          h('details', { class: 'task-dispatch-form', open: Boolean(dispatch.open), ontoggle: (event: Event) => { dispatch.open = (event.target as HTMLDetailsElement).open; } }, h('summary', {}, '派工給 agent'),
            h('label', {}, '執行者', this.targetSelect(dispatch.target, (value) => { dispatch.target = value; }, '派工執行者', task.status === 'handoff_pending' || Boolean(dispatch.submitting))),
            h('label', {}, '工作內容', input),
            dispatch.error ? h('div', { class: 'task-inline-error', role: 'alert' }, dispatch.error) : null,
            h('button', { class: 'task-submit-dispatch', disabled: task.status === 'handoff_pending' || Boolean(dispatch.submitting), onclick: () => {
              const target = this.target(dispatch.target);
              if (!target || !dispatch.text.trim()) { dispatch.error = '請選擇執行者並填寫工作內容。'; this.refreshCurrent(); return; }
              dispatch.open = true; dispatch.submitting = this.operationId(); delete dispatch.error;
              this.host.send({ type: 'delegateTask', tabId, operationId: dispatch.submitting, target, text: dispatch.text.trim() }); this.refreshCurrent();
            } }, dispatch.submitting ? '正在派工…' : '派工')));
      }
    }
    const key = JSON.stringify([task, this.tab!.agents.map((agent) => agent.paneId), this.answers]);
    if (key === this.recordsKey) return;
    // Keep a reply draft and IME composition attached during unrelated event updates.
    if (this.content!.querySelector('.task-answer-text:focus')) return;
    this.recordsKey = key;
    const records = this.content!.querySelector<HTMLElement>('.task-records')!;
    records.replaceChildren();
    if (!task || (!task.enabled && task.status !== 'archived')) { records.append(h('p', { class: 'muted pad' }, '啟用規劃者後，這裡會保留本問題的派工、等待與回報。')); return; }
    if (!task.requests.length) records.append(h('p', { class: 'muted' }, '尚未派工。可由規劃者使用協作指引呼叫其他 agent，也可在這裡發起工作。'));
    for (const request of task.requests) records.append(this.renderRequest(request));
    records.append(h('h3', { class: 'task-section-label' }, '協作紀錄'));
    if (!task.events.length) records.append(h('p', { class: 'muted' }, '尚無協作事件。'));
    for (const event of task.events) {
      const request = task.requests.find((item) => item.id === event.requestId);
      const agent = task.participants.find((item) => item.paneId === event.paneId);
      records.append(h('div', { class: `task-event task-event-${event.type}`, 'data-event-id': event.id },
        h('time', { dateTime: event.at }, timeLabel(event.at)),
        request ? h('div', { class: 'task-event-direction' }, this.paneLink(request.requestedBy), ' → ', this.paneLink(request.target), h('code', {}, request.id)) : agent ? this.paneLink(agent) : null,
        h('p', {}, event.text)));
    }
  }

  private renderRequest(request: CollaborationRequest): HTMLElement {
    const { h } = this.host;
    const task = this.task()!;
    const tabId = this.tab!.tabId;
    const row = h('article', { class: `task-request task-request-${request.status}`, 'data-request-id': request.id },
      h('div', { class: 'task-request-heading' }, h('div', {}, this.paneLink(request.requestedBy), ' → ', this.paneLink(request.target)), h('span', { class: 'task-request-status' }, requestLabel(request))),
      h('code', { class: 'task-request-id' }, request.id), h('p', { class: 'task-request-prompt' }, request.prompt));
    if (request.runtimeStatus) row.append(h('span', { class: 'muted task-runtime-status' }, `原生狀態：${request.runtimeStatus}`));
    if (request.report) row.append(h('div', { class: 'task-request-report' }, h('strong', {}, request.report.status === 'needs_input' ? '需要釐清' : 'Agent 回報'), h('p', {}, request.report.text)));
    if (request.error) row.append(h('p', { class: 'task-inline-error' }, request.error));
    for (const reply of request.replies) row.append(h('div', { class: 'task-request-reply' }, h('strong', {}, `${identityName(reply.by)} 的回覆`), h('p', {}, reply.text)));
    if (!['completed', 'failed'].includes(request.status)) row.append(h('p', { class: 'task-reply-route' }, task.status === 'archived' ? '問題已封存，顯示最後保留的回報狀態。' : task.status === 'handoff_pending' ? '回覆暫存於本問題，待接手後交付。' : `後續回覆交給規劃者：${identityName(task.planner)}`));
    if (request.status === 'needs_input' && request.report?.status !== 'needs_input' && task.status !== 'archived') {
      row.append(h('div', { class: 'task-native-blocked' },
        h('p', {}, '原生 agent 正等待權限或選單，請到該 pane 完成操作。'),
        h('button', { class: 'secondary small', disabled: !this.tab!.agents.some((agent) => agent.paneId === request.target.paneId), onclick: () => this.jumpToPane(request.target.paneId) }, '前往 pane 處理')));
    }
    if (request.status === 'needs_input' && request.report?.status === 'needs_input' && task.status !== 'archived') {
      const draft = this.answers[request.id] ??= { text: '' };
      const input = h('textarea', { class: 'task-answer-text', id: `task-answer-${request.id}`, 'aria-label': `回覆 ${request.id}`, rows: 2, value: draft.text, disabled: task.status === 'handoff_pending' || Boolean(draft.operationId) });
      input.addEventListener('input', () => { draft.text = input.value; });
      row.append(h('label', {}, '補充說明', input));
      if (draft.error) row.append(h('div', { class: 'task-inline-error', role: 'alert' }, draft.error));
      row.append(h('button', { class: 'secondary small', disabled: task.status === 'handoff_pending' || Boolean(draft.operationId), onclick: () => {
          if (!draft.text.trim() || draft.operationId) return;
          input.blur();
          draft.operationId = this.operationId(); delete draft.error;
          this.host.send({ type: 'answerTaskRequest', tabId, requestId: request.id, operationId: draft.operationId, text: draft.text.trim() }); this.refreshCurrent();
        } }, draft.operationId ? '送出中…' : '送出補充'));
    }
    return row;
  }

  private renderMemories(): void {
    const { h } = this.host;
    const references = this.task()?.memoryReferences ?? [];
    const key = JSON.stringify(references);
    if (this.recordsKey === key) return;
    this.recordsKey = key;
    this.content!.replaceChildren(h('p', { class: 'muted pad' }, '從對話訊息旁保存的記憶會保留在本問題，並標示 Claude-mem 的實際紀錄 ID。'));
    if (!references.length) this.content!.append(h('p', { class: 'muted pad' }, '這個問題尚未保存記憶。'));
    for (const memory of references) {
      const item = h('article', { class: 'task-memory-reference', 'data-memory-id': String(memory.id) },
        h('strong', {}, memory.title || `記憶 #${memory.id}`), h('span', { class: 'task-memory-id' }, `Claude-mem #${memory.id}`));
      if (memory.text) item.append(h('p', { class: 'task-memory-text' }, memory.text));
      if (memory.project) item.append(h('div', { class: 'muted' }, `專案：${memory.project}`));
      if (memory.source) {
        const source = memory.source;
        const agent = this.task()?.participants.find((candidate) => candidate.paneId === source.paneId);
        item.append(h('div', { class: 'muted' }, `來源：${agent ? identityName(agent) : source.paneId || '本問題'}${source.messageIndex === undefined ? '' : ` · 訊息 ${source.messageIndex + 1}`}`));
      }
      item.append(h('time', { dateTime: memory.savedAt }, timeLabel(memory.savedAt)));
      this.content!.append(item);
    }
  }

  finishOperation(result: Operation): void {
    const tabId = result.tabId;
    if (result.kind === 'memory') {
      const draft = this.ui.memoryDrafts[tabId];
      if (!draft || draft.operationId !== result.operationId) return;
      delete draft.operationId;
      if (result.error || !Number.isInteger(result.memoryId) || (result.memoryId ?? 0) <= 0) draft.error = result.error || '尚未收到 Claude-mem 的記憶 ID，草稿已保留。';
      else {
        delete this.ui.memoryDrafts[tabId];
        this.feedbackByTab[tabId] = { text: `已保存至 Claude-mem · 記憶 #${result.memoryId}` };
      }
      this.host.persist();
    } else if (result.kind === 'checkpoint' || result.kind === 'handoff') {
      const draft = this.handoffs[tabId];
      if (!draft) return;
      if (result.kind === 'checkpoint' && draft.preparing === result.operationId) {
        delete draft.preparing;
        draft.error = result.error;
        if (!result.error) draft.checkpoint = result.checkpoint;
      } else if (result.kind === 'handoff' && draft.submitting === result.operationId) {
        delete draft.submitting;
        draft.error = result.error;
        draft.submitted = !result.error;
        const task = this.tasks.find((item) => item.tabId === tabId);
        const latest = task?.handoffs.at(-1);
        if (result.error && latest?.status === 'failed' && latest.id === draft.previousHandoffId) draft.previousHandoffId = task?.handoffs.at(-2)?.id;
      } else return;
    } else if (result.kind === 'delegate') {
      const draft = this.dispatches[tabId];
      if (!draft || draft.submitting !== result.operationId) return;
      delete draft.submitting; draft.error = result.error;
      if (!result.error) draft.text = '';
    } else if (result.kind === 'planner') {
      if (this.plannerOperations[tabId] !== result.operationId) return;
      delete this.plannerOperations[tabId];
      if (result.error) this.feedbackByTab[tabId] = { text: result.error, error: true, kind: 'planner' };
    } else if (result.kind === 'answer') {
      const draft = Object.values(this.answers).find((item) => item.operationId === result.operationId);
      if (!draft) return;
      delete draft.operationId; draft.error = result.error;
      if (!result.error) draft.text = '';
    }
    this.refreshCurrent();
  }
}
