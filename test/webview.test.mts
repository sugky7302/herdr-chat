import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window, type HTMLTextAreaElement as DOMTextArea, type HTMLElement as DOMElement, type HTMLButtonElement as DOMButton } from 'happy-dom';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['webview/main.ts'],
  bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent',
});

function fixture(language = 'zh-TW', browserLanguage = 'en-US') {
  const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const document = window.document;
  document.documentElement.lang = language;
  Object.defineProperty(window.navigator, 'language', { configurable: true, value: browserLanguage });
  document.body.innerHTML = '<div id="app"></div>';
  // DOM 測試不計算版面。以連接狀態模擬瀏覽器量測，另以真實瀏覽器驗證捲動。
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    return this.classList.contains('messages') ? (this.isConnected ? 1000 : 0) : 34;
  } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() {
    return this.classList.contains('messages') && this.isConnected ? 400 - document.querySelectorAll('.queue-item').length * 20 : 0;
  } });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', { configurable: true,
    get() { return this.__scrollTop ?? 0; },
    set(value) { this.__scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  });
  window.HTMLElement.prototype.scrollTo = function (options: any) { this.scrollTop = options.top ?? 0; };
  const sent: any[] = [];
  const paneId = 'wE:p1';
  const state: any = {
    connected: true, repoName: 'test', repoRoot: '/tmp/test', worktrees: [], workspaceId: 'wE', workspaceLabel: 'test', presets: [],
    tabs: [{ tabId: 'wE:t1', label: 'test', number: 1, focused: true, status: 'working', agents: [
      { paneId, name: 'claude', kind: 'claude', label: null, presetId: null, status: 'working', title: 'Claude', focused: true },
      { paneId: 'wE:p2', name: 'codex', kind: 'codex', label: null, presetId: null, status: 'working', title: 'Codex', focused: false },
    ] }],
  };
  const transcript: any = { paneId, source: 'claude', messages: [{ role: 'assistant', text: '工作進行中。' }], usage: { contextTokens: 1 }, queue: [] };
  (window as any).acquireVsCodeApi = () => ({ getState: () => ({ route: { view: 'pane', paneId }, drafts: {} }), setState() {}, postMessage(message: any) { sent.push(message); } });
  const emit = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  window.eval(bundle.outputFiles[0].text);
  emit({ type: 'state', state: structuredClone(state) });
  emit({ type: 'transcript', transcript: structuredClone(transcript) });
  const input = () => document.querySelector<DOMTextArea>('.chat-input > textarea')!;
  const messages = () => document.querySelector<DOMElement>('.messages')!;
  const updateState = () => { state.tabs[0].agents[1].title += '.'; emit({ type: 'state', state: structuredClone(state) }); };
  const updateTranscript = () => emit({ type: 'transcript', transcript: structuredClone(transcript) });
  return { window, document, sent, paneId, state, transcript, emit, input, messages, updateState, updateTranscript };
}

test('中文組字期間，背景用量更新不會更換輸入框或中斷焦點', async () => {
  const f = fixture();
  try {
    const input = f.input(); input.focus();
    input.dispatchEvent(new f.window.CompositionEvent('compositionstart'));
    input.value = '正在輸入中文'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: true }));
    f.transcript.usage.contextTokens++;
    f.updateTranscript();
    assert.ok(f.input() === input, '背景更新不可更換中文組字中的輸入框');
    assert.ok(f.document.activeElement === input);
    assert.equal(input.value, '正在輸入中文');
  } finally { await f.window.happyDOM.close(); }
});

test('其他 agent 更新時，保留目前輸入框、草稿、選取位置與焦點', async () => {
  const f = fixture();
  try {
    const input = f.input(); input.value = '尚未送出的草稿'; input.dispatchEvent(new f.window.Event('input')); input.focus(); input.setSelectionRange(2, 4);
    f.updateState();
    assert.ok(f.input() === input, '其他 agent 更新不可重建目前的聊天框');
    assert.ok(f.document.activeElement === input);
    assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
  } finally { await f.window.happyDOM.close(); }
});

test('組字完成後套用延後的佇列更新，保留最後確認的中文字', async () => {
  const f = fixture();
  try {
    const input = f.input(); input.focus();
    input.dispatchEvent(new f.window.CompositionEvent('compositionstart'));
    input.value = '輸入中'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: true }));
    f.transcript.queue = [{ id: 1, text: '下一則', attachments: [] }]; f.updateTranscript();
    input.dispatchEvent(new f.window.CompositionEvent('compositionend'));
    input.value = '中文輸入完成'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: false }));
    await new Promise((resolve) => f.window.setTimeout(resolve, 20));
    assert.ok(f.input() === input);
    assert.equal(input.value, '中文輸入完成');
    assert.equal(f.document.querySelectorAll('.queue-item').length, 1);
  } finally { await f.window.happyDOM.close(); }
});

test('閱讀歷史訊息時，背景更新不會把捲動位置跳回頂端或底端', async () => {
  const f = fixture();
  try {
    f.messages().scrollTop = 200; f.messages().dispatchEvent(new f.window.Event('scroll'));
    f.updateState();
    assert.equal(f.messages().scrollTop, 200);
  } finally { await f.window.happyDOM.close(); }
});

test('跟隨最新訊息時，先更新佇列高度，再對齊訊息底端', async () => {
  const f = fixture();
  try {
    f.messages().scrollTop = 600; f.messages().dispatchEvent(new f.window.Event('scroll'));
    f.transcript.queue = [{ id: 1, text: '下一則', attachments: [] }];
    f.updateTranscript();
    assert.equal(f.messages().scrollTop, 620);
  } finally { await f.window.happyDOM.close(); }
});

test('重複的對話快照不會重建既有訊息', async () => {
  const f = fixture();
  try {
    const turn = f.messages().firstElementChild;
    f.updateTranscript();
    assert.ok(f.messages().firstElementChild === turn);
  } finally { await f.window.happyDOM.close(); }
});

test('輸入法的 Enter 與 Tab 不會送出訊息或接受補全', async () => {
  const f = fixture();
  try {
    const input = f.input(); input.value = '中文'; input.dispatchEvent(new f.window.Event('input')); input.focus();
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
    assert.equal(f.sent.filter((message) => message.type === 'send').length, 0);
    input.dispatchEvent(new f.window.CompositionEvent('compositionstart'));
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Tab', keyCode: 229, bubbles: true, cancelable: true }));
    assert.equal(input.value, '中文');
  } finally { await f.window.happyDOM.close(); }
});

test('加入佇列使用紙飛機圖示，且維持 queue 送出模式', async () => {
  const f = fixture();
  try {
    const button = f.document.querySelector<DOMButton>('button.send-button')!;
    assert.ok(button.querySelector('.icon-send'));
    assert.equal(button.getAttribute('aria-label'), '加入佇列');
    const input = f.input(); input.value = '下一則'; input.dispatchEvent(new f.window.Event('input')); button.click();
    assert.equal(f.sent.find((message) => message.type === 'send')?.mode, 'queue');
  } finally { await f.window.happyDOM.close(); }
});

function collaborationFixture(language = 'zh-TW') {
  const f = fixture(language);
  f.state.presets = [
    { id: 'codex', label: 'Codex', models: [], efforts: [], canSwitchModel: false, canSwitchEffort: false, canAutomate: true },
    { id: 'custom', label: 'Custom shell', models: [], efforts: [], canSwitchModel: false, canSwitchEffort: false, canAutomate: false },
  ];
  f.state.tabs[0].agents.push({ paneId: 'wE:p3', name: 'reviewer', kind: 'codex', label: 'Reviewer', presetId: 'codex', status: 'idle', title: 'Review', focused: false });
  f.updateState();
  const planner = { paneId: f.paneId, tabId: 'wE:t1', harness: 'claude', name: 'Claude' };
  const worker = { paneId: 'wE:p2', tabId: 'wE:t1', harness: 'codex', name: 'Codex-impl' };
  const reviewer = { paneId: 'wE:p3', tabId: 'wE:t1', harness: 'codex', name: 'Reviewer' };
  const task: any = {
    id: 'task-1', tabId: 'wE:t1', title: 'test', repositoryRoot: '/tmp/test', checkoutPath: '/tmp/test',
    createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:01:00Z', status: 'active', generation: 1, enabled: true,
    planner, participants: [planner, worker, reviewer], handoffs: [], userMessages: [],
    requests: [{ id: 'R-01', taskId: 'task-1', requestedBy: planner, target: worker, generation: 1, revision: 1,
      prompt: '重構 auth 並回報測試結果', status: 'running', createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:01:00Z', reports: [], replies: [] }],
    events: [{ id: 'event-1', at: '2026-01-01T10:01:00Z', type: 'delegated', text: 'Claude 委派實作', requestId: 'R-01', paneId: worker.paneId }],
    memoryReferences: [{ id: 42, title: '保留 401 格式', text: '不變更對外 API', project: 'test', source: { paneId: planner.paneId, messageIndex: 0 }, savedAt: '2026-01-01T10:01:00Z' }],
  };
  const emitTasks = (tasks = [task]) => f.emit({ type: 'collaborationState', tasks: structuredClone(tasks) });
  emitTasks();
  const click = (selector: string) => {
    const button = f.document.querySelector<DOMButton>(selector);
    assert.ok(button, `找不到 ${selector}`); button.click();
  };
  const button = (text: string) => {
    const result = Array.from(f.document.querySelectorAll<DOMButton>('button')).find((item) => item.textContent.trim() === text);
    assert.ok(result, `找不到按鈕 ${text}`); return result;
  };
  const edit = (selector: string, text: string) => {
    const element = f.document.querySelector<DOMTextArea>(selector)!;
    assert.ok(element); element.value = text; element.dispatchEvent(new f.window.Event('input')); return element;
  };
  return { ...f, task, planner, worker, reviewer, emitTasks, click, button, edit };
}

test('問題導覽維持同一範圍，agent 切換器只出現在對話', async () => {
  const f = collaborationFixture();
  try {
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-agents'), null);
    assert.match(f.document.querySelector('.task-title')!.textContent, /test/);
    assert.match(f.document.querySelector('.task-planner')!.textContent, /Claude/);
    assert.match(f.document.querySelector('.task-content')!.textContent, /R-01/);
    f.click('[data-task-page="memory"]');
    assert.equal(f.document.querySelector('.task-agents'), null);
    assert.match(f.document.querySelector('.task-content')!.textContent, /不變更對外 API/);
    f.task.events.push({ id: 'event-2', at: '2026-01-01T10:02:00Z', type: 'state_changed', text: 'worker 更新', requestId: 'R-01' });
    f.emitTasks(); f.updateState();
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-page'), 'memory');
    f.click('[data-task-page="chat"]');
    f.click('[data-agent-pane="wE:p2"]');
    f.emit({ type: 'transcript', transcript: { paneId: 'wE:p2', source: 'codex', messages: [{ role: 'assistant', text: '正在實作。' }] } });
    assert.match(f.messages().textContent, /正在實作/);
    f.click('[data-task-page="memory"]');
    assert.match(f.document.querySelector('.task-content')!.textContent, /Claude-mem #42/);
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-tab-id'), 'wE:t1');

    const other = { ...structuredClone(f.task), id: 'task-2', tabId: 'wE:t2', title: '另一個問題', requests: [], events: [], memoryReferences: [{ id: 99, title: '另一個問題的記憶', savedAt: '2026-01-01T10:03:00Z' }] };
    f.state.tabs.push({ tabId: 'wE:t2', label: '另一個問題', number: 2, focused: false, status: 'idle', agents: [{ ...f.state.tabs[0].agents[2], paneId: 'wE:p4' }] });
    f.updateState(); f.emitTasks([f.task, other]);
    f.click('[aria-label="歷史紀錄"]');
    const row = Array.from(f.document.querySelectorAll<DOMButton>('.list .row')).find((item) => item.textContent.includes('另一個問題'))!;
    row.click(); f.click('[data-task-page="memory"]');
    assert.match(f.document.querySelector('.task-content')!.textContent, /Claude-mem #99/);
    assert.doesNotMatch(f.document.querySelector('.task-content')!.textContent, /Claude-mem #42/);
  } finally { await f.window.happyDOM.close(); }
});

test('記憶草稿保留來源與編輯內容，只有真正回傳 memory ID 才成功', async () => {
  const f = collaborationFixture();
  try {
    f.click('.save-message-memory');
    f.edit('#task-memory-title', '保留錯誤契約');
    const text = f.edit('#task-memory-text', '整理後的決策，不是原文。'); text.focus(); text.setSelectionRange(2, 5);
    f.updateState(); f.emitTasks();
    assert.ok(f.document.querySelector('#task-memory-text') === text, '背景更新不能重建記憶編輯框');
    assert.equal(text.value, '整理後的決策，不是原文。');
    f.click('[data-agent-pane="wE:p2"]');
    assert.equal(f.document.querySelector<DOMTextArea>('#task-memory-text')!.value, text.value);
    assert.match(f.document.querySelector('.task-provenance')!.textContent, /claude/);
    assert.match(f.document.querySelector('.task-provenance')!.textContent, /\/tmp\/test/);
    f.click('.task-save-memory');
    const first = f.sent.filter((message) => message.type === 'saveTaskMemory').at(-1);
    assert.equal(first.tabId, 'wE:t1');
    assert.equal(first.title, '保留錯誤契約'); assert.equal(first.text, text.value);
    assert.deepEqual(structuredClone(first.source), { paneId: f.paneId, messageIndex: 0, role: 'assistant', text: '工作進行中。' });
    assert.doesNotMatch(f.document.querySelector('.task-feedback')!.textContent, /已保存/);
    f.emit({ type: 'taskOperation', kind: 'memory', tabId: 'wE:t1', operationId: 'wrong-operation', memoryId: 1 });
    assert.ok(f.document.querySelector('.task-memory-editor'), '無關的回應不能清掉草稿');
    f.emit({ type: 'taskOperation', kind: 'memory', tabId: 'wE:t1', operationId: first.operationId, error: 'Claude-mem 暫時無法連線' });
    assert.equal(f.document.querySelector<DOMTextArea>('#task-memory-text')!.value, '整理後的決策，不是原文。');
    assert.match(f.document.querySelector('.task-inline-error')!.textContent, /無法連線/);
    f.click('.task-save-memory');
    const second = f.sent.filter((message) => message.type === 'saveTaskMemory').at(-1);
    f.emit({ type: 'taskOperation', kind: 'memory', tabId: 'wE:t1', operationId: second.operationId });
    assert.match(f.document.querySelector('.task-inline-error')!.textContent, /尚未收到/);
    assert.ok(f.document.querySelector('.task-memory-editor'));
    f.click('.task-save-memory');
    const third = f.sent.filter((message) => message.type === 'saveTaskMemory').at(-1);
    f.emit({ type: 'taskOperation', kind: 'memory', tabId: 'wE:t1', operationId: third.operationId, memoryId: 341 });
    assert.equal(f.document.querySelector('.task-memory-editor'), null);
    assert.match(f.document.querySelector('.task-feedback')!.textContent, /記憶 #341/);
  } finally { await f.window.happyDOM.close(); }
});

test('交接等待真正接手事件，暫存回覆且保留原始派工歷史', async () => {
  const f = collaborationFixture();
  try {
    f.button('交接規劃者').click();
    const preparation = f.sent.find((message) => message.type === 'prepareHandoff');
    assert.ok(preparation);
    f.emit({ type: 'taskOperation', kind: 'checkpoint', tabId: 'wE:t1', operationId: preparation.operationId, checkpoint: '目標：重構 auth\n限制：保留 401\n已完成：分工\n待完成：R-01\n來源：10:01 的工作回報' });
    const select = f.document.querySelector('[aria-label="交接接手者"]') as any;
    assert.doesNotMatch(select.textContent, /Custom shell/);
    assert.doesNotMatch(select.textContent, /Codex-impl.*閒置/);
    select.value = 'pane:wE:p3'; select.dispatchEvent(new f.window.Event('change'));
    f.click('.task-submit-handoff');
    const request = f.sent.find((message) => message.type === 'requestHandoff');
    assert.deepEqual(structuredClone(request.target), { paneId: 'wE:p3' });
    f.emit({ type: 'taskOperation', kind: 'handoff', tabId: 'wE:t1', operationId: request.operationId });
    assert.match(f.document.querySelector('.task-planner')!.textContent, /Claude/);
    assert.equal(f.document.querySelector('.task-confirmed'), null, '送達不是接手確認');
    f.task.status = 'handoff_pending';
    f.task.handoffs.push({ id: 'H-01', generation: 2, from: f.planner, target: f.reviewer, status: 'awaiting_accept', createdAt: '2026-01-01T10:03:00Z', checkpoint: '待處理：R-01，保留原 request' });
    f.emitTasks();
    assert.match(f.document.querySelector('.task-planner')!.textContent, /原規劃者：Claude · 交接暫停/);
    assert.equal(f.input().disabled, true);
    assert.equal(f.document.querySelector<DOMButton>('.save-message-memory')!.disabled, false, '唯讀歷史仍能保存記憶');
    f.click('[data-task-page="collaboration"]');
    assert.match(f.document.querySelector('.task-reply-route')!.textContent, /暫存於本問題/);
    assert.match(f.document.querySelector('.task-request-heading')!.textContent, /Claude.*Codex-impl/);
    f.task.status = 'active'; f.task.planner = f.reviewer; f.task.generation = 2;
    f.task.handoffs[0].status = 'accepted'; f.task.handoffs[0].acceptedAt = '2026-01-01T10:04:00Z';
    f.task.events.push({ id: 'event-accepted', at: '2026-01-01T10:04:00Z', type: 'handoff_accepted', text: 'Reviewer 確認接手規劃', paneId: 'wE:p3' });
    f.emitTasks();
    assert.match(f.document.querySelector('.task-planner')!.textContent, /規劃者：Reviewer/);
    assert.match(f.document.querySelector('.task-confirmed')!.textContent, /已回報接手/);
    assert.match(f.document.querySelector('.task-reply-route')!.textContent, /Reviewer/);
    assert.match(f.document.querySelector('.task-request-heading')!.textContent, /Claude.*Codex-impl/);
    assert.equal(f.document.querySelector('[data-request-id="R-01"]') !== null, true);
    f.click('[data-task-page="chat"]');
    assert.equal(f.input().disabled, true, '舊規劃者接手後保留唯讀');
    f.click('[data-agent-pane="wE:p3"]');
    assert.equal(f.input().disabled, false, '新規劃者可以繼續對話');
  } finally { await f.window.happyDOM.close(); }
});

test('原生 done、等待逾時與 needs_input 均不被當成完成', async () => {
  const f = collaborationFixture();
  try {
    f.task.requests[0].status = 'awaiting_report'; f.task.requests[0].runtimeStatus = 'done'; f.emitTasks();
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '等待明確回報');
    assert.match(f.document.querySelector('.task-runtime-status')!.textContent, /done/);
    f.task.requests[0].status = 'wait_expired'; f.emitTasks();
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '等待逾時 · 結果未知');
    f.task.requests[0].status = 'needs_input';
    f.task.requests[0].report = { status: 'needs_input', text: '是否保留舊 API？', at: '2026-01-01T10:05:00Z', reportId: 'report-1' };
    f.emitTasks();
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '等待規劃者回應');
    f.edit('.task-answer-text', '保留舊 API').focus();
    f.task.events.push({ id: 'unrelated-update', type: 'state_changed', text: '背景狀態更新', at: '2026-01-01T10:05:01Z' }); f.emitTasks();
    f.button('送出補充').click();
    const answer = f.sent.find((message) => message.type === 'answerTaskRequest');
    assert.equal(answer.requestId, 'R-01'); assert.equal(answer.text, '保留舊 API');
    assert.doesNotMatch(f.document.querySelector('.task-request-status')!.textContent, /完成/);
    f.document.querySelector<DOMButton>('.task-request .task-pane-link')!.click();
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-page'), 'chat');
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-pane-id'), f.paneId);
  } finally { await f.window.happyDOM.close(); }
});

test('尚未啟用規劃的問題也能保存記憶，協作入口要明確啟用', async () => {
  const f = collaborationFixture();
  try {
    f.task.enabled = false; f.task.requests = []; f.emitTasks();
    assert.match(f.document.querySelector('.task-planner')!.textContent, /尚未啟用/);
    f.click('.save-message-memory');
    assert.ok(f.document.querySelector('.task-memory-editor'));
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-dispatch-form'), null);
    f.button('以 claude 規劃').click();
    const enable = f.sent.find((message) => message.type === 'assignPlanner');
    assert.equal(enable.tabId, 'wE:t1'); assert.equal(enable.paneId, f.paneId);
  } finally { await f.window.happyDOM.close(); }
});

test('派工只提供可自動協作的 preset，失敗時保留工作內容', async () => {
  const f = collaborationFixture();
  try {
    f.click('[data-task-page="collaboration"]');
    const select = f.document.querySelector('[aria-label="派工執行者"]') as any;
    assert.match(select.textContent, /新建 Codex/);
    assert.doesNotMatch(select.textContent, /Custom shell/);
    select.value = 'preset:codex'; select.dispatchEvent(new f.window.Event('change'));
    f.edit('#task-dispatch-text', '重構 auth，不修改公開 API，跑完測試再回報。');
    f.click('.task-submit-dispatch');
    const operation = f.sent.find((message) => message.type === 'delegateTask');
    assert.deepEqual(structuredClone(operation.target), { presetId: 'codex' });
    assert.equal(operation.tabId, 'wE:t1');
    f.emit({ type: 'taskOperation', kind: 'delegate', tabId: 'wE:t1', operationId: operation.operationId, error: 'agent 啟動失敗' });
    assert.equal(f.document.querySelector<DOMTextArea>('#task-dispatch-text')!.value, operation.text);
    assert.match(f.document.querySelector('.task-dispatch-form')!.textContent, /啟動失敗/);
    assert.equal((f.document.querySelector('.task-dispatch-form') as any).open, true);
    f.button('複製協作入口').click();
    assert.equal(f.sent.filter((message) => message.type === 'copyCollaborationPrompt').at(-1).tabId, 'wE:t1');
  } finally { await f.window.happyDOM.close(); }
});

test('已關閉問題的歷史仍能讀取協作與記憶，沒有執行操作', async () => {
  const f = collaborationFixture();
  try {
    const archived = { ...structuredClone(f.task), id: 'old-task', tabId: 'wE:t-old', title: '已結束的登入問題', status: 'archived' };
    const otherCheckout = { ...structuredClone(archived), id: 'other-checkout', tabId: 'wE:t-other', checkoutPath: '/tmp/other-worktree', title: '其他 worktree 的問題' };
    f.emitTasks([f.task, archived, otherCheckout]);
    f.click('[aria-label="歷史紀錄"]');
    assert.match(f.document.querySelector('.task-archive-list')!.textContent, /已結束的登入問題/);
    assert.doesNotMatch(f.document.querySelector('.task-archive-list')!.textContent, /其他 worktree/);
    f.click('[data-archive-tab="wE:t-old"]');
    assert.match(f.document.querySelector('.task-planner')!.textContent, /已封存.*唯讀紀錄/);
    assert.equal(f.document.querySelector('.task-agents'), null);
    assert.equal(f.document.querySelector('.task-dispatch-form'), null);
    assert.equal(f.document.querySelector<DOMButton>('[data-task-page="chat"]')!.disabled, true);
    assert.match(f.document.querySelector('.task-records')!.textContent, /R-01/);
    f.click('[data-task-page="memory"]');
    assert.match(f.document.querySelector('.task-content')!.textContent, /Claude-mem #42/);
    assert.equal(f.document.querySelector('.task-submit-handoff'), null);
  } finally { await f.window.happyDOM.close(); }
});

test('協作背景更新保留佇列編輯與附加檔案', async () => {
  const f = collaborationFixture();
  try {
    f.transcript.queue = [{ id: 17, text: '稍後執行', attachments: ['/tmp/original.ts'] }]; f.updateTranscript();
    f.click('[aria-label="修改第 1 則佇列訊息"]');
    const editor = f.document.querySelector<DOMTextArea>('.queue-editor textarea')!;
    editor.value = '修改後的佇列內容'; editor.dispatchEvent(new f.window.Event('input')); editor.focus();
    f.task.events.push({ id: 'later-event', type: 'state_changed', text: '另一個 worker 更新', at: '2026-01-01T10:06:00Z' });
    f.emitTasks(); f.updateState();
    assert.ok(f.document.querySelector('.queue-editor textarea') === editor);
    assert.equal(editor.value, '修改後的佇列內容');
    f.button('儲存修改').click();
    assert.equal(f.sent.find((message) => message.type === 'updateQueued')?.text, '修改後的佇列內容');
    f.emit({ type: 'queuedUpdated', paneId: f.paneId, id: 17 });
    f.emit({ type: 'attachments', paneId: f.paneId, paths: ['/tmp/prompt.md'] });
    assert.match(f.document.querySelector('.chips')!.textContent, /prompt.md/);
    f.updateState(); f.emitTasks();
    assert.match(f.document.querySelector('.chips')!.textContent, /prompt.md/);
  } finally { await f.window.happyDOM.close(); }
});

test('規劃者入口傳送未確認時提供複製恢復，不宣告成功或自動重送', async () => {
  const f = collaborationFixture();
  try {
    f.task.plannerDelivery = { status: 'sending', at: '2026-01-01T10:01:00Z' }; f.emitTasks();
    assert.equal(f.document.querySelector('.task-planner-delivery')!.textContent, '協作入口傳送中');
    assert.equal(f.button('交接規劃者').disabled, true);
    f.task.plannerDelivery = { status: 'uncertain', at: '2026-01-01T10:02:00Z', error: 'Socket timeout' }; f.emitTasks();
    assert.match(f.document.querySelector('.task-planner-delivery')!.textContent, /結果未確認/);
    assert.match(f.document.querySelector('.task-delivery-uncertain')!.textContent, /status/);
    assert.match(f.document.querySelector('.task-delivery-uncertain')!.textContent, /Socket timeout/);
    assert.equal(f.document.querySelector('.task-confirmed'), null);
    assert.equal(f.sent.filter((message) => message.type === 'assignPlanner').length, 0);
    f.button('複製協作入口').click();
    assert.equal(f.sent.filter((message) => message.type === 'copyCollaborationPrompt').length, 1);
    assert.equal(f.sent.filter((message) => message.type === 'assignPlanner').length, 0);
    assert.equal(Array.from(f.document.querySelectorAll('button')).some((button) => /重送|重新傳送/.test(button.textContent)), false);
    f.task.plannerDelivery = { status: 'sent', at: '2026-01-01T10:03:00Z' }; f.emitTasks();
    assert.equal(f.document.querySelector('.task-planner-delivery')!.textContent, '協作入口已送出');
    assert.equal(f.document.querySelector('.task-delivery-uncertain'), null);
  } finally { await f.window.happyDOM.close(); }
});

test('交接失敗且舊規劃凍結時，可重新取得快照並選擇接手者', async () => {
  const f = collaborationFixture();
  try {
    f.task.status = 'handoff_pending';
    f.task.handoffs = [{ id: 'H-failed', generation: 2, from: f.planner, status: 'failed', createdAt: '2026-01-01T10:03:00Z', checkpoint: '', error: '新 agent 尚未就緒' }];
    f.emitTasks();
    assert.equal(f.input().disabled, true);
    assert.match(f.document.querySelector('.task-notice')!.textContent, /交接失敗.*重新選擇接手者/);
    f.button('查看交接').click();
    const preparation = f.sent.filter((message) => message.type === 'prepareHandoff').at(-1);
    assert.ok(preparation, '失敗時仍可以取得可讀快照');
    f.emit({ type: 'taskOperation', kind: 'checkpoint', tabId: 'wE:t1', operationId: preparation.operationId, checkpoint: '重新擷取：原 R-01 仍在執行，原規劃已暫停。' });
    assert.match(f.document.querySelector('.task-checkpoint')!.textContent, /重新擷取/);
    const select = f.document.querySelector('[aria-label="交接接手者"]') as any;
    assert.ok(select, '交接失敗不能把接手者選單鎖住');
    select.value = 'pane:wE:p3'; select.dispatchEvent(new f.window.Event('change'));
    assert.equal(f.document.querySelector<DOMButton>('.task-submit-handoff')!.disabled, false);
    f.click('.task-submit-handoff');
    const retry = f.sent.filter((message) => message.type === 'requestHandoff');
    assert.equal(retry.length, 1); assert.deepEqual(structuredClone(retry[0].target), { paneId: 'wE:p3' });
    assert.equal(f.document.querySelector('.task-submit-handoff'), null, '送出下一次交接後不能重複提交');
    assert.equal(f.input().disabled, true, '重試不恢復舊規劃權');
    assert.match(f.document.querySelector('.task-planner')!.textContent, /原規劃者：Claude/);
    assert.equal(f.document.querySelector('.task-confirmed'), null);
    assert.equal(f.task.requests[0].id, 'R-01');
    f.emit({ type: 'taskOperation', kind: 'handoff', tabId: 'wE:t1', operationId: retry[0].operationId, error: '尚未建立新交接，請重試' });
    assert.ok(f.document.querySelector('[aria-label="交接接手者"]'), '新交接尚未建立就失敗時仍可恢復選擇');
    assert.equal(f.input().disabled, true);
  } finally { await f.window.happyDOM.close(); }
});

test('原生權限等待不提供 answer，派送失敗與 worker 失敗回報有不同標示', async () => {
  const f = collaborationFixture();
  try {
    const request = f.task.requests[0];
    request.status = 'needs_input'; request.runtimeStatus = 'blocked'; request.error = '原生 agent 等待權限或選單';
    delete request.report; f.emitTasks();
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /等待原生權限或選單/);
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-answer-text'), null);
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '等待原生權限或選單');
    f.button('前往 pane 處理').click();
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-pane-id'), 'wE:p2');
    assert.equal(f.sent.filter((message) => message.type === 'answerTaskRequest').length, 0);

    request.status = 'failed'; request.error = '送出前原 session 已不存在'; f.emitTasks();
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /派送失敗/);
    assert.doesNotMatch(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /已回報失敗/);
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '派送失敗');
    request.report = { status: 'failed', text: '測試環境無法啟動，未完成驗證。', at: '2026-01-01T10:05:00Z', reportId: 'failed-report' }; f.emitTasks();
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '已回報失敗');
    f.click('[data-task-page="chat"]');
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /已回報失敗/);
  } finally { await f.window.happyDOM.close(); }
});

test('English display language localizes navigation, accessibility and memory controls while preserving user content', async () => {
  const f = collaborationFixture('en-US');
  try {
    assert.deepEqual(Array.from(f.document.querySelectorAll('.task-tab')).map((item) => item.textContent), ['Chat', 'Collaboration', 'Memory']);
    assert.equal(f.input().getAttribute('aria-label'), 'Message');
    assert.match(f.input().placeholder, /Working: Enter to queue/);
    assert.equal(f.document.querySelector('.send-button')!.getAttribute('aria-label'), 'Queue message');
    assert.match(f.document.querySelector('.task-planner')!.textContent, /Planner: Claude/);
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /Running/);

    const original = '取消 / Save as memory / {0} / /專案/auth.ts';
    f.transcript.messages = [{ role: 'assistant', text: original }]; f.updateTranscript();
    assert.equal(f.document.querySelector('.assistant-message')?.textContent?.includes(original) ?? f.messages().textContent.includes(original), true);
    f.button('Save as memory').click();
    assert.equal(f.document.querySelector('#task-memory-title')!.getAttribute('aria-label'), 'Memory title');
    assert.equal(f.document.querySelector<DOMTextArea>('#task-memory-text')!.value, original);
    f.button('Save to Claude-mem').click();
    const saved = f.sent.filter((message) => message.type === 'saveTaskMemory').at(-1);
    assert.equal(saved.text, original);
    assert.equal(saved.source.text, original);
    f.emit({ type: 'taskOperation', kind: 'memory', tabId: f.task.tabId, operationId: saved.operationId, memoryId: 100 });
    assert.equal(f.document.querySelector('.task-feedback')!.textContent, 'Saved to Claude-mem · memory #100');

    f.task.requests[0].report = { status: 'needs_input', text: '請保留「取消」原文', at: '2026-01-01T10:01:00Z', reportId: 'report-1' };
    f.task.requests[0].status = 'needs_input'; f.emitTasks();
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, 'Awaiting planner response');
    assert.equal(f.document.querySelector('.task-request-prompt')!.textContent, '重構 auth 並回報測試結果');
    assert.match(f.document.querySelector('.task-request-report')!.textContent, /Clarification needed請保留「取消」原文/);
    assert.equal(f.document.querySelector('.task-answer-text')!.getAttribute('aria-label'), 'Reply to R-01');
    f.click('[data-task-page="memory"]');
    assert.equal(f.document.querySelector('.task-memory-reference strong')!.textContent, '保留 401 格式');
    assert.equal(f.document.querySelector('.task-memory-text')!.textContent, '不變更對外 API');
    assert.equal(f.document.querySelector('.task-memory-reference time')!.textContent, new Date('2026-01-01T10:01:00Z').toLocaleString('en'));
  } finally { await f.window.happyDOM.close(); }
});

test('webview uses the host language rather than navigator language and falls back to English', async () => {
  for (const language of ['fr-FR', 'zh-CN', '']) {
    const f = fixture(language, 'zh-TW');
    try {
      assert.equal(f.document.querySelector('[data-task-page="chat"]')!.textContent, 'Chat', `fallback for ${language}`);
      assert.equal(f.input().getAttribute('aria-label'), 'Message');
      assert.equal(f.document.querySelector('[title="Scroll to latest message"]') !== null, true);
    } finally { await f.window.happyDOM.close(); }
  }
  for (const language of ['zh-Hant', 'zh-HK']) {
    const f = fixture(language, 'en-US');
    try {
      assert.equal(f.document.querySelector('[data-task-page="chat"]')!.textContent, '對話');
      assert.equal(f.input().getAttribute('aria-label'), '訊息');
    } finally { await f.window.happyDOM.close(); }
  }
});

test('persisted system messages render in the current language without translating historical user reports', async () => {
  for (const language of ['en', 'zh-TW']) {
    const f = collaborationFixture(language);
    try {
      const agentName = '自訂 agent {0}';
      f.task.events.push({ id: 'localized-event', type: 'state_changed', at: '2026-01-01T10:02:00Z', text: '舊語言文字', localization: { message: 'Planner: {0}', args: [agentName] } });
      f.task.events.push({ id: 'original-event', type: 'reported', at: '2026-01-01T10:02:00Z', text: 'Cancel / 取消 / {0}' });
      f.task.requests[0].error = '保存於舊語言的錯誤';
      f.task.requests[0].errorLocalization = { message: 'No checkpoint available yet' };
      f.emitTasks(); f.click('[data-task-page="collaboration"]');
      assert.equal(f.document.querySelector('[data-event-id="localized-event"] p')!.textContent, `${language === 'en' ? 'Planner: ' : '規劃者：'}${agentName}`);
      assert.equal(f.document.querySelector('[data-event-id="original-event"] p')!.textContent, 'Cancel / 取消 / {0}');
      assert.equal(f.document.querySelector('.task-request .task-inline-error')!.textContent, language === 'en' ? 'No checkpoint available yet' : '尚未取得快照');
      assert.equal(f.task.events.at(-2).text, '舊語言文字', 'rendering must not rewrite stored history');
      assert.equal(f.task.requests[0].error, '保存於舊語言的錯誤');
    } finally { await f.window.happyDOM.close(); }
  }
});
