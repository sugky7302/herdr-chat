import './style.css';
import type {
  AgentView,
  FromWebview,
  PresetView,
  ProjectState,
  TabView,
  ToWebview,
} from '../src/shared';
import { ChatView, type Draft } from './chat';

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

type Route =
  | { view: 'history' }
  | { view: 'tab'; tabId: string }
  | { view: 'pane'; paneId: string }
  | { view: 'newAgent'; tabId: string | null };

const saved = vscode.getState() ?? {};
let route: Route | null = saved.route ?? null;
let state: ProjectState | null = null;
let busyText: string | null = null;
let errorText: string | null = null;
let creatingWorktree = false;
const drafts: Record<string, Draft> = saved.drafts ?? {};
let newAgentChoice: { presetId?: string; model?: string; effort?: string; saveAsDefault?: boolean } = {};

const app = document.getElementById('app')!;
let lastStateJson = '';

function send(message: FromWebview): void {
  vscode.postMessage(message);
}

function persist(): void {
  vscode.setState({ route, drafts });
}

function go(next: Route): void {
  route = next;
  errorText = null;
  persist();
  send({ type: 'openPane', paneId: next.view === 'pane' ? next.paneId : null });
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
      if (route?.view === 'pane' && route.paneId === message.transcript.paneId) chat.setTranscript(message.transcript);
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
      else go({ view: 'newAgent', tabId: currentTabId() });
      break;
    case 'openedPane':
      chat.clearTranscript();
      go({ view: 'pane', paneId: message.paneId });
      break;
    case 'busy':
      busyText = message.busy ? (message.text ?? '處理中…') : null;
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

function currentTabId(): string | null {
  if (route?.view === 'tab') return route.tabId;
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
    working: '執行中',
    blocked: '等待你回應',
    done: '已完成',
    idle: '閒置',
    unknown: '狀態不明',
    shell: '終端機',
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
  const pane = app.querySelector<HTMLElement>('main.pane');
  if (route?.view === 'pane' && pane?.dataset.paneId === route.paneId) {
    app.firstElementChild?.replaceWith(renderHeader());
    pane.querySelector('.toolbar')?.replaceWith(renderPaneToolbar(route.paneId));
    chat.refresh();
    app.querySelector(':scope > .busy')?.remove();
    app.querySelector(':scope > .error')?.remove();
  } else {
    app.replaceChildren(renderHeader(), renderMain());
  }
  if (busyText) app.append(h('div', { class: 'busy', role: 'status' }, h('span', { class: 'spinner' }), busyText));
  if (errorText)
    app.append(
      h('div', { class: 'error', role: 'alert' }, errorText, h('button', { class: 'link', onclick: () => { errorText = null; render(); } }, '關閉')),
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
  if (!state) return h('header', { class: 'header' }, h('span', { class: 'muted' }, '連線到 herdr…'));
  const worktreeSelect = state.worktrees.length
    ? h(
        'select',
        {
          class: 'worktree',
          'aria-label': '切換 worktree',
          title: '切換分支（worktree）',
          onchange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            if (value === '__new__') {
              creatingWorktree = true;
              render();
            } else {
              send({ type: 'switchWorktree', path: value });
              route = null;
            }
          },
        },
        ...state.worktrees.map((tree) =>
          h('option', { value: tree.path, selected: tree.current }, `${tree.branch}${tree.workspaceId ? '' : '（未開啟）'}`),
        ),
        h('option', { value: '__new__' }, '＋ 新增 worktree…'),
      )
    : null;
  const header = h(
    'header',
    { class: 'header' },
    h('div', { class: 'repo' }, icon('repo'), h('strong', {}, state.repoName ?? 'herdr'), worktreeSelect),
  );
  if (creatingWorktree) {
    const input = h('input', { id: 'branch-input', placeholder: '新分支名稱', 'aria-label': '新分支名稱' });
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
        h('button', { onclick: submit }, '建立'),
        h('button', { class: 'secondary', onclick: () => { creatingWorktree = false; render(); } }, '取消'),
      ),
    );
    queueMicrotask(() => input.focus());
  }
  return header;
}

function renderMain(): HTMLElement {
  if (!state) return h('main', { class: 'empty' }, h('span', { class: 'spinner' }));
  if (!state.connected || (state.error && !state.repoRoot)) {
    return h(
      'main',
      { class: 'empty' },
      h('p', {}, state.error ?? '無法連線到 herdr。'),
      h('button', { onclick: () => send({ type: 'refresh' }) }, '重新連線'),
    );
  }
  if (!state.workspaceId) {
    return h(
      'main',
      { class: 'empty' },
      h('p', {}, '這個 worktree 在 herdr 還沒有 workspace。'),
      h('button', { onclick: () => send({ type: 'createWorkspace' }) }, '在 herdr 建立 workspace'),
    );
  }
  switch (route?.view) {
    case 'tab':
      return renderTab(route.tabId);
    case 'pane':
      return renderPane(route.paneId);
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
    back ? h('button', { class: 'icon-button', title: '返回', 'aria-label': '返回', onclick: () => go(back) }, icon('back')) : null,
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
    h('span', { class: 'agent-name' }, agent.label || agent.name || agent.kind || '終端機'),
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
  return h(
    'main',
    {},
    toolbar(
      `對話紀錄（${state!.workspaceLabel ?? ''}）`,
      null,
      h('button', { class: 'secondary small', onclick: () => send({ type: 'newTab' }) }, '＋ 新對話'),
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
                    `#${tab.number} · ${tab.agents.filter((agent) => agent.kind).map((agent) => agent.kind).join('、') || '沒有 agent'}`,
                  ),
                ),
              ),
              [
                { icon: 'edit', label: '重新命名', run: () => send({ type: 'renameTab', tabId: tab.tabId }) },
                { icon: 'trash', label: '關閉對話', run: () => send({ type: 'closeTab', tabId: tab.tabId }) },
              ],
            ),
          ),
        )
      : h('p', { class: 'muted pad' }, '這個 workspace 還沒有對話。'),
  );
}

function renderTab(tabId: string): HTMLElement {
  const tab = findTab(tabId)!;
  return h(
    'main',
    {},
    toolbar(
      tabTitle(tab),
      { view: 'history' },
      h('button', { class: 'icon-button', title: '重新命名對話', 'aria-label': '重新命名對話', onclick: () => send({ type: 'renameTab', tabId }) }, icon('edit')),
      h('button', { class: 'secondary small', onclick: () => go({ view: 'newAgent', tabId }) }, '＋ pane'),
    ),
    h(
      'ul',
      { class: 'list' },
      ...tab.agents.map((agent) =>
        rowItem(
          h(
            'button',
            { class: `row ${agent.focused ? 'active' : ''}`, onclick: () => { chat.clearTranscript(); go({ view: 'pane', paneId: agent.paneId }); } },
            statusDot(agent.status),
            h(
              'span',
              { class: 'row-text' },
              h('span', { class: 'row-title' }, agentTitle(agent)),
              h('span', { class: 'row-sub' }, [agent.kind, agent.title].filter(Boolean).join(' · ') || agent.paneId),
            ),
          ),
          [
            { icon: 'edit', label: '重新命名', run: () => send({ type: 'renamePane', paneId: agent.paneId }) },
            { icon: 'trash', label: '關閉 pane', run: () => send({ type: 'closePane', paneId: agent.paneId }) },
          ],
        ),
      ),
    ),
  );
}

const SHELL_PRESET: PresetView = {
  id: '__shell__',
  label: '終端機',
  models: [],
  efforts: [],
  canSwitchModel: false,
  canSwitchEffort: false,
};

function renderNewAgent(tabId: string | null): HTMLElement {
  const presets = [...state!.presets, SHELL_PRESET];
  const preset = presets.find((item) => item.id === newAgentChoice.presetId) ?? presets[0];
  if (preset && newAgentChoice.presetId !== preset.id) {
    newAgentChoice = { presetId: preset.id, model: preset.defaultModel, effort: preset.defaultEffort };
  }
  const tab = tabId ? findTab(tabId) : undefined;
  const targetSelect = h(
    'select',
    {
      'aria-label': '加入位置',
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        route = { view: 'newAgent', tabId: value || null };
        persist();
        render();
      },
    },
    h('option', { value: '', selected: !tab }, '新對話（新 tab）'),
    ...state!.tabs.map((item) => h('option', { value: item.tabId, selected: item.tabId === tabId }, `加入：${tabTitle(item)}`)),
  );
  return h(
    'main',
    {},
    toolbar('新增 agent 或 pane', tab ? { view: 'tab', tabId: tab.tabId } : { view: 'history' }),
    h(
      'div',
      { class: 'form' },
      h(
        'div',
        { class: 'preset-grid', role: 'radiogroup', 'aria-label': 'agent 種類' },
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
      h('label', {}, '加入位置', targetSelect),
      preset?.models.length
        ? h('label', {}, '模型', select(preset.models, newAgentChoice.model, '模型', (value) => (newAgentChoice.model = value || undefined), { placeholder: '預設（依 agent 設定）' }))
        : null,
      preset?.efforts.length
        ? h('label', {}, 'Effort', select(preset.efforts, newAgentChoice.effort, 'Effort', (value) => (newAgentChoice.effort = value || undefined), { placeholder: '預設（依 agent 設定）' }))
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
            '設為此專案預設（寫入 .vscode/settings.json）',
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
          '啟動',
        ),
        h('button', { class: 'link', onclick: () => send({ type: 'openSettings' }) }, '編輯選項…'),
      ),
    ),
  );
}

// ---------- 對話頁 ----------

const chat = new ChatView({
  send,
  persist,
  h,
  icon,
  agent: (paneId) => findAgent(paneId)?.agent,
  preset: presetFor,
  drafts,
});

function renderPaneToolbar(paneId: string): HTMLElement {
  const found = findAgent(paneId);
  const agent = found?.agent;
  const back: Route = found ? { view: 'tab', tabId: found.tab.tabId } : { view: 'history' };
  const screenOn = chat.screenOpen.has(paneId);
  return toolbar(
      agent ? agentTitle(agent) : paneId,
      back,
      agent ? statusDot(agent.status) : null,
      h(
        'button',
        {
          class: `icon-button ${screenOn ? 'toggled' : ''}`,
          title: '顯示終端機畫面與按鍵',
          'aria-label': '顯示終端機畫面與按鍵',
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
      h('button', { class: 'icon-button', title: '重新命名', 'aria-label': '重新命名', onclick: () => send({ type: 'renamePane', paneId }) }, icon('edit')),
      h('button', { class: 'icon-button', title: '在 herdr 中聚焦此 pane', 'aria-label': '在 herdr 中聚焦此 pane', onclick: () => send({ type: 'focusPaneInHerdr', paneId }) }, icon('focus')),
  );
}

function renderPane(paneId: string): HTMLElement {
  return h('main', { class: 'pane', 'data-pane-id': paneId }, renderPaneToolbar(paneId), ...chat.mount(paneId));
}

render();
send({ type: 'ready' });
if (route?.view === 'pane') send({ type: 'openPane', paneId: route.paneId });
