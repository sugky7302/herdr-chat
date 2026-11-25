import './style.css';
import { getIntlLocale, setLocale, t } from '../src/l10n.ts';
import type {
  AgentView,
  FromWebview,
  PresetView,
  ProjectState,
  TabView,
  ToWebview,
} from '../src/shared';
import { ChatView, type Draft } from './chat';
import { TaskView, type TaskUiState } from './task';
import { SettingsView } from './settings';

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): any;
  setState(state: any): void;
};

// The extension host supplies VS Code's display language before this bundle is evaluated.
setLocale(document.documentElement.lang);
const vscode = acquireVsCodeApi();

type Route =
  | { view: 'history' }
  | { view: 'settings' }
  | { view: 'tab'; tabId: string }
  | { view: 'archivedTask'; tabId: string }
  | { view: 'pane'; paneId: string }
  | { view: 'newAgent'; tabId: string | null };

const saved = vscode.getState() ?? {};
let route: Route | null = saved.route ?? null;
let state: ProjectState | null = null;
let busyText: string | null = null;
let errorText: string | null = null;
let creatingWorktree = false;
const drafts: Record<string, Draft> = saved.drafts ?? {};
const taskUi: TaskUiState = {
  pages: saved.taskUi?.pages ?? {},
  selectedPanes: saved.taskUi?.selectedPanes ?? {},
  memoryDrafts: saved.taskUi?.memoryDrafts ?? {},
};
let newAgentChoice: { presetId?: string; model?: string; effort?: string; saveAsDefault?: boolean } = {};

const app = document.getElementById('app')!;
let lastStateJson = '';

function send(message: FromWebview): void {
  vscode.postMessage(message);
}

function persist(): void {
  vscode.setState({ route, drafts, taskUi });
}

function go(next: Route): void {
  if (route?.view === 'settings' && next.view !== 'settings') {
    settingsView.leave(() => changeRoute(next));
    return;
  }
  changeRoute(next);
}

function changeRoute(next: Route): void {
  route = next;
  errorText = null;
  persist();
  if (next.view !== 'pane' && next.view !== 'tab') send({ type: 'openPane', paneId: null });
  render();
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      const json = JSON.stringify(message.state);
      if (json === lastStateJson && route) break;
      lastStateJson = json;
      state = message.state;
      fixRoute();
      render();
      break;
    }
    case 'transcript':
      if (taskView.acceptsTranscript(message.transcript.paneId)) chat.setTranscript(message.transcript);
      break;
    case 'collaborationState':
      taskView.setTasks(message.tasks);
      render();
      break;
    case 'taskOperation':
      taskView.finishOperation(message);
      break;
    case 'queuedUpdated':
      chat.finishQueueEdit(message.paneId, message.id, message.error);
      break;
    case 'completions':
      chat.onCompletions(message.requestId, message.items);
      break;
    case 'attachments':
      chat.addAttachments(message.paneId, message.paths);
      break;
    case 'navigate':
      if (message.view === 'history') go({ view: 'history' });
      else if (message.view === 'settings') go({ view: 'settings' });
      else go({ view: 'newAgent', tabId: currentTabId() });
      break;
    case 'cycleAgent':
      cycleAgent(message.delta);
      break;
    case 'settingsState':
    case 'settingsOperation':
      settingsView.receive(message);
      break;
    case 'openedPane':
      chat.clearTranscript();
      go({ view: 'pane', paneId: message.paneId });
      break;
    case 'busy':
      busyText = message.busy ? (message.text ?? t("Processing…")) : null;
      render();
      break;
    case 'error':
      errorText = message.text;
      busyText = null;
      render();
      break;
  }
});

/** 路由指向的 tab 或 pane 已經不存在時，退回上一層。 */
function fixRoute(): void {
  if (!state) return;
  if (!route) {
    const focused = state.tabs.find((tab) => tab.focused) ?? state.tabs[0];
    route = focused ? { view: 'tab', tabId: focused.tabId } : { view: 'history' };
    send({ type: 'openPane', paneId: null });
    return;
  }
  if (route.view === 'tab' && !findTab(route.tabId)) route = { view: 'history' };
  if (route.view === 'pane' && !findAgent(route.paneId) && state.tabs.length) {
    // pane 剛建立時 snapshot 可能還沒更新，所以只在有 tab 資料時才退回。
    const stillLoading = busyText !== null;
    if (!stillLoading) route = { view: 'history' };
  }
  if (route.view === 'newAgent' && route.tabId && !findTab(route.tabId)) route = { view: 'newAgent', tabId: null };
}

function findTab(tabId: string): TabView | undefined {
  return state?.tabs.find((tab) => tab.tabId === tabId);
}

function findAgent(paneId: string): { tab: TabView; agent: AgentView } | undefined {
  for (const tab of state?.tabs ?? []) {
    const agent = tab.agents.find((item) => item.paneId === paneId);
    if (agent) return { tab, agent };
  }
  return undefined;
}

/**
 * 切換到同一個 tab 中的下一個或上一個 agent，到底會繞回開頭。
 * 不在 pane 頁面時，下一個是第一個 agent，上一個是最後一個 agent。
 */
function cycleAgent(delta: 1 | -1): void {
  if (!state || route?.view === 'settings') return;
  const tabId = currentTabId() ?? (state.tabs.find((tab) => tab.focused) ?? state.tabs[0])?.tabId;
  const agents = (tabId ? findTab(tabId)?.agents : undefined) ?? [];
  if (!agents.length) return;
  const currentPane = route?.view === 'pane' ? route.paneId : null;
  const index = currentPane ? agents.findIndex((agent) => agent.paneId === currentPane) : -1;
  const next = index < 0 ? (delta > 0 ? 0 : agents.length - 1) : (index + delta + agents.length) % agents.length;
  const paneId = agents[next].paneId;
  if (currentPane === paneId) return;
  chat.clearTranscript();
  go({ view: 'pane', paneId });
}

function currentTabId(): string | null {
  if (route?.view === 'tab' || route?.view === 'archivedTask') return route.tabId;
  if (route?.view === 'pane') return findAgent(route.paneId)?.tab.tabId ?? null;
  return null;
}

function presetFor(agent: AgentView | undefined): PresetView | undefined {
  return state?.presets.find((preset) => preset.id === agent?.presetId);
}

// ---------- DOM 小工具 ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key in element && key !== 'list') (element as any)[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function icon(name: string): HTMLElement {
  return h('span', { class: `icon icon-${name}`, 'aria-hidden': 'true' });
}

function statusDot(status: string): HTMLElement {
  const labels: Record<string, string> = {
    working: t("Running"),
    blocked: t("Awaiting your response"),
    done: t("Native turn ended"),
    idle: t("Idle"),
    unknown: t("Unknown state"),
    shell: t("Terminal"),
  };
  return h('span', { class: `status status-${status}`, title: labels[status] ?? status, role: 'img', 'aria-label': labels[status] ?? status });
}

/**
 * 下拉選單。placeholder 是值為空字串的第一個選項，例如「預設」。
 * extraCurrent 是 agent 回報、但不在選項清單中的目前值。
 */
function select(
  options: string[],
  value: string | undefined,
  label: string,
  onChange: (value: string) => void,
  extra: { current?: string; placeholder?: string } = {},
): HTMLSelectElement {
  const all = extra.current && !options.includes(extra.current) ? [extra.current, ...options] : options;
  return h(
    'select',
    { 'aria-label': label, title: label, onchange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
    extra.placeholder !== undefined ? h('option', { value: '', selected: !value }, extra.placeholder) : null,
    ...all.map((option) => h('option', { value: option, selected: option === value }, option)),
  );
}

// ---------- 畫面 ----------

function render(): void {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusedId = active?.id;
  const selection =
    active && 'selectionStart' in active && active.selectionStart != null ? [active.selectionStart, active.selectionEnd ?? 0] : null;
  const task = app.querySelector<HTMLElement>('main.task');
  const tabId = currentTabId();
  const tab = tabId ? findTab(tabId) ?? taskView.archivedTab(tabId) : undefined;
  if (route?.view === 'settings' && app.querySelector('main.settings')) {
    // Settings owns its editable draft and DOM; agent polling must not disturb typing.
    app.firstElementChild?.replaceWith(renderHeader());
    app.querySelector(':scope > .busy')?.remove();
    app.querySelector(':scope > .error')?.remove();
  } else if (tab && task?.dataset.tabId === tabId && (route?.view === 'pane' || route?.view === 'tab' || route?.view === 'archivedTask')) {
    app.firstElementChild?.replaceWith(renderHeader());
    taskView.refresh(tab, route.view === 'pane' ? route.paneId : undefined);
    app.querySelector(':scope > .busy')?.remove();
    app.querySelector(':scope > .error')?.remove();
  } else {
    app.replaceChildren(renderHeader(), renderMain());
  }
  if (busyText) app.append(h('div', { class: 'busy', role: 'status' }, h('span', { class: 'spinner' }), busyText));
  if (errorText)
    app.append(
      h('div', { class: 'error', role: 'alert' }, errorText, h('button', { class: 'link', onclick: () => { errorText = null; render(); } }, t("Close"))),
    );
  if (focusedId) {
    const element = document.getElementById(focusedId) as HTMLInputElement | null;
    if (element && element !== active) {
      element.focus();
      if (selection) element.setSelectionRange(selection[0], selection[1]);
    }
  }
}

function renderHeader(): HTMLElement {
  if (!state) return h('header', { class: 'header' }, h('span', { class: 'muted' }, t("Connecting to herdr…")));
  const worktreeSelect = state.worktrees.length
    ? h(
        'select',
        {
          class: 'worktree',
          'aria-label': t("Switch worktree"),
          title: t("Switch branch (worktree)"),
          onchange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            const change = () => {
              if (value === '__new__') { creatingWorktree = true; render(); }
              else { send({ type: 'switchWorktree', path: value }); route = null; }
            };
            if (route?.view === 'settings') {
              (event.target as HTMLSelectElement).value = state!.worktrees.find((tree) => tree.current)?.path ?? '';
              settingsView.leave(change);
            } else change();
          },
        },
        ...state.worktrees.map((tree) =>
          h('option', { value: tree.path, selected: tree.current }, `${tree.branch}${tree.workspaceId ? '' : t(" (not open)")}`),
        ),
        h('option', { value: '__new__' }, t("＋ New worktree…")),
      )
    : null;
  const header = h(
    'header',
    { class: 'header' },
    h('div', { class: 'repo' }, icon('repo'), h('strong', {}, state.repoName ?? 'herdr'), worktreeSelect),
  );
  if (creatingWorktree) {
    const input = h('input', { id: 'branch-input', placeholder: t("New branch name"), 'aria-label': t("New branch name") });
    const submit = () => {
      const branch = input.value.trim();
      if (!branch) return;
      creatingWorktree = false;
      send({ type: 'createWorktree', branch });
      route = null;
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') {
        creatingWorktree = false;
        render();
      }
    });
    header.append(
      h(
        'div',
        { class: 'inline-form' },
        input,
        h('button', { onclick: submit }, t("Create")),
        h('button', { class: 'secondary', onclick: () => { creatingWorktree = false; render(); } }, t("Cancel")),
      ),
    );
    queueMicrotask(() => input.focus());
  }
  return header;
}

function renderMain(): HTMLElement {
  // Settings is also the repair/configuration entry point when Herdr is unavailable.
  if (route?.view === 'settings') return settingsView.mount();
  if (!state) return h('main', { class: 'empty' }, h('span', { class: 'spinner' }));
  if (!state.connected || (state.error && !state.repoRoot)) {
    return h(
      'main',
      { class: 'empty' },
      h('p', {}, state.error ?? t("Unable to connect to herdr.")),
      h('button', { onclick: () => send({ type: 'refresh' }) }, t("Reconnect")),
    );
  }
  if (!state.workspaceId) {
    return h(
      'main',
      { class: 'empty' },
      h('p', {}, t("This worktree has no workspace in herdr yet.")),
      h('button', { onclick: () => send({ type: 'createWorkspace' }) }, t("Create workspace in herdr")),
    );
  }
  switch (route?.view) {
    case 'tab':
      return renderTab(route.tabId);
    case 'pane':
      return renderPane(route.paneId);
    case 'archivedTask': {
      const tab = taskView.archivedTab(route.tabId);
      return tab ? taskView.mount(tab) : h('main', {}, toolbar(t("Archived history"), { view: 'history' }), h('p', { class: 'muted pad' }, t("Loading this task’s records…")));
    }
    case 'newAgent':
      return renderNewAgent(route.tabId);
    default:
      return renderHistory();
  }
}

function toolbar(title: string | HTMLElement, back: Route | null, ...actions: Child[]): HTMLElement {
  return h(
    'div',
    { class: 'toolbar' },
    back ? h('button', { class: 'icon-button', title: t("Back"), 'aria-label': t("Back"), onclick: () => go(back) }, icon('back')) : null,
    h('h2', { title: typeof title === 'string' ? title : title.textContent }, title),
    h('div', { class: 'spacer' }),
    ...actions,
  );
}

/** 名稱後方保留完整 pane ID，方便指定其他 agent。 */
function agentTitle(agent: AgentView): HTMLElement {
  return h(
    'span',
    { class: 'agent-heading' },
    h('span', { class: 'agent-name' }, agent.label || agent.name || agent.kind || t("Terminal")),
    ' ',
    h('span', { class: 'agent-id' }, agent.paneId),
  );
}

/** 列表的一列：主要按鈕加上滑過時出現的操作按鈕。 */
function rowItem(main: HTMLElement, actions: { icon: string; label: string; run: () => void }[]): HTMLElement {
  return h(
    'li',
    { class: 'row-wrap' },
    main,
    h(
      'div',
      { class: 'row-actions' },
      ...actions.map((action) =>
        h('button', { class: 'icon-button', title: action.label, 'aria-label': action.label, onclick: action.run }, icon(action.icon)),
      ),
    ),
  );
}

function tabTitle(tab: TabView): string {
  const named = tab.agents.find((agent) => agent.title)?.title;
  return /^\d+$/.test(tab.label) && named ? named : tab.label;
}

function renderHistory(): HTMLElement {
  const tabs = state!.tabs;
  const archives = taskView.archivedTasks();
  return h(
    'main',
    {},
    toolbar(
      t("History ({0})", state!.workspaceLabel ?? ''),
      null,
      h('button', { class: 'secondary small', onclick: () => send({ type: 'newTab' }) }, t("＋ New task")),
    ),
    tabs.length
      ? h(
          'ul',
          { class: 'list' },
          ...tabs.map((tab) =>
            rowItem(
              h(
                'button',
                {
                  class: `row ${tab.focused ? 'active' : ''}`,
                  onclick: () => {
                    send({ type: 'focusTab', tabId: tab.tabId });
                    go({ view: 'tab', tabId: tab.tabId });
                  },
                },
                statusDot(tab.status),
                h(
                  'span',
                  { class: 'row-text' },
                  h('span', { class: 'row-title' }, tabTitle(tab)),
                  h(
                    'span',
                    { class: 'row-sub' },
                    `#${tab.number} · ${new Intl.ListFormat(getIntlLocale()).format(tab.agents.filter((agent) => agent.kind).map((agent) => agent.kind!)) || t("No agents")}`,
                  ),
                ),
              ),
              [
                { icon: 'edit', label: t("Rename"), run: () => send({ type: 'renameTab', tabId: tab.tabId }) },
                { icon: 'trash', label: t("Close conversation"), run: () => send({ type: 'closeTab', tabId: tab.tabId }) },
              ],
            ),
          ),
        )
      : h('p', { class: 'muted pad' }, t("This workspace has no active tasks yet.")),
    archives.length ? h('h3', { class: 'task-section-label pad' }, t("Archived tasks")) : null,
    archives.length ? h('ul', { class: 'list task-archive-list' }, ...archives.map((task) => h('li', {}, h('button', {
      class: 'row', 'data-archive-tab': task.tabId, onclick: () => go({ view: 'archivedTask', tabId: task.tabId }),
    }, h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, task.title), h('span', { class: 'row-sub' }, t("Delegations: {0} · Memories: {1} · Read-only", task.requests.length, task.memoryReferences.length))))))) : null,
  );
}

function renderTab(tabId: string): HTMLElement {
  const tab = findTab(tabId)!;
  return taskView.mount(tab);
}

const SHELL_PRESET: PresetView = {
  id: '__shell__',
  label: "Terminal",
  models: [],
  efforts: [],
  canSwitchModel: false,
  canSwitchEffort: false,
};

function renderNewAgent(tabId: string | null): HTMLElement {
  const presets = [...state!.presets.filter((preset) => preset.enabled !== false), { ...SHELL_PRESET, label: t(SHELL_PRESET.label) }];
  const preset = presets.find((item) => item.id === newAgentChoice.presetId) ?? presets[0];
  if (preset && newAgentChoice.presetId !== preset.id) {
    newAgentChoice = { presetId: preset.id, model: preset.defaultModel, effort: preset.defaultEffort };
  }
  const tab = tabId ? findTab(tabId) : undefined;
  const targetSelect = h(
    'select',
    {
      'aria-label': t("Destination"),
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        route = { view: 'newAgent', tabId: value || null };
        persist();
        render();
      },
    },
    h('option', { value: '', selected: !tab }, t("New conversation (new tab)")),
    ...state!.tabs.map((item) => h('option', { value: item.tabId, selected: item.tabId === tabId }, t("Join: {0}", tabTitle(item)))),
  );
  return h(
    'main',
    {},
    toolbar(t("Add agent or pane"), tab ? { view: 'tab', tabId: tab.tabId } : { view: 'history' }),
    h(
      'div',
      { class: 'form' },
      h(
        'div',
        { class: 'preset-grid', role: 'radiogroup', 'aria-label': t("Agent type") },
        ...presets.map((item) =>
          h(
            'button',
            {
              class: `preset ${item.id === preset?.id ? 'selected' : ''}`,
              role: 'radio',
              'aria-checked': String(item.id === preset?.id),
              onclick: () => {
                newAgentChoice = { presetId: item.id, model: item.defaultModel, effort: item.defaultEffort };
                render();
              },
            },
            item.label,
          ),
        ),
      ),
      h('label', {}, t("Destination"), targetSelect),
      preset?.models.length
        ? h('label', {}, t("Model"), select(preset.models, newAgentChoice.model, t("Model"), (value) => (newAgentChoice.model = value || undefined), { placeholder: t("Default (agent settings)") }))
        : null,
      preset?.efforts.length
        ? h('label', {}, t('Effort'), select(preset.efforts, newAgentChoice.effort, t('Effort'), (value) => (newAgentChoice.effort = value || undefined), { placeholder: t("Default (agent settings)") }))
        : null,
      preset && (preset.models.length || preset.efforts.length)
        ? h(
            'label',
            { class: 'checkbox' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(newAgentChoice.saveAsDefault),
              onchange: (event: Event) => (newAgentChoice.saveAsDefault = (event.target as HTMLInputElement).checked),
            }),
            t("Save as project default (writes .vscode/settings.json)"),
          )
        : null,
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            disabled: !preset || busyText !== null,
            onclick: () =>
              preset &&
              send({
                type: 'newAgent',
                presetId: preset.id,
                tabId,
                model: newAgentChoice.model,
                effort: newAgentChoice.effort,
                saveAsDefault: newAgentChoice.saveAsDefault,
              }),
          },
          t("Start"),
        ),
        h('button', { class: 'link', onclick: () => send({ type: 'openSettings' }) }, t("Edit presets…")),
      ),
    ),
  );
}

// ---------- 對話頁 ----------

const chat: ChatView = new ChatView({
  send,
  persist,
  h,
  icon,
  agent: (paneId) => findAgent(paneId)?.agent,
  preset: presetFor,
  drafts,
  saveMemory: (paneId, message, messageIndex, selectedText) => taskView.openMemory(paneId, message, messageIndex, selectedText),
  readOnly: (paneId) => taskView.readOnlyReason(paneId),
});

const taskView: TaskView = new TaskView({
  h, icon, send, persist, chat,
  state: () => state,
  title: tabTitle,
  paneToolbar: renderPaneToolbar,
  openAgent: (paneId) => { if (route?.view !== 'pane' || route.paneId !== paneId) chat.clearTranscript(); go({ view: 'pane', paneId }); },
  openTab: (tabId) => go({ view: 'tab', tabId }),
  history: () => go({ view: 'history' }),
  newAgent: (tabId) => go({ view: 'newAgent', tabId }),
}, taskUi);

const settingsView = new SettingsView({ h, icon, send, back: () => go({ view: 'history' }) });

function renderPaneToolbar(paneId: string): HTMLElement {
  const found = findAgent(paneId);
  const agent = found?.agent;
  const screenOn = chat.screenOpen.has(paneId);
  return toolbar(
      agent ? agentTitle(agent) : paneId,
      null,
      agent ? statusDot(agent.status) : null,
      h(
        'button',
        {
          class: `icon-button ${screenOn ? 'toggled' : ''}`,
          title: t("Show terminal output and keys"),
          'aria-label': t("Show terminal output and keys"),
          'aria-pressed': String(screenOn),
          onclick: () => {
            if (screenOn) chat.screenOpen.delete(paneId);
            else chat.screenOpen.add(paneId);
            send({ type: 'showScreen', paneId, show: !screenOn });
            render();
          },
        },
        icon('terminal'),
      ),
      h('button', { class: 'icon-button', title: t("Rename"), 'aria-label': t("Rename"), onclick: () => send({ type: 'renamePane', paneId }) }, icon('edit')),
      h('button', { class: 'icon-button', title: t("Close pane"), 'aria-label': t("Close pane"), onclick: () => send({ type: 'closePane', paneId }) }, icon('trash')),
      h('button', { class: 'icon-button', title: t("Focus this pane in herdr"), 'aria-label': t("Focus this pane in herdr"), onclick: () => send({ type: 'focusPaneInHerdr', paneId }) }, icon('focus')),
  );
}

function renderPane(paneId: string): HTMLElement {
  const found = findAgent(paneId);
  return found ? taskView.mount(found.tab, paneId) : h('main', { class: 'empty' }, h('span', { class: 'spinner' }), t("Loading agent…"));
}

document.addEventListener('click', (event) => {
  if (!(event.target as Element | null)?.closest?.('.task-page-picker')) taskView.closePageMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') taskView.closePageMenu();
});

render();
send({ type: 'ready' });
