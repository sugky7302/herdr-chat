import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window, type HTMLInputElement as DOMInput, type HTMLTextAreaElement as DOMTextArea, type HTMLSelectElement as DOMSelect, type HTMLButtonElement as DOMButton } from 'happy-dom';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['webview/main.ts'],
  bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent',
});

function fixture(language = 'en') {
  const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const document = window.document;
  document.documentElement.lang = language;
  document.body.innerHTML = '<div id="app"></div>';
  const sent: any[] = [];
  const state: any = { connected: false, repoName: 'repo', worktrees: [], workspaceId: null, workspaceLabel: null, presets: [], tabs: [], error: 'Herdr unavailable' };
  const snapshot: any = {
    scope: 'user', revision: 'revision-user-1', workspaceAvailable: true, workspaceLabel: '/repo', inherited: false,
    presets: [
      { id: 'claude', label: 'Claude', kind: 'claude', models: ['sonnet', 'opus'], defaultModel: 'sonnet', efforts: ['high'], modelArgs: ['--model', '{model}'], switchModel: '/model {model}', customMetadata: { preserve: true } },
      { id: 'codex', label: 'Codex', kind: 'codex', enabled: false, models: ['model-a'], efforts: [], modelArgs: ['-m', '{model}'], switchStyle: 'codex-menu' },
    ],
    projectDefaults: { claude: { model: 'opus' } },
    catalog: [
      { id: 'claude', label: 'Claude Code', kind: 'claude', command: 'claude', integrationTarget: 'claude', docsUrl: 'https://code.claude.com/docs/en/setup', preset: { id: 'claude', label: 'Claude', kind: 'claude' } },
      { id: 'gemini', label: 'Gemini CLI', kind: 'gemini', command: 'gemini', docsUrl: 'https://geminicli.com/docs/', preset: { id: 'gemini', label: 'Gemini', kind: 'gemini' } },
    ],
    integrations: [{ target: 'claude', installed: true, supported: true, status: 'current' }],
    skills: [{ id: 'skill-1', name: 'herdr', description: 'Operate panes', path: '/repo/.claude/skills/herdr/SKILL.md', agent: 'claude', scope: 'project', invocation: '/herdr' }],
    skillRoots: [{ path: '/repo/.claude/skills', agent: 'claude', scope: 'project', exists: true }],
    diagnostics: { connected: false, socketPath: '/tmp/herdr.sock', nodePath: 'node', claudeMemUrl: '', trusted: true },
  };
  (window as any).acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage(message: any) { sent.push(structuredClone(message)); } });
  const emit = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data: structuredClone(data) }));
  window.eval(bundle.outputFiles[0].text);
  const click = (selector: string) => {
    const button = document.querySelector<DOMButton>(selector); assert.ok(button, `Missing button: ${selector}`); button.click();
  };
  const edit = (selector: string, value: string) => {
    const input = document.querySelector<DOMInput | DOMTextArea>(selector); assert.ok(input, `Missing input: ${selector}`);
    input.value = value; input.dispatchEvent(new window.Event('input')); return input;
  };
  const enter = () => {
    emit({ type: 'navigate', view: 'settings' });
    const request = sent.filter((message) => message.type === 'loadSettings').at(-1); assert.ok(request);
    emit({ type: 'settingsState', requestId: request.requestId, snapshot });
  };
  const poll = () => { state.error += '.'; emit({ type: 'state', state }); };
  return { window, document, sent, state, snapshot, emit, click, edit, enter, poll };
}

test('settings is reachable before initial state, disconnected, and without a Herdr workspace', async () => {
  const f = fixture();
  try {
    f.enter();
    assert.ok(f.document.querySelector('main.settings'));
    assert.equal(f.document.querySelector('.settings-modal'), null, '預設不展開編輯視窗');
    f.click('[data-preset-index="0"]');
    assert.ok(f.document.querySelector('.settings-modal'), '點擊 agent 後彈出置中懸浮窗');
    assert.equal(f.document.querySelector<DOMInput>('#settings-agent-label')!.value, 'Claude');
    f.click('.settings-modal-close');
    assert.equal(f.document.querySelector('.settings-modal'), null, '關閉懸浮窗');
    f.poll();
    assert.ok(f.document.querySelector('main.settings'));
    assert.match(f.document.querySelector('.settings-body')!.textContent, /Project defaults override preset defaults/);
    f.click('[data-settings-section="connection"]');
    assert.match(f.document.querySelector('.settings-body')!.textContent, /Disconnected/);
  } finally { await f.window.happyDOM.close(); }
});

test('background state polling preserves settings draft, focus, selection, templates and custom metadata', async () => {
  const f = fixture();
  try {
    f.enter();
    f.click('[data-preset-index="0"]');
    const label = f.edit('#settings-agent-label', 'Planning Claude'); label.focus(); label.setSelectionRange(2, 7);
    f.poll();
    assert.ok(f.document.querySelector('#settings-agent-label') === label);
    assert.ok(f.document.activeElement === label);
    assert.equal(label.selectionStart, 2); assert.equal(label.selectionEnd, 7);
    f.edit('#settings-agent-models', 'sonnet\nopus\nprovider/new-model\nopus');
    f.click('.settings-save');
    const saved = f.sent.filter((message) => message.type === 'saveAgentSettings').at(-1);
    assert.ok(saved); assert.equal(saved.revision, 'revision-user-1');
    assert.deepEqual(saved.presets[0].models, ['sonnet', 'opus', 'provider/new-model']);
    assert.deepEqual(saved.presets[0].modelArgs, ['--model', '{model}']);
    assert.equal(saved.presets[0].switchModel, '/model {model}');
    assert.deepEqual(saved.presets[0].customMetadata, { preserve: true });
    assert.equal(saved.presets[1].enabled, false);
    assert.doesNotMatch(f.document.querySelector('.settings-feedback')!.textContent, /Agent settings saved/);
    f.emit({ type: 'settingsOperation', operationId: 'wrong-operation', snapshot: f.snapshot });
    assert.match(f.document.querySelector('.settings-feedback')!.textContent, /Applying settings/);
    f.emit({ type: 'settingsOperation', operationId: saved.operationId, error: 'Configuration changed externally; reload required.' });
    assert.equal(f.document.querySelector<DOMInput>('#settings-agent-label')!.value, 'Planning Claude');
    assert.match(f.document.querySelector('.settings-feedback')!.textContent, /changed externally/);
    assert.equal(f.document.querySelector<DOMButton>('.settings-save')!.disabled, false);
  } finally { await f.window.happyDOM.close(); }
});

test('invalid advanced JSON survives section switches and blocks save; stale replies do not overwrite edits', async () => {
  const f = fixture();
  try {
    f.enter();
    f.click('[data-preset-index="0"]');
    f.edit('#settings-agent-advanced', '{ "modelArgs": [');
    f.click('[data-settings-section="skills"]');
    f.click('[data-settings-section="agents"]');
    assert.equal(f.document.querySelector<DOMTextArea>('#settings-agent-advanced')!.value, '{ "modelArgs": [');
    f.click('.settings-save');
    assert.equal(f.sent.filter((message) => message.type === 'saveAgentSettings').length, 0);
    assert.match(f.document.querySelector('.settings-feedback')!.textContent, /Correct the advanced JSON/);
    f.emit({ type: 'settingsState', requestId: 'stale-request', snapshot: { ...f.snapshot, presets: [] } });
    assert.equal(f.document.querySelector<DOMTextArea>('#settings-agent-advanced')!.value, '{ "modelArgs": [');
    f.edit('#settings-agent-advanced', '{"modelArgs":["--model","{model}"],"extra":{"flag":true}}');
    f.click('.settings-save');
    const saved = f.sent.filter((message) => message.type === 'saveAgentSettings').at(-1);
    assert.deepEqual(saved.presets[0].extra, { flag: true });
    assert.equal(saved.presets[0].switchModel, undefined, 'Removing an advanced key removes it from the draft');
    f.emit({ type: 'settingsOperation', operationId: saved.operationId, snapshot: { ...f.snapshot, presets: saved.presets, revision: 'revision-user-2' } });
    assert.equal(f.document.querySelector<DOMButton>('.settings-save')!.disabled, true);
    assert.match(f.document.querySelector('.settings-feedback')!.textContent, /Agent settings saved/);
  } finally { await f.window.happyDOM.close(); }
});

test('dirty settings require confirmation on scope changes and navigation', async () => {
  const f = fixture();
  try {
    f.enter();
    f.click('[data-preset-index="0"]');
    f.edit('#settings-agent-label', 'Unsaved');
    const scope = f.document.querySelector<DOMSelect>('#settings-scope')!;
    scope.value = 'workspace'; scope.dispatchEvent(new f.window.Event('change'));
    assert.equal(scope.value, 'user');
    assert.equal(f.sent.filter((message) => message.type === 'loadSettings').length, 1);
    f.click('.settings-confirm-keep');
    assert.equal(f.document.querySelector<DOMInput>('#settings-agent-label')!.value, 'Unsaved');
    f.emit({ type: 'navigate', view: 'history' });
    assert.ok(f.document.querySelector('main.settings'));
    f.click('.settings-confirm-keep');
    scope.value = 'workspace'; scope.dispatchEvent(new f.window.Event('change'));
    f.click('.settings-confirm-accept');
    const request = f.sent.filter((message) => message.type === 'loadSettings').at(-1);
    assert.equal(request.scope, 'workspace');
    f.emit({ type: 'settingsState', requestId: request.requestId, snapshot: { ...f.snapshot, scope: 'workspace', revision: 'workspace-1', inherited: true } });
    assert.equal(f.document.querySelector<DOMSelect>('#settings-scope')!.value, 'workspace');
    assert.match(f.document.querySelector('.settings-body')!.textContent, /currently inherits/);
  } finally { await f.window.happyDOM.close(); }
});

test('catalog additions and integration install/uninstall use distinct operations and preserve agent drafts', async () => {
  const f = fixture();
  try {
    f.snapshot.diagnostics.connected = true;
    f.enter();
    f.click('[data-add-catalog="gemini"]');
    assert.equal(f.document.querySelector<DOMInput>('#settings-agent-kind')!.value, 'gemini');
    assert.equal(f.sent.filter((message) => message.type === 'runIntegration').length, 0);
    f.click('[data-settings-section="integrations"]');
    assert.match(f.document.querySelector('.settings-body')!.textContent, /do not install the agent CLI or download cloud models/);
    assert.equal(f.document.querySelector('[data-integration="gemini"] [data-integration-action]'), null);
    f.click('[data-integration="claude"] [data-integration-action="uninstall"]');
    assert.equal(f.sent.filter((message) => message.type === 'runIntegration').length, 0);
    f.click('.settings-confirm-accept');
    const operation = f.sent.filter((message) => message.type === 'runIntegration').at(-1);
    assert.equal(operation.target, 'claude'); assert.equal(operation.action, 'uninstall');
    const after = { ...f.snapshot, integrations: [{ target: 'claude', installed: false, supported: true, status: 'not_installed' }] };
    f.emit({ type: 'settingsOperation', operationId: operation.operationId, snapshot: after, output: 'Removed Herdr hook.' });
    assert.match(f.document.querySelector('.settings-body')!.textContent, /Not installed/);
    assert.match(f.document.querySelector('.settings-feedback')!.textContent, /Removed Herdr hook/);
    f.click('[data-settings-section="agents"]');
    assert.equal(f.document.querySelector<DOMInput>('#settings-agent-kind')!.value, 'gemini', 'Hook mutation must preserve the unsaved catalog addition');
    f.click('.settings-save');
    const saved = f.sent.filter((message) => message.type === 'saveAgentSettings').at(-1);
    assert.equal(saved.presets.length, 3); assert.equal(saved.revision, 'revision-user-1');
  } finally { await f.window.happyDOM.close(); }
});

test('skills show provenance and open only a host inventory ID; settings respect VS Code language', async () => {
  const f = fixture('zh-TW');
  try {
    f.enter();
    assert.equal(f.document.querySelector('.toolbar h2')!.textContent, '設定');
    f.click('[data-settings-section="skills"]');
    assert.match(f.document.querySelector('.settings-body')!.textContent, /標準本機目錄/);
    assert.match(f.document.querySelector('.settings-skill-list')!.textContent, /\/repo\/\.claude\/skills\/herdr\/SKILL.md/);
    f.click('.settings-skill-list button');
    assert.deepEqual(f.sent.filter((message) => message.type === 'openSkillFile').at(-1), { type: 'openSkillFile', skillId: 'skill-1' });
    f.edit('input[type="search"]', 'absent');
    assert.equal(f.document.querySelectorAll('.settings-skill-list article').length, 0);
  } finally { await f.window.happyDOM.close(); }
});

test('disabled presets are hidden when adding agents while enabled and terminal choices remain', async () => {
  const f = fixture();
  try {
    Object.assign(f.state, { connected: true, workspaceId: 'w1', workspaceLabel: 'repo', error: null, presets: [
      { id: 'claude', label: 'Claude', models: [], efforts: [], enabled: true },
      { id: 'codex', label: 'Codex', models: [], efforts: [], enabled: false },
    ] });
    f.emit({ type: 'state', state: f.state });
    f.emit({ type: 'navigate', view: 'newAgent' });
    assert.deepEqual([...f.document.querySelectorAll('.preset')].map((element) => element.textContent), ['Claude', 'Terminal']);
  } finally { await f.window.happyDOM.close(); }
});
