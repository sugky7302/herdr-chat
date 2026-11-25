import type { AgentView, ChatMessage, FromWebview, ProjectState, TabView, ToWebview } from '../src/shared';
import type { AgentIdentity, CollaborationRequest, CollaborationTask, RequestStatus } from '../src/collaboration/types';
import type { ChatHost, ChatView } from './chat';
import { formatLocalized, getIntlLocale, t } from '../src/l10n.ts';

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
  /** 回到 tab 的 agent 清單。 */
  openTab(tabId: string): void;
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
  sending: "Dispatching",
  running: "Running",
  awaiting_report: "Awaiting explicit report",
  needs_input: "Awaiting planner response",
  completed: "Reported complete",
  failed: "Dispatch failed",
  wait_expired: "Wait expired · result unknown",
};

function requestLabel(request: CollaborationRequest): string {
  if (request.status === 'failed') return request.report?.status === 'failed' ? t("Reported failure") : t("Dispatch failed");
  if (request.status === 'needs_input' && request.report?.status !== 'needs_input') return t("Awaiting native approval or menu");
  return t(REQUEST_LABELS[request.status]);
}

function identityName(agent: AgentIdentity): string {
  return agent.name || agent.harness || agent.paneId;
}

function paneName(agent: AgentView): string {
  return agent.label || agent.name || agent.kind || t("Terminal");
}

function timeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString(getIntlLocale());
}

/** One tab is one task. Pane selection only changes the conversation page. */
export class TaskView {
  private tasks: CollaborationTask[] = [];
  private tab: TabView | null = null;
  private root: HTMLElement | null = null;
  private heading: HTMLElement | null = null;
  /** 路由指定的 pane。只有在對話頁面才顯示聊天；沒有值時顯示 agent 清單。 */
  private routePane: string | undefined;
  private pageMenuOpen = false;
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
        draft.error = t("The previous save has not been confirmed. Your draft is preserved; check the memory records before retrying.");
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
    if (task.planner.paneId === paneId) return task.status === 'handoff_pending' ? t("The previous planner is paused while awaiting handoff. Your draft is preserved.") : undefined;
    if (task.handoffs.some((handoff) => handoff.status === 'accepted' && handoff.from.paneId === paneId)) return t("The previous planner’s conversation is read-only history. You can still save messages as memory.");
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
    return Boolean(this.root?.isConnected && this.page() === 'chat' && this.routePane === paneId);
  }

  private operationId(): string {
    return `task-${Date.now()}-${++this.nextOperation}`;
  }

  mount(tab: TabView, paneId?: string): HTMLElement {
    const { h } = this.host;
    this.heading = h('div', { class: 'task-heading' });
    this.handoffSlot = h('div', { class: 'task-handoff-slot' });
    this.memorySlot = h('div', { class: 'task-memory-slot' });
    this.feedback = h('div', { class: 'task-feedback', role: 'status', 'aria-live': 'polite', hidden: true });
    this.content = h('div', { class: 'task-content', id: 'task-panel' });
    this.pageMenuOpen = false;
    this.root = h('main', { class: 'task', 'data-tab-id': tab.tabId }, this.heading,
      h('div', { class: 'task-editors' }, this.handoffSlot, this.memorySlot), this.feedback, this.content);
    this.contentKey = this.handoffKey = this.memoryKey = this.dispatchKey = this.recordsKey = '';
    this.refresh(tab, paneId);
    this.host.send({ type: 'openTask', tabId: tab.tabId });
    return this.root;
  }

  refresh(tab: TabView, paneId?: string): void {
    this.tab = tab;
    this.routePane = paneId && tab.agents.some((agent) => agent.paneId === paneId) ? paneId : undefined;
    if (this.task()?.status === 'archived' && this.page() === 'chat') this.ui.pages[tab.tabId] = 'collaboration';
    const selected = paneId ?? this.ui.selectedPanes[tab.tabId];
    this.ui.selectedPanes[tab.tabId] = tab.agents.some((agent) => agent.paneId === selected)
      ? selected! : (tab.agents.find((agent) => agent.focused) ?? tab.agents[0])?.paneId ?? '';
    if (!this.root) return;
    this.renderHeading();
    this.renderHandoff();
    this.renderMemoryEditor();
    const feedback = this.feedbackByTab[tab.tabId];
    this.feedback!.hidden = !feedback;
    this.feedback!.classList.toggle('is-error', Boolean(feedback?.error));
    this.feedback!.textContent = feedback?.text ?? '';
    this.renderContent();
  }

  private refreshCurrent(): void {
    if (this.tab) this.refresh(this.tab, this.routePane);
  }

  /** 「對話」回到 agent 清單；協作與記憶在目前位置切換內容。 */
  private setPage(page: TaskPage): void {
    if (!this.tab) return;
    this.pageMenuOpen = false;
    this.ui.pages[this.tab.tabId] = page;
    this.host.persist();
    if (page === 'chat' && this.routePane) this.host.openTab(this.tab.tabId);
    else this.refreshCurrent();
  }

  /** 從外部（例如 VS Code 指令）切換頁面。 */
  showPage(page: TaskPage): void {
    if (page === 'chat' && this.task()?.status === 'archived') return;
    this.setPage(page);
  }

  private back(): void {
    const tab = this.tab!;
    const archived = this.task()?.status === 'archived';
    if (!archived && this.page() !== 'chat') {
      // 從協作或記憶返回原本的位置（對話或 agent 清單）。
      this.ui.pages[tab.tabId] = 'chat';
      this.host.persist();
      this.refreshCurrent();
    } else if (!archived && this.routePane) this.host.openTab(tab.tabId);
    else this.host.history();
  }

  /** 頁面選單：對話、協作、記憶。放在重新命名按鈕的左邊，點開後浮在內容上方。 */
  private renderPageMenu(): HTMLElement {
    const { h } = this.host;
    const archived = this.task()?.status === 'archived';
    const items: [TaskPage, string][] = [['chat', t("Chat")], ['collaboration', t("Collaboration")], ['memory', t("Memory")]];
    const current = items.find(([page]) => page === this.page())!;
    const menu = h('div', { class: 'task-page-menu', role: 'menu', 'aria-label': t("Task content"), hidden: !this.pageMenuOpen },
      ...items.map(([page, title]) => h('button', {
        class: 'task-page-item', type: 'button', role: 'menuitemradio', 'data-task-page': page,
        'aria-checked': String(this.page() === page),
        disabled: page === 'chat' && archived, title: page === 'chat' && archived ? t("The original pane is closed") : undefined,
        onclick: () => this.setPage(page),
      }, title)));
    const toggle = h('button', {
      class: 'task-page-button', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(this.pageMenuOpen),
      title: t("Task content"), 'aria-label': `${t("Task content")}：${current[1]}`,
      onclick: (event: Event) => {
        event.stopPropagation();
        this.pageMenuOpen = !this.pageMenuOpen;
        this.renderHeading();
      },
    }, h('span', {}, current[1]), h('span', { class: 'task-page-caret', 'aria-hidden': 'true' }));
    return h('div', { class: 'task-page-picker' }, toggle, menu);
  }

  /** 點選單外面或按 Esc 關閉頁面選單。 */
  closePageMenu(): void {
    if (!this.pageMenuOpen || !this.heading) return;
    this.pageMenuOpen = false;
    this.renderHeading();
  }

  jumpToPane(paneId: string): void {
    if (!this.tab?.agents.some((agent) => agent.paneId === paneId)) return;
    this.ui.pages[this.tab.tabId] = 'chat';
    this.host.persist();
    this.host.openAgent(paneId);
  }

  private backButton(): HTMLElement {
    const archived = this.task()?.status === 'archived';
    const toAgents = !archived && (Boolean(this.routePane) || this.page() !== 'chat');
    const label = toAgents ? t("Back to agents") : t("History");
    return this.host.h('button', { class: 'icon-button task-back', title: label, 'aria-label': label, onclick: () => this.back() }, this.host.icon('back'));
  }

  private renderHeading(): void {
    const { h } = this.host;
    const tab = this.tab!;
    const task = this.task();
    const pending = task?.status === 'handoff_pending';
    const planner = task?.enabled ? task.planner : undefined;
    const delivery = task?.plannerDelivery;
    const selected = tab.agents.find((agent) => agent.paneId === this.paneId() && agent.kind);
    const plannerText = task?.status === 'archived' ? t("Archived · {0}", planner ? t("Last planner: {0}", identityName(planner)) : t("Collaboration not enabled")) : planner
      ? pending ? t("Previous planner: {0} · paused for handoff", identityName(planner)) : t("Planner: {0}", identityName(planner))
      : t("No collaboration planner enabled");
    const toolbar = h('div', { class: 'toolbar task-title' },
      this.backButton(),
      h('h2', { title: this.host.title(tab) }, this.host.title(tab)),
      h('div', { class: 'spacer' }),
      this.renderPageMenu(),
      task?.status !== 'archived' ? h('button', { class: 'icon-button', title: t("Rename task"), 'aria-label': t("Rename task"), onclick: () => this.host.send({ type: 'renameTab', tabId: tab.tabId }) }, this.host.icon('edit')) : null);
    const plannerRow = h('div', { class: 'task-planner' }, h('span', { class: 'task-planner-label' }, plannerText));
    if (planner && delivery && task?.status !== 'archived' && !pending) plannerRow.append(h('span', { class: 'task-planner-delivery', 'data-delivery-status': delivery.status },
      delivery.status === 'sending' ? t("Sending collaboration commands") : delivery.status === 'sent' ? t("Collaboration commands sent") : t("Collaboration command delivery unconfirmed")));
    if (task?.status === 'archived') {
      plannerRow.append(h('span', { class: 'muted' }, t("Read-only history")));
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
      }, this.plannerOperations[tab.tabId] ? t("Enabling…") : selected ? t("Use {0} as planner", paneName(selected)) : t("Add an agent first")));
    } else {
      plannerRow.append(h('button', { class: 'secondary small', disabled: delivery?.status === 'sending' && !pending, onclick: () => this.openHandoff() }, pending ? t("View handoff") : t("Hand off planner")));
    }
    this.heading!.replaceChildren(toolbar, plannerRow);
    if (pending) {
      const handoff = task.handoffs.at(-1);
      this.heading!.append(h('div', { class: 'task-notice', role: 'status' },
        handoff?.status === 'failed' ? t("Handoff failed. The previous planner remains paused. Choose another successor; workers continue and their replies are retained in this task.")
          : t("Waiting for {0} to accept. Workers continue and their replies are retained in this task.", handoff?.target ? identityName(handoff.target) : t("New planner"))));
    } else if (delivery?.status === 'uncertain' && task?.status !== 'archived') {
      this.heading!.append(h('div', { class: 'task-notice task-delivery-uncertain', role: 'alert' },
        h('p', {}, t("Delivery of the collaboration commands is unconfirmed. Copy them to the original planner and run status to check the task.")),
        delivery.error ? h('p', { class: 'muted' }, formatLocalized(delivery.error, delivery.errorLocalization)) : null,
        h('button', { class: 'secondary small', onclick: () => this.host.send({ type: 'copyCollaborationPrompt', tabId: tab.tabId }) }, t("Copy collaboration commands"))));
    }
  }

  private renderContent(): void {
    const { h, chat } = this.host;
    const tab = this.tab!;
    const page = this.page();
    const paneId = this.routePane;
    this.root!.classList.toggle('pane', page === 'chat' && Boolean(paneId));
    this.root!.dataset.page = page;
    this.root!.dataset.paneId = page === 'chat' ? paneId ?? '' : '';
    this.content!.classList.toggle('task-chat', page === 'chat');
    if (page === 'chat') {
      const key = `chat:${paneId ?? ''}`;
      if (key !== this.contentKey) {
        this.contentKey = key;
        if (paneId) this.content!.replaceChildren(this.host.paneToolbar(paneId), ...chat.mount(paneId));
        else this.content!.replaceChildren(this.renderAgentList());
        this.host.send({ type: 'openPane', paneId: paneId || null });
      } else if (paneId) {
        this.content!.querySelector('.toolbar')?.replaceWith(this.host.paneToolbar(paneId));
        chat.refresh();
      } else {
        this.content!.querySelector('.task-agent-list')?.replaceWith(this.renderAgentList());
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

  /** tab 的 agent 清單。點一下 agent 才進入對話。 */
  private renderAgentList(): HTMLElement {
    const { h } = this.host;
    const task = this.task();
    const labels: Record<string, string> = { working: t("Running"), blocked: t("Awaiting action"), idle: t("Idle"), done: t("Native turn ended"), unknown: t("Unknown state"), shell: t("Terminal") };
    const agents = this.tab!.agents;
    return h('div', { class: 'task-agent-list' },
      agents.length ? h('ul', { class: 'list task-agents', 'aria-label': t("Switch conversation agent") },
        ...agents.map((agent) => {
          let role = task?.enabled && task.planner.paneId === agent.paneId ? task.status === 'handoff_pending' ? t("Previous planner · handoff paused") : t("Planner") : '';
          if (!role && task?.handoffs.some((handoff) => handoff.status === 'accepted' && handoff.from.paneId === agent.paneId)) role = t("Previous planner");
          const request = task ? [...task.requests].reverse().find((item) => item.target.paneId === agent.paneId) : undefined;
          const status = request ? requestLabel(request) : labels[agent.status] ?? t("Unknown state");
          const statusText = labels[agent.status] ?? agent.status;
          return h('li', { class: 'row-wrap' },
            h('button', {
              class: `row task-agent ${agent.focused ? 'active' : ''}`, 'data-agent-pane': agent.paneId,
              title: `${paneName(agent)} · ${agent.paneId}`, onclick: () => this.host.openAgent(agent.paneId),
            },
            h('span', { class: `status status-${agent.status}`, title: statusText, role: 'img', 'aria-label': statusText }),
            h('span', { class: 'row-text' },
              h('span', { class: 'row-title task-agent-name' }, paneName(agent)),
              h('span', { class: 'row-sub task-agent-state' }, [role, status, agent.kind && agent.title ? agent.title : ''].filter(Boolean).join(' · ')))),
            h('div', { class: 'row-actions' },
              h('button', { class: 'icon-button', title: t("Rename"), 'aria-label': t("Rename"), onclick: () => this.host.send({ type: 'renamePane', paneId: agent.paneId }) }, this.host.icon('edit')),
              h('button', { class: 'icon-button', title: t("Close pane"), 'aria-label': t("Close pane"), onclick: () => this.host.send({ type: 'closePane', paneId: agent.paneId }) }, this.host.icon('trash'))));
        })) : h('p', { class: 'muted pad' }, t("Add an agent to this task to start a conversation.")),
      h('div', { class: 'pad' }, h('button', { class: 'secondary small task-add-agent', onclick: () => this.host.newAgent(this.tab!.tabId) }, t('＋ Add agent'))));
  }


  openMemory(paneId: string, message: ChatMessage, messageIndex: number, selectedText?: string): void {
    const tab = this.tab;
    if (!tab || !tab.agents.some((agent) => agent.paneId === paneId)) return;
    const existing = this.ui.memoryDrafts[tab.tabId];
    if (existing) {
      this.feedbackByTab[tab.tabId] = { text: t("A memory draft is already open. Save or cancel it before selecting another message.") };
      this.refreshCurrent();
      return;
    }
    const text = selectedText?.trim() || message.text;
    this.ui.memoryDrafts[tab.tabId] = {
      title: text.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || t("Task decision"), text,
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
    const title = bind('title', h('input', { id: 'task-memory-title', 'aria-label': t("Memory title"), disabled: Boolean(draft.operationId) }));
    const text = bind('text', h('textarea', { id: 'task-memory-text', rows: 5, 'aria-label': t("Memory content"), disabled: Boolean(draft.operationId) }));
    const project = this.task()?.checkoutPath ?? this.host.state()?.worktrees.find((item) => item.current)?.path ?? this.host.state()?.repoRoot ?? '';
    const sourceAgent = tab.agents.find((agent) => agent.paneId === draft.source.paneId);
    this.memorySlot!.append(h('section', { class: 'task-memory-editor', 'aria-label': t("Save as memory") },
      h('div', { class: 'task-section-title' }, h('strong', {}, t("Save as memory")), h('button', {
        class: 'link', disabled: Boolean(draft.operationId), onclick: () => { delete this.ui.memoryDrafts[tab.tabId]; this.host.persist(); this.refreshCurrent(); },
      }, t("Cancel"))),
      h('label', {}, t("Title"), title), h('label', {}, t("Content"), text),
      h('div', { class: 'task-provenance' }, h('span', {}, t("Project: {0}", project)), h('span', {}, t("Source: {0} · {1} · message {2}", this.host.title(tab), sourceAgent ? paneName(sourceAgent) : draft.source.paneId, draft.source.messageIndex + 1))),
      draft.error ? h('div', { class: 'task-inline-error', role: 'alert' }, draft.error) : null,
      h('button', {
        class: 'task-save-memory', disabled: Boolean(draft.operationId), onclick: () => {
          if (!draft.title.trim() || !draft.text.trim()) { draft.error = t("Enter a title and content."); this.refreshCurrent(); return; }
          draft.operationId = this.operationId(); delete draft.error;
          this.host.persist();
          this.host.send({ type: 'saveTaskMemory', tabId: tab.tabId, operationId: draft.operationId, title: draft.title.trim(), text: draft.text.trim(), source: draft.source });
          this.refreshCurrent();
        },
      }, draft.operationId ? t("Saving memory…") : t("Save to Claude-mem"))));
  }

  private choices(): { value: string; label: string }[] {
    const plannerId = this.task()?.planner.paneId;
    return [
      ...(this.tab?.agents ?? []).filter((agent) => agent.kind && agent.status === 'idle' && agent.paneId !== plannerId).map((agent) => ({ value: `pane:${agent.paneId}`, label: t("Existing {0} · {1} (idle)", paneName(agent), agent.paneId) })),
      ...(this.host.state()?.presets ?? []).filter((preset) => preset.canAutomate === true && preset.enabled !== false).map((preset) => ({ value: `preset:${preset.id}`, label: t("New {0}", preset.label) })),
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
    }, h('option', { value: '', selected: !choices.some((item) => item.value === value) }, choices.length ? t("Choose an agent…") : t("No idle agents or supported automation presets are available")),
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
    const panel = h('section', { class: 'task-handoff', 'aria-label': t("Hand off planner") },
      h('div', { class: 'task-section-title' }, h('strong', {}, t("Hand off planner")), h('button', { class: 'link', onclick: () => { draft.open = false; this.refreshCurrent(); } }, t("Collapse"))),
      !locked && latest?.status !== 'accepted' ? h('label', {}, t("Successor"), this.targetSelect(draft.target, (value) => { draft.target = value; this.refreshCurrent(); }, t("Handoff successor"))) : null,
      draft.preparing ? h('p', { class: 'muted', role: 'status' }, t("Building a handoff checkpoint from the task, conversations, and reports…")) : null,
      h('details', { class: 'task-checkpoint', open: true }, h('summary', {}, t("Handoff checkpoint · captured from current records")), h('pre', {}, latest && pending && latest.status !== 'failed' ? latest.checkpoint || draft.checkpoint || t("No checkpoint available yet") : draft.checkpoint || latest?.checkpoint || t("No checkpoint available yet"))),
      draft.error ? h('div', { class: 'task-inline-error', role: 'alert' }, draft.error) : null);
    if (latest?.status === 'accepted') panel.append(h('p', { class: 'task-confirmed', role: 'status' }, t("{0} has accepted the handoff. Existing worker requests continue.", latest.target ? identityName(latest.target) : t("New planner"))));
    else if (locked) panel.append(h('p', { class: 'task-waiting', role: 'status' }, draft.submitting ? t("Sending handoff…") : pending ? t("The previous planner is paused while awaiting acceptance. Worker replies are retained in this task.") : t("Handoff sent. Waiting for the agent to accept.")));
    else {
      if (latest?.status === 'failed') panel.append(h('p', { class: 'task-inline-error', role: 'alert' }, latest.error ? formatLocalized(latest.error, latest.errorLocalization) : t("The previous handoff failed. Check the state before trying again.")));
      panel.append(h('button', {
        class: 'task-submit-handoff', disabled: !draft.checkpoint || Boolean(draft.preparing) || !this.target(draft.target),
        onclick: () => {
          const target = this.target(draft.target); if (!target || !draft.checkpoint) return;
          draft.submitting = this.operationId(); delete draft.error;
          draft.previousHandoffId = task?.handoffs.at(-1)?.id;
          this.host.send({ type: 'requestHandoff', tabId, operationId: draft.submitting, target }); this.refreshCurrent();
        },
      }, t("Send handoff")));
    }
    this.handoffSlot!.append(panel);
  }

  private paneLink(identity: AgentIdentity): HTMLElement {
    const { h } = this.host;
    const available = this.tab!.agents.some((agent) => agent.paneId === identity.paneId);
    return available ? h('button', { class: 'link task-pane-link', title: identity.paneId, onclick: () => this.jumpToPane(identity.paneId) }, identityName(identity))
      : h('span', { title: t("{0} (pane closed)", identity.paneId) }, identityName(identity));
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
        const input = h('textarea', { id: 'task-dispatch-text', rows: 3, 'aria-label': t("Delegation instructions"), placeholder: t("Describe the deliverables, constraints, and required report"), value: dispatch.text, disabled: Boolean(dispatch.submitting) });
        input.addEventListener('input', () => { dispatch.text = input.value; });
        dispatchSlot.append(h('div', { class: 'task-collaboration-actions' }, h('button', { class: 'secondary small', onclick: () => this.host.send({ type: 'copyCollaborationPrompt', tabId }) }, t("Copy collaboration commands"))),
          h('details', { class: 'task-dispatch-form', open: Boolean(dispatch.open), ontoggle: (event: Event) => { dispatch.open = (event.target as HTMLDetailsElement).open; } }, h('summary', {}, t("Delegate to an agent")),
            h('label', {}, t("Worker"), this.targetSelect(dispatch.target, (value) => { dispatch.target = value; }, t("Delegation worker"), task.status === 'handoff_pending' || Boolean(dispatch.submitting))),
            h('label', {}, t("Instructions"), input),
            dispatch.error ? h('div', { class: 'task-inline-error', role: 'alert' }, dispatch.error) : null,
            h('button', { class: 'task-submit-dispatch', disabled: task.status === 'handoff_pending' || Boolean(dispatch.submitting), onclick: () => {
              const target = this.target(dispatch.target);
              if (!target || !dispatch.text.trim()) { dispatch.error = t("Choose a worker and enter the instructions."); this.refreshCurrent(); return; }
              dispatch.open = true; dispatch.submitting = this.operationId(); delete dispatch.error;
              this.host.send({ type: 'delegateTask', tabId, operationId: dispatch.submitting, target, text: dispatch.text.trim() }); this.refreshCurrent();
            } }, dispatch.submitting ? t("Delegating…") : t("Delegate"))));
      }
    }
    const key = JSON.stringify([task, this.tab!.agents.map((agent) => agent.paneId), this.answers]);
    if (key === this.recordsKey) return;
    // Keep a reply draft and IME composition attached during unrelated event updates.
    if (this.content!.querySelector('.task-answer-text:focus')) return;
    this.recordsKey = key;
    const records = this.content!.querySelector<HTMLElement>('.task-records')!;
    records.replaceChildren();
    if (!task || (!task.enabled && task.status !== 'archived')) { records.append(h('p', { class: 'muted pad' }, t("Enable a planner to track this task’s delegations, waits, and reports here."))); return; }
    if (!task.requests.length) records.append(h('p', { class: 'muted' }, t("No work delegated yet. The planner can use the collaboration commands, or you can delegate work here.")));
    for (const request of task.requests) records.append(this.renderRequest(request));
    records.append(h('h3', { class: 'task-section-label' }, t("Collaboration history")));
    if (!task.events.length) records.append(h('p', { class: 'muted' }, t("No collaboration events yet.")));
    for (const event of task.events) {
      const request = task.requests.find((item) => item.id === event.requestId);
      const agent = task.participants.find((item) => item.paneId === event.paneId);
      records.append(h('div', { class: `task-event task-event-${event.type}`, 'data-event-id': event.id },
        h('time', { dateTime: event.at }, timeLabel(event.at)),
        request ? h('div', { class: 'task-event-direction' }, this.paneLink(request.requestedBy), ' → ', this.paneLink(request.target), h('code', {}, request.id)) : agent ? this.paneLink(agent) : null,
        h('p', {}, formatLocalized(event.text, event.localization))));
    }
  }

  private renderRequest(request: CollaborationRequest): HTMLElement {
    const { h } = this.host;
    const task = this.task()!;
    const tabId = this.tab!.tabId;
    const row = h('article', { class: `task-request task-request-${request.status}`, 'data-request-id': request.id },
      h('div', { class: 'task-request-heading' }, h('div', {}, this.paneLink(request.requestedBy), ' → ', this.paneLink(request.target)), h('span', { class: 'task-request-status' }, requestLabel(request))),
      h('code', { class: 'task-request-id' }, request.id), h('p', { class: 'task-request-prompt' }, request.prompt));
    if (request.runtimeStatus) row.append(h('span', { class: 'muted task-runtime-status' }, t("Native state: {0}", request.runtimeStatus)));
    if (request.report) row.append(h('div', { class: 'task-request-report' }, h('strong', {}, request.report.status === 'needs_input' ? t("Clarification needed") : t("Agent report")), h('p', {}, request.report.text)));
    if (request.error) row.append(h('p', { class: 'task-inline-error' }, formatLocalized(request.error, request.errorLocalization)));
    for (const reply of request.replies) row.append(h('div', { class: 'task-request-reply' }, h('strong', {}, t("Reply from {0}", identityName(reply.by))), h('p', {}, reply.text)));
    if (!['completed', 'failed'].includes(request.status)) row.append(h('p', { class: 'task-reply-route' }, task.status === 'archived' ? t("This task is archived. Showing its last recorded report state.") : task.status === 'handoff_pending' ? t("Replies are retained in this task and will be provided at handoff.") : t("Future replies go to planner: {0}", identityName(task.planner))));
    if (request.status === 'needs_input' && request.report?.status !== 'needs_input' && task.status !== 'archived') {
      row.append(h('div', { class: 'task-native-blocked' },
        h('p', {}, t("The native agent is awaiting approval or a menu choice. Complete the action in its pane.")),
        h('button', { class: 'secondary small', disabled: !this.tab!.agents.some((agent) => agent.paneId === request.target.paneId), onclick: () => this.jumpToPane(request.target.paneId) }, t("Open pane to respond"))));
    }
    if (request.status === 'needs_input' && request.report?.status === 'needs_input' && task.status !== 'archived') {
      const draft = this.answers[request.id] ??= { text: '' };
      const input = h('textarea', { class: 'task-answer-text', id: `task-answer-${request.id}`, 'aria-label': t("Reply to {0}", request.id), rows: 2, value: draft.text, disabled: task.status === 'handoff_pending' || Boolean(draft.operationId) });
      input.addEventListener('input', () => { draft.text = input.value; });
      row.append(h('label', {}, t("Additional information"), input));
      if (draft.error) row.append(h('div', { class: 'task-inline-error', role: 'alert' }, draft.error));
      row.append(h('button', { class: 'secondary small', disabled: task.status === 'handoff_pending' || Boolean(draft.operationId), onclick: () => {
          if (!draft.text.trim() || draft.operationId) return;
          input.blur();
          draft.operationId = this.operationId(); delete draft.error;
          this.host.send({ type: 'answerTaskRequest', tabId, requestId: request.id, operationId: draft.operationId, text: draft.text.trim() }); this.refreshCurrent();
        } }, draft.operationId ? t("Sending…") : t("Send information")));
    }
    return row;
  }

  private renderMemories(): void {
    const { h } = this.host;
    const references = this.task()?.memoryReferences ?? [];
    const key = JSON.stringify(references);
    if (this.recordsKey === key) return;
    this.recordsKey = key;
    this.content!.replaceChildren(h('p', { class: 'muted pad' }, t("Memories saved from conversations remain linked to this task with their actual Claude-mem record IDs.")));
    if (!references.length) this.content!.append(h('p', { class: 'muted pad' }, t("No memories saved for this task yet.")));
    for (const memory of references) {
      const item = h('article', { class: 'task-memory-reference', 'data-memory-id': String(memory.id) },
        h('strong', {}, memory.title || t("Memory #{0}", memory.id)), h('span', { class: 'task-memory-id' }, `Claude-mem #${memory.id}`));
      if (memory.text) item.append(h('p', { class: 'task-memory-text' }, memory.text));
      if (memory.project) item.append(h('div', { class: 'muted' }, t("Project: {0}", memory.project)));
      if (memory.source) {
        const source = memory.source;
        const agent = this.task()?.participants.find((candidate) => candidate.paneId === source.paneId);
        item.append(h('div', { class: 'muted' }, source.messageIndex === undefined ? t("Source: {0}", agent ? identityName(agent) : source.paneId || t("This task")) : t("Source: {0} · message {1}", agent ? identityName(agent) : source.paneId || t("This task"), source.messageIndex + 1)));
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
      if (result.error || !Number.isInteger(result.memoryId) || (result.memoryId ?? 0) <= 0) draft.error = result.error || t("No memory ID has been received from Claude-mem. Your draft is preserved.");
      else {
        delete this.ui.memoryDrafts[tabId];
        this.feedbackByTab[tabId] = { text: t("Saved to Claude-mem · memory #{0}", result.memoryId) };
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
