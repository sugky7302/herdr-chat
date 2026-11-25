import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window, type HTMLTextAreaElement as DOMTextArea, type HTMLElement as DOMElement, type HTMLButtonElement as DOMButton } from 'happy-dom';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['webview/main.ts'],
  bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent',
});

function fixture() {
  const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const document = window.document;
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
