import { build } from 'esbuild';
import { Window, type HTMLButtonElement as DOMButton, type HTMLDetailsElement as DOMDetails, type HTMLElement as DOMElement, type HTMLTextAreaElement as DOMTextArea } from 'happy-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

function queueFixture(attachments: string[] = []) {
  const f = fixture();
  f.transcript.queue = [{ id: 7, text: '原本的佇列訊息', attachments }]; f.updateTranscript();
  return { ...f, edit() { f.document.querySelector<DOMButton>('button[aria-label="修改第 1 則佇列訊息"]')!.click(); } };
}

test('修改佇列時沿用原輸入框、帶入訊息並聚焦，紙飛機改成編輯圖示', async () => {
  const f = queueFixture();
  try {
    const input = f.input(); f.edit();
    assert.ok(f.input() === input);
    assert.equal(f.document.querySelectorAll('textarea').length, 1);
    assert.ok(f.document.activeElement === input);
    assert.equal(input.value, '原本的佇列訊息');
    const button = f.document.querySelector<DOMButton>('.send-button')!;
    assert.ok(button.querySelector('.icon-edit'));
    assert.equal(button.getAttribute('aria-label'), '儲存修改');
    assert.equal(button.querySelector('.icon-send'), null);
  } finally { await f.window.happyDOM.close(); }
});

test('編輯按鈕更新原佇列，不新增訊息；成功後還原草稿與紙飛機', async () => {
  const f = queueFixture();
  try {
    const input = f.input(); input.value = '尚未送出的草稿'; input.dispatchEvent(new f.window.Event('input')); f.edit();
    input.value = '修改後的訊息'; input.dispatchEvent(new f.window.Event('input'));
    const save = f.document.querySelector<DOMButton>('.send-button')!; save.click(); save.click();
    assert.deepEqual(structuredClone(f.sent.filter((message) => message.type === 'updateQueued')), [{ type: 'updateQueued', paneId: f.paneId, id: 7, text: '修改後的訊息' }]);
    assert.equal(f.sent.filter((message) => message.type === 'send').length, 0);
    assert.equal(f.input().readOnly, true);
    f.transcript.queue[0].text = '修改後的訊息'; f.updateTranscript();
    f.emit({ type: 'queuedUpdated', paneId: f.paneId, id: 7 });
    assert.ok(f.input() === input);
    assert.equal(input.value, '尚未送出的草稿');
    assert.equal(input.readOnly, false);
    assert.ok(f.document.querySelector('.send-button .icon-send'));
  } finally { await f.window.happyDOM.close(); }
});

test('Esc 取消修改並還原草稿，不會中斷 agent', async () => {
  const f = queueFixture();
  try {
    const input = f.input(); input.value = '我的草稿'; input.dispatchEvent(new f.window.Event('input')); f.edit();
    input.value = '不儲存的修改'; input.dispatchEvent(new f.window.Event('input'));
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(input.value, '我的草稿');
    assert.ok(f.document.querySelector('.send-button .icon-send'));
    assert.equal(f.sent.filter((message) => message.type === 'interrupt' || message.type === 'updateQueued').length, 0);
  } finally { await f.window.happyDOM.close(); }
});

test('Enter 儲存佇列修改，Shift+Enter 保留換行操作', async () => {
  const f = queueFixture();
  try {
    f.edit(); const input = f.input();
    input.value = '第一行\n第二行'; input.dispatchEvent(new f.window.Event('input'));
    const newline = new f.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(newline); assert.equal(newline.defaultPrevented, false);
    assert.equal(f.sent.filter((message) => message.type === 'updateQueued').length, 0);
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(f.sent.find((message) => message.type === 'updateQueued')?.text, '第一行\n第二行');
    assert.equal(f.sent.filter((message) => message.type === 'send').length, 0);
  } finally { await f.window.happyDOM.close(); }
});

test('儲存失敗或內容空白時，保留修改文字並在原輸入框顯示錯誤', async () => {
  const f = queueFixture();
  try {
    f.edit(); const input = f.input();
    input.value = '   '; input.dispatchEvent(new f.window.Event('input')); f.document.querySelector<DOMButton>('.send-button')!.click();
    assert.equal(f.sent.filter((message) => message.type === 'updateQueued').length, 0);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    input.value = '要保留的修改'; input.dispatchEvent(new f.window.Event('input'));
    assert.notEqual(input.getAttribute('aria-invalid'), 'true');
    f.document.querySelector<DOMButton>('.send-button')!.click();
    f.emit({ type: 'queuedUpdated', paneId: f.paneId, id: 7, error: '暫時無法更新' });
    assert.equal(input.value, '要保留的修改');
    assert.equal(input.readOnly, false);
    assert.ok(f.document.querySelector('.send-button .icon-edit'));
    assert.match(f.document.querySelector('.queue-edit-error')!.textContent, /暫時無法更新/);
  } finally { await f.window.happyDOM.close(); }
});

test('訊息已送出時，保留修改內容，可明確轉成新訊息而不會自動送出', async () => {
  const f = queueFixture();
  try {
    const input = f.input(); input.value = '原來的草稿'; input.dispatchEvent(new f.window.Event('input')); f.edit();
    input.value = '仍要保留的修改'; input.dispatchEvent(new f.window.Event('input'));
    f.transcript.queue = []; f.updateTranscript();
    assert.equal(input.value, '仍要保留的修改');
    assert.equal(f.document.querySelector<DOMButton>('.send-button')!.disabled, true);
    f.document.querySelector<DOMButton>('button[aria-label="保留為新訊息"]')!.click();
    assert.equal(input.value, '原來的草稿\n\n仍要保留的修改');
    assert.ok(f.document.querySelector('.send-button .icon-send'));
    assert.equal(f.sent.filter((message) => message.type === 'send' || message.type === 'updateQueued').length, 0);
  } finally { await f.window.happyDOM.close(); }
});

test('修改佇列時保留原附件，取消後還原草稿附件', async () => {
  const f = queueFixture(['/tmp/queued.md']);
  try {
    f.emit({ type: 'attachments', paneId: f.paneId, paths: ['/tmp/draft.md'] }); f.edit();
    assert.match(f.document.querySelector('.chips')!.textContent, /queued.md/);
    assert.equal(f.document.querySelector('.chips .chip-remove'), null);
    assert.equal(f.document.querySelector<DOMButton>('button[aria-label="附加檔案"]')!.disabled, true);
    f.document.querySelector<DOMButton>('button[aria-label="取消修改"]')!.click();
    assert.match(f.document.querySelector('.chips')!.textContent, /draft.md/);
    assert.doesNotMatch(f.document.querySelector('.chips')!.textContent, /queued.md/);
    assert.ok(f.document.querySelector('.chips .chip-remove'));
  } finally { await f.window.happyDOM.close(); }
});

test('修改佇列的中文組字與背景更新保留同一輸入框，不會誤存未完成文字', async () => {
  const f = queueFixture();
  try {
    f.edit(); const input = f.input(); input.focus();
    input.dispatchEvent(new f.window.CompositionEvent('compositionstart'));
    input.value = '中文組字中'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: true }));
    f.transcript.usage.contextTokens++; f.updateTranscript();
    assert.ok(f.input() === input && f.document.activeElement === input);
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
    f.document.querySelector<DOMButton>('.send-button')!.click();
    assert.equal(f.sent.filter((message) => message.type === 'send' || message.type === 'updateQueued').length, 0);
    input.dispatchEvent(new f.window.CompositionEvent('compositionend'));
    input.value = '中文修改完成'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: false }));
    await new Promise((resolve) => f.window.setTimeout(resolve, 10));
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.sent.find((message) => message.type === 'updateQueued')?.text, '中文修改完成');
  } finally { await f.window.happyDOM.close(); }
});

test('共用送出表單後，附加檔案與模型選單不會誤送訊息', async () => {
  const f = fixture();
  try {
    f.state.presets = [{ id: 'claude', label: 'Claude', models: ['opus', 'sonnet'], efforts: [], canSwitchModel: true, canSwitchEffort: false }];
    f.state.tabs[0].agents[0].presetId = 'claude'; f.updateState();
    const input = f.input(); input.value = '尚未送出的草稿'; input.dispatchEvent(new f.window.Event('input'));
    f.document.querySelector<DOMButton>('button[aria-label="附加檔案"]')!.click();
    assert.equal(f.sent.filter((message) => message.type === 'pickFiles').length, 1);
    f.document.querySelector<DOMButton>('.chip-picker')!.click();
    f.document.querySelectorAll<DOMButton>('.picker-option')[1].click();
    assert.equal(f.sent.filter((message) => message.type === 'send').length, 0);
    assert.equal(input.value, '尚未送出的草稿');
  } finally { await f.window.happyDOM.close(); }
});

test('切換 pane 後，各自保留佇列修改內容與原本草稿', async () => {
  const f = queueFixture();
  try {
    const input = f.input(); input.value = '第一個 pane 的草稿'; input.dispatchEvent(new f.window.Event('input')); f.edit();
    input.value = '第一個 pane 的修改'; input.dispatchEvent(new f.window.Event('input'));
    f.emit({ type: 'openedPane', paneId: 'wE:p2' });
    f.emit({ type: 'transcript', transcript: { ...structuredClone(f.transcript), paneId: 'wE:p2' } });
    assert.equal(f.input().value, '');
    assert.ok(f.document.querySelector('.send-button .icon-send'));
    f.emit({ type: 'openedPane', paneId: f.paneId });
    assert.equal(f.input().value, '第一個 pane 的修改');
    assert.doesNotMatch(f.document.querySelector('.composer-mode')!.textContent, /已送出或移除/);
    f.updateTranscript();
    f.document.querySelector<DOMButton>('button[aria-label="取消修改"]')!.click();
    assert.equal(f.input().value, '第一個 pane 的草稿');
  } finally { await f.window.happyDOM.close(); }
});

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
    f.emit({ type: 'navigate', view: 'history' });
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
    f.click('[data-task-page="chat"]');
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
    f.click('[data-agent-pane="wE:p1"]');
    assert.equal(f.input().disabled, true, '舊規劃者接手後保留唯讀');
    f.click('[data-task-page="chat"]');
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

test('停用的 preset 不提供新建協作 agent，但仍可選擇已存在的閒置 agent', async () => {
  const f = collaborationFixture();
  try {
    f.state.presets[0].enabled = false; f.updateState();
    f.click('[data-task-page="collaboration"]');
    const select = f.document.querySelector('[aria-label="派工執行者"]')!;
    assert.doesNotMatch(select.textContent, /新建 Codex/);
    assert.match(select.textContent, /Reviewer/);
    assert.equal(select.querySelector('option[value="preset:codex"]'), null);
    assert.ok(select.querySelector('option[value="pane:wE:p3"]'));
  } finally { await f.window.happyDOM.close(); }
});

test('已關閉問題的歷史仍能讀取協作與記憶，沒有執行操作', async () => {
  const f = collaborationFixture();
  try {
    const archived = { ...structuredClone(f.task), id: 'old-task', tabId: 'wE:t-old', title: '已結束的登入問題', status: 'archived' };
    const otherCheckout = { ...structuredClone(archived), id: 'other-checkout', tabId: 'wE:t-other', checkoutPath: '/tmp/other-worktree', title: '其他 worktree 的問題' };
    f.emitTasks([f.task, archived, otherCheckout]);
    f.emit({ type: 'navigate', view: 'history' });
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
    const editor = f.input();
    editor.value = '修改後的佇列內容'; editor.dispatchEvent(new f.window.Event('input')); editor.focus();
    f.task.events.push({ id: 'later-event', type: 'state_changed', text: '另一個 worker 更新', at: '2026-01-01T10:06:00Z' });
    f.emitTasks(); f.updateState();
    assert.ok(f.input() === editor);
    assert.equal(editor.value, '修改後的佇列內容');
    f.document.querySelector<DOMButton>('.send-button')!.click();
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
    f.click('[data-task-page="chat"]');
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /等待原生權限或選單/);
    f.click('[data-task-page="collaboration"]');
    assert.equal(f.document.querySelector('.task-answer-text'), null);
    assert.equal(f.document.querySelector('.task-request-status')!.textContent, '等待原生權限或選單');
    f.button('前往 pane 處理').click();
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-pane-id'), 'wE:p2');
    assert.equal(f.sent.filter((message) => message.type === 'answerTaskRequest').length, 0);

    request.status = 'failed'; request.error = '送出前原 session 已不存在'; f.emitTasks();
    f.click('[data-task-page="chat"]');
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
    assert.deepEqual(Array.from(f.document.querySelectorAll('.task-page-item')).map((item) => item.textContent), ['Chat', 'Collaboration', 'Memory']);
    assert.equal(f.input().getAttribute('aria-label'), 'Message');
    assert.match(f.input().placeholder, /Working: Enter to queue/);
    assert.equal(f.document.querySelector('.send-button')!.getAttribute('aria-label'), 'Queue message');
    assert.match(f.document.querySelector('.task-planner')!.textContent, /Planner: Claude/);
    f.click('[data-task-page="chat"]');
    assert.match(f.document.querySelector('[data-agent-pane="wE:p2"]')!.textContent, /Running/);
    f.click('[data-agent-pane="wE:p1"]');

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
test('chat 的佇列編輯、工具紀錄、驗證提示與可存取標籤使用目前語言', async () => {
  for (const language of ['en-US', 'zh-TW']) {
    const english = language === 'en-US';
    const f = fixture(language);
    try {
      f.transcript.messages = [
        { role: 'user', text: '使用者的原文 {0}' },
        { role: 'tool', tool: 'Bash', text: '工具原文' },
        { role: 'tool', tool: 'Read', text: '/tmp/中文路徑' },
        { role: 'assistant', text: '助理的原文 {0}' },
      ];
      f.transcript.queue = [{ id: 7, text: '佇列的原文 {0}', attachments: [] }]; f.updateTranscript();
      assert.equal(f.document.querySelector('.turn-log > summary .tool-count')!.textContent, english ? 'Thinking…' : '思考中…');
      f.state.tabs[0].agents[0].status = 'idle'; f.updateState();
      assert.equal(f.document.querySelector('.turn-log > summary .tool-count')!.textContent, english ? 'Thought · 2 steps' : '已思考 · 2 個步驟');
      assert.equal(f.document.querySelector('.tool-command-group > summary')!.textContent, english ? 'Ran commands Read files · 2 steps' : '執行了指令 已讀取檔案 · 2 個步驟');
      f.transcript.messages[0].timestamp = 1000; f.transcript.messages[3].timestamp = 5000; f.updateTranscript();
      assert.equal(f.document.querySelector('.turn-log > summary .tool-count')!.textContent, english ? 'Processed in 4s · 2 steps' : '處理耗時 4s · 2 個步驟');
      assert.match(f.messages().textContent, /使用者的原文 \{0\}/);
      assert.match(f.messages().textContent, /助理的原文 \{0\}/);
      const label = english ? 'Edit queued message 1' : '修改第 1 則佇列訊息';
      f.document.querySelector<DOMButton>(`button[aria-label="${label}"]`)!.click();
      assert.equal(f.document.querySelector('.queue-edit-heading label')!.textContent, label);
      assert.equal(f.input().value, '佇列的原文 {0}');
      assert.equal(f.input().placeholder, english ? 'Edit queued message (Enter to save, Shift+Enter for a new line)' : '修改佇列訊息（Enter 儲存，Shift+Enter 換行）');
      assert.equal(f.document.querySelector('.send-button')!.getAttribute('aria-label'), english ? 'Save changes' : '儲存修改');
      f.input().value = ''; f.input().dispatchEvent(new f.window.Event('input'));
      f.document.querySelector<DOMButton>('.send-button')!.click();
      assert.equal(f.document.querySelector('.queue-edit-error')!.textContent, english ? 'Enter a message.' : '請輸入訊息。');
      if (english) assert.doesNotMatch(f.document.querySelector('.composer-mode')!.textContent, /\p{Script=Han}/u);
      f.transcript.queue = []; f.updateTranscript();
      assert.equal(f.document.querySelector('.queue-edit-help')!.textContent, english ? 'This message has been sent or removed. Your edits are still in the composer.' : '這則訊息已送出或移除。修改內容仍保留在輸入框。');
      assert.ok(f.document.querySelector(`button[aria-label="${english ? 'Keep as new message' : '保留為新訊息'}"]`));
    } finally { await f.window.happyDOM.close(); }
  }
});

test('使用者與助理訊息都能保存記憶，並保留正確的原始訊息索引', async () => {
  const f = collaborationFixture('en-US');
  try {
    f.transcript.messages = [
      { role: 'user', text: '保存這段使用者原文。' },
      { role: 'tool', tool: 'Bash', text: 'pwd' },
      { role: 'assistant', text: '保存這段助理原文。' },
    ]; f.updateTranscript();
    for (const [selector, index] of [['.turn.user', 0], ['.turn.assistant', 2]] as const) {
      f.click(`${selector} .save-message-memory`);
      f.button('Save to Claude-mem').click();
      const saved = f.sent.filter((message) => message.type === 'saveTaskMemory').at(-1);
      assert.equal(saved.source.messageIndex, index);
      assert.equal(saved.source.text, f.transcript.messages[index].text);
      f.emit({ type: 'taskOperation', kind: 'memory', tabId: f.task.tabId, operationId: saved.operationId, memoryId: 100 + index });
    }
  } finally { await f.window.happyDOM.close(); }
});

test('規劃者在中文組字期間轉為唯讀時，鍵盤與表單都不可送出佇列修改', async () => {
  const f = collaborationFixture();
  try {
    f.transcript.queue = [{ id: 7, text: '保留這則佇列', attachments: [] }]; f.updateTranscript();
    f.click('[aria-label="修改第 1 則佇列訊息"]');
    const input = f.input(); input.dispatchEvent(new f.window.CompositionEvent('compositionstart'));
    input.value = '正在組字'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: true }));
    f.task.status = 'handoff_pending'; f.emitTasks();
    input.dispatchEvent(new f.window.CompositionEvent('compositionend'));
    input.value = '保留完成的中文修改'; input.dispatchEvent(new f.window.InputEvent('input', { isComposing: false }));
    input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    f.document.querySelector('form.chat-input')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(f.sent.filter((message) => message.type === 'send' || message.type === 'updateQueued').length, 0);
    await new Promise((resolve) => f.window.setTimeout(resolve, 10));
    assert.equal(input.disabled, true);
    assert.equal(input.value, '保留完成的中文修改');
    assert.ok(Array.from(f.document.querySelectorAll<DOMButton>('.composer button')).every((button) => button.disabled));
  } finally { await f.window.happyDOM.close(); }
});

test('工作中手動展開執行紀錄，完成後自動摺疊，並保留一般回覆', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [
      { role: 'user', text: '上一個任務', timestamp: 1_000_000 },
      { role: 'tool', tool: 'Bash', text: 'pwd', timestamp: 1_003_000 },
      { role: 'assistant', text: '上一個任務完成。', timestamp: 1_008_000 },
      { role: 'user', text: '執行測試', timestamp: 2_000_000 },
      { role: 'tool', tool: 'Bash', text: 'npm test', timestamp: 2_030_000 },
      { role: 'tool', tool: 'Bash', text: 'npm run typecheck', timestamp: 2_132_000 },
      { role: 'assistant', text: '測試全部通過。', timestamp: 2_132_000 },
    ];
    f.updateTranscript();
    let groups = f.document.querySelectorAll<DOMDetails>('.turn-log');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].open, false, '歷史回合保持摺疊');
    assert.equal(groups[1].open, false, '沿用工具區塊預設摺疊的樣式');
    assert.match(groups[0].querySelector('summary')!.textContent, /8s/);
    groups[1].open = true;
    const cmdGroup = groups[1].querySelector<DOMDetails>('.tool-command-group')!;
    assert.ok(cmdGroup, '外層執行紀錄內包含指令摺疊區塊');
    assert.equal(cmdGroup.open, false, '內層指令區塊預設摺疊');
    cmdGroup.open = true;
    assert.equal(groups[1].querySelectorAll('.tool').length, 2);
    assert.match(groups[1].querySelector('summary')!.textContent, /2m 12s/);
    assert.match(cmdGroup.querySelector('summary')!.textContent, /執行了指令/);
    f.state.tabs[0].agents[0].status = 'done'; f.updateState();
    groups = f.document.querySelectorAll<DOMDetails>('.turn-log');
    assert.match(groups[1].querySelector('summary')!.textContent, /2/);
    assert.ok(Array.from(groups).every((group) => !group.open));
    const final = Array.from(f.document.querySelectorAll('.markdown')).find((node) => node.textContent === '測試全部通過。');
    assert.ok(final && !final.closest('details'), '一般回覆不在摺疊區內');
  } finally { await f.window.happyDOM.close(); }
});

test('等待確認時保留執行紀錄，結束工作後才摺疊', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [{ role: 'tool', tool: 'Bash', text: 'npm test' }]; f.updateTranscript();
    f.document.querySelector<DOMDetails>('.turn-log')!.open = true;
    f.state.tabs[0].agents[0].status = 'blocked'; f.updateState();
    assert.equal(f.document.querySelector<DOMDetails>('.turn-log')!.open, true);
    f.state.tabs[0].agents[0].status = 'idle'; f.updateState();
    assert.equal(f.document.querySelector<DOMDetails>('.turn-log')!.open, false);
  } finally { await f.window.happyDOM.close(); }
});

test('手動開關執行紀錄後，新增內容與背景更新保留選擇及焦點', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [{ role: 'tool', tool: 'Bash', text: 'npm test' }]; f.updateTranscript();
    f.document.querySelector<DOMDetails>('.turn-log')!.open = true;
    f.transcript.messages.push({ role: 'tool', tool: 'Bash', text: 'npm run typecheck' }); f.updateTranscript();
    assert.equal(f.document.querySelector<DOMDetails>('.turn-log')!.open, true);
    f.state.tabs[0].agents[0].status = 'idle'; f.updateState();
    const group = f.document.querySelector<DOMDetails>('.turn-log')!;
    group.open = true; group.querySelector<DOMElement>('summary')!.focus();
    f.transcript.messages.push({ role: 'assistant', text: '驗證完成。' }); f.updateTranscript();
    const updated = f.document.querySelector<DOMDetails>('.turn-log')!;
    assert.equal(updated.open, true, '完成後手動展開不可被背景更新關閉');
    assert.ok(f.document.activeElement === updated.querySelector('summary'));
  } finally { await f.window.happyDOM.close(); }
});

test('新回合預設摺疊，完成時只收合目前回合，保留手動展開的歷史紀錄', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [{ role: 'user', text: '第一個任務' }, { role: 'tool', tool: 'Bash', text: 'npm test' }]; f.updateTranscript();
    f.state.tabs[0].agents[0].status = 'idle'; f.updateState();
    f.document.querySelector<DOMDetails>('.turn-log')!.open = true;
    f.state.tabs[0].agents[0].status = 'working'; f.updateState();
    f.transcript.messages.push({ role: 'user', text: '第二個任務' }, { role: 'tool', tool: 'Bash', text: 'npm test' }); f.updateTranscript();
    const groups = f.document.querySelectorAll<DOMDetails>('.turn-log');
    assert.equal(groups[0].open, true);
    assert.equal(groups[1].open, false);
    groups[1].open = true;
    f.state.tabs[0].agents[0].status = 'idle'; f.updateState();
    const finished = f.document.querySelectorAll<DOMDetails>('.turn-log');
    assert.equal(finished[0].open, true);
    assert.equal(finished[1].open, false);
  } finally { await f.window.happyDOM.close(); }
});

test('不同工具區段維持原本順序，內層摺疊指令，最後回覆與終端機畫面不會被摺疊', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [
      { role: 'tool', tool: 'Bash', text: 'pwd' },
      { role: 'assistant', text: '接著執行測試。' },
      { role: 'tool', tool: 'Bash', text: 'npm test' },
      { role: 'terminal', text: '終端機畫面' },
      { role: 'assistant', text: '完成。' },
    ]; f.updateTranscript();
    const content = f.document.querySelector('.turn.assistant .content')!;
    assert.deepEqual(Array.from(content.querySelectorAll(':scope > :not(.message-actions)')).map((node) => node.classList.contains('turn-log') ? 'turn-log' : node.className), ['turn-log', 'terminal', 'markdown']);
    const log = content.querySelector('.turn-log-body')!;
    assert.deepEqual(Array.from(log.querySelectorAll(':scope > :not(.message-actions)')).map((node) => node.classList.contains('tool-command-group') ? 'tool-group' : node.className), ['tool-group', 'markdown', 'tool-group']);
    assert.equal(content.querySelector(':scope > .markdown')!.closest('details'), null);
    assert.equal(f.document.querySelector('.terminal')!.closest('details'), null);
  } finally { await f.window.happyDOM.close(); }
});

test('暫時無法取得 agent 狀態時，不會誤判工作已完成', async () => {
  const f = fixture();
  try {
    f.transcript.messages = [{ role: 'tool', tool: 'Bash', text: 'npm test' }]; f.updateTranscript();
    f.document.querySelector<DOMDetails>('.turn-log')!.open = true;
    f.state.tabs[0].agents[0].status = 'unknown'; f.updateState();
    assert.equal(f.document.querySelector<DOMDetails>('.turn-log')!.open, true);
    f.state.tabs[0].agents[0].status = 'done'; f.updateState();
    assert.equal(f.document.querySelector<DOMDetails>('.turn-log')!.open, false);
  } finally { await f.window.happyDOM.close(); }
});

test('問題內容改為下拉選單：點按鈕展開，點外面關閉；對話回到 agent 清單', async () => {
  const f = collaborationFixture();
  try {
    const menu = () => f.document.querySelector<DOMElement>('.task-page-menu')!;
    assert.equal(menu().hidden, true);
    f.click('.task-page-button');
    assert.equal(menu().hidden, false);
    assert.equal(f.document.querySelector('.task-page-button')!.getAttribute('aria-expanded'), 'true');
    f.document.body.click();
    assert.equal(menu().hidden, true);
    f.click('.task-page-button'); f.click('[data-task-page="memory"]');
    assert.equal(menu().hidden, true);
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-page'), 'memory');
    f.click('.task-back');
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-pane-id'), 'wE:p1', '從記憶返回原本的對話');
    f.click('.task-back');
    assert.ok(f.document.querySelector('.task-agent-list'), '從對話返回 agent 清單');
    assert.equal(f.input(), null);
    f.click('[data-agent-pane="wE:p2"]');
    assert.equal(f.document.querySelector('main.task')!.getAttribute('data-pane-id'), 'wE:p2');
  } finally { await f.window.happyDOM.close(); }
});
