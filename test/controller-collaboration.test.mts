import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real Controller methods without starting VS Code, Herdr, or a model.
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: { contents: 'export { Controller } from "./src/controller.ts"; export { setLocale } from "./src/l10n.ts";', resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'vscode-test-host',
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    },
  }],
});
const { Controller, setLocale } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
setLocale('zh-tw');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pane(paneId = 'planner-a', tabId = 'tab-a', sessionValue = 'session-a') {
  return {
    pane_id: paneId, tab_id: tabId, workspace_id: 'workspace-a', focused: false,
    cwd: '/repo/a', agent: 'claude', agent_status: 'idle',
    agent_session: { agent: 'claude', kind: 'id', source: 'native', value: sessionValue },
  };
}

function task() {
  const planner = { paneId: 'planner-a', tabId: 'tab-a', harness: 'claude', session: { kind: 'id', source: 'native', value: 'session-a' } };
  return {
    id: 'task-a', tabId: 'tab-a', title: 'Auth refactor', repositoryRoot: '/repo', checkoutPath: '/repo/a',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active', generation: 1, enabled: true, planner, participants: [planner],
    requests: [], events: [], handoffs: [], userMessages: [], memoryReferences: [],
  };
}

function controller() {
  const result = Object.create(Controller.prototype);
  Object.assign(result, {
    gitRoot: '/repo', collaborationReady: Promise.resolve(), queues: new Map(), delivering: new Set(),
    transcriptSnapshots: new Map(), screenPanes: new Set(), nextQueueId: 1,
    memento: { get: (_key: string, fallback: unknown) => fallback },
    post: () => undefined, scheduleRefresh: () => undefined,
    readScreen: async () => '',
    state: {
      repoRoot: '/repo', workspaceId: 'workspace-a', worktrees: [{ path: '/repo/a', workspaceId: 'workspace-a', current: true }],
      tabs: [{ tabId: 'tab-a', label: 'Auth refactor', agents: [{ paneId: 'planner-a', kind: 'claude', presetId: 'claude', status: 'idle' }] }],
    },
    snapshot: { workspaces: [], tabs: [{ tab_id: 'tab-a', workspace_id: 'workspace-a' }], panes: [pane()], agents: [pane()] },
    worktrees: { worktrees: [{ path: '/repo/a', open_workspace_id: 'workspace-a' }, { path: '/repo/b', open_workspace_id: 'workspace-b' }] },
  });
  return result;
}

test('opening a task keeps its original checkout while collaboration initialization and a worktree switch overlap', async () => {
  const c = controller();
  const ready = deferred();
  let selectedCheckout = '/repo/a';
  let created: any;
  c.collaborationReady = ready.promise;
  c.selectedWorktreePath = () => selectedCheckout;
  c.collaboration = {
    getTaskForTab: () => undefined,
    getTasks: () => [],
    ensureTask: async (input: unknown) => { created = input; return task(); },
  };

  const opening = c.openTask('tab-a');
  // The selection is persisted before the old tab list is replaced by refresh().
  selectedCheckout = '/repo/b';
  ready.resolve();
  await opening;

  assert.equal(created.tabId, 'tab-a');
  assert.equal(created.checkoutPath, '/repo/a');
  assert.equal(created.repositoryRoot, '/repo');
});

test('an old tab still displayed during worktree refresh is bound to its own workspace checkout', async () => {
  const c = controller();
  let created: any;
  // switchWorktree persists the next selection before refresh replaces the visible tabs.
  c.selectedWorktreePath = () => '/repo/b';
  c.collaboration = {
    getTaskForTab: () => undefined, getTasks: () => [],
    ensureTask: async (input: unknown) => { created = input; return task(); },
  };

  await c.openTask('tab-a');

  assert.equal(created.tabId, 'tab-a');
  assert.equal(created.checkoutPath, '/repo/a');
});

test('memory save remains bound to the task and checkout that initiated it across a UI switch', async () => {
  const c = controller();
  const origin = task();
  const saving = deferred(), entered = deferred();
  let savedInput: any, linkedTaskId: string | undefined;
  c.openTask = async () => origin;
  c.memoryClient = { save: async (input: unknown) => { savedInput = input; entered.resolve(); await saving.promise; return { id: 17, title: 'Auth rule', text: 'Do not cache credentials' }; } };
  c.collaboration = { addMemoryReference: async (id: string) => { linkedTaskId = id; } };

  const operation = c.saveTaskMemory({ type: 'saveTaskMemory', tabId: 'tab-a', operationId: 'save-a', title: 'Auth rule', text: 'Do not cache credentials' });
  await entered.promise;
  c.gitRoot = '/other-repo';
  c.state.tabs = [{ tabId: 'tab-b', agents: [] }];
  saving.resolve();

  assert.equal(await operation, 17);
  assert.equal(savedInput.cwd, '/repo/a');
  assert.equal(savedInput.metadata.herdr.taskId, 'task-a');
  assert.equal(savedInput.metadata.herdr.tabId, 'tab-a');
  assert.equal(linkedTaskId, 'task-a');
});

test('failed Claude-mem writes never create a local success reference', async () => {
  const c = controller();
  let references = 0;
  c.openTask = async () => task();
  c.memoryClient = { save: async () => { throw new Error('Worker unavailable'); } };
  c.collaboration = { addMemoryReference: async () => { references++; } };

  await assert.rejects(c.saveTaskMemory({ type: 'saveTaskMemory', tabId: 'tab-a', operationId: 'save-failed', title: 'Title', text: 'Text' }), /Worker unavailable/);
  assert.equal(references, 0);
});

test('a task cannot save a conversation source from another tab', async () => {
  const c = controller();
  let writes = 0;
  c.openTask = async () => task();
  c.livePanes = async () => [pane(), pane('worker-b', 'tab-b', 'session-b')];
  c.memoryClient = { save: async () => { writes++; return { id: 18 }; } };
  c.collaboration = { addMemoryReference: async () => undefined };

  await assert.rejects(c.saveTaskMemory({
    type: 'saveTaskMemory', tabId: 'tab-a', operationId: 'wrong-source', title: 'Title', text: 'Text',
    source: { paneId: 'worker-b', role: 'assistant', messageIndex: 0, text: 'From another task' },
  }));
  assert.equal(writes, 0);
});

test('a manually started agent in the same task tab can save a selected message before receiving a delegation', async () => {
  const c = controller();
  const worker = pane('manual-worker', 'tab-a', 'manual-session');
  c.snapshot.panes.push(worker);
  c.snapshot.agents.push(worker);
  c.openPaneId = worker.pane_id;
  c.livePanes = async () => [pane(), worker];
  c.transcripts = { read: async () => ({ paneId: worker.pane_id, source: 'claude', messages: [{ role: 'assistant', text: 'Keep 401 for expired tokens.' }] }) };
  await c.pushTranscript();
  c.openTask = async () => task();
  const registrations: unknown[] = [];
  let savedInput: any;
  c.collaboration = {
    registerParticipant: async (...args: unknown[]) => { registrations.push(args); },
    addMemoryReference: async () => undefined,
  };
  c.memoryClient = { save: async (input: unknown) => { savedInput = input; return { id: 19 }; } };

  const id = await c.saveTaskMemory({
    type: 'saveTaskMemory', tabId: 'tab-a', operationId: 'manual-source', title: 'Expired token behavior', text: 'Keep 401 for expired tokens.',
    source: { paneId: worker.pane_id, role: 'assistant', messageIndex: 0, text: 'Keep 401 for expired tokens.' },
  });

  assert.equal(id, 19);
  assert.equal(savedInput.cwd, '/repo/a');
  assert.deepEqual(registrations, [['task-a', 'manual-worker']]);
});

test('memory source from a replaced native session is rejected before contacting Claude-mem', async () => {
  const c = controller();
  c.openPaneId = 'planner-a';
  c.transcripts = { read: async () => ({ paneId: 'planner-a', source: 'claude', messages: [{ role: 'assistant', text: 'Original session message.' }] }) };
  await c.pushTranscript();
  c.openTask = async () => task();
  c.livePanes = async () => [pane('planner-a', 'tab-a', 'replacement-session')];
  let writes = 0;
  c.memoryClient = { save: async () => { writes++; return { id: 20 }; } };
  c.collaboration = { registerParticipant: async () => undefined, addMemoryReference: async () => undefined };

  await assert.rejects(c.saveTaskMemory({
    type: 'saveTaskMemory', tabId: 'tab-a', operationId: 'old-session', title: 'Title', text: 'Original session message.',
    source: { paneId: 'planner-a', role: 'assistant', messageIndex: 0, text: 'Original session message.' },
  }), /session|來源/i);
  assert.equal(writes, 0);
});

test('inserting a queued message into a retired planner is blocked without losing the queue item', async () => {
  const c = controller();
  const item = { id: 3, text: 'Continue planning', attachments: [] };
  c.queues.set('planner-a', [item]);
  let sent = 0;
  c.plannerReadOnly = () => '這個規劃者已交接';
  c.deliverNow = async () => { sent++; };

  await assert.rejects(c.insertQueued('planner-a', 3), /已交接/);
  assert.equal(sent, 0);
  assert.deepEqual(c.queues.get('planner-a'), [item]);
});

test('handoff occurring during model settings persistence prevents late delivery to the old planner', async () => {
  const c = controller();
  const remembering = deferred(), entered = deferred();
  let retired = false, sent = 0;
  c.openTask = async () => task();
  c.plannerReadOnly = () => retired ? '這個規劃者已交接' : undefined;
  c.presets = () => [{ id: 'claude', kind: 'claude' }];
  c.rememberPane = async () => { entered.resolve(); await remembering.promise; };
  c.client = { request: async (method: string) => { if (method === 'agent.prompt') sent++; } };
  c.collaboration = { getTaskForTab: () => task(), recordUserMessage: async () => undefined };

  const sending = c.deliverNow('planner-a', 'Make the next plan');
  await entered.promise;
  retired = true;
  remembering.resolve();

  await assert.rejects(sending, /已交接/);
  assert.equal(sent, 0);
});

test('editing or cancelling an unsent queued message never preserves it as an executed user instruction', async () => {
  const c = controller();
  c.snapshot.panes[0].agent_status = 'working';
  c.snapshot.agents[0].agent_status = 'working';
  c.plannerReadOnly = () => undefined;
  c.openTask = async () => task();
  c.pushTranscript = async () => undefined;
  c.scheduleCheckpoints = () => undefined;
  let records = 0, nativeSends = 0;
  c.collaboration = {
    getTaskForTab: () => task(),
    recordUserMessage: async () => { records++; },
    prepareCheckpoint: async () => task(),
  };
  c.client = { request: async () => { nativeSends++; } };

  await c.send('planner-a', 'Incorrect instruction');
  const queued = c.queues.get('planner-a')[0];
  await c.updateQueued('planner-a', queued.id, 'Revised instruction');
  assert.equal(c.queues.get('planner-a')[0].text, 'Revised instruction');
  c.removeQueued('planner-a', queued.id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(records, 0);
  assert.equal(nativeSends, 0);
  assert.deepEqual(c.queues.get('planner-a'), []);
});

test('handoff checkpoint never attributes the current pane session transcript to an older participant session', async () => {
  const c = controller();
  const currentPane = pane('planner-a', 'tab-a', 'session-b');
  c.snapshot.panes = [currentPane];
  c.snapshot.agents = [currentPane];
  c.openPaneId = 'planner-a';
  c.livePanes = async () => [currentPane];
  c.transcripts = {
    read: async () => ({ paneId: 'planner-a', source: 'claude', messages: [{ role: 'assistant', text: 'OTHER_SESSION_PRIVATE_TRANSCRIPT' }] }),
  };
  await c.pushTranscript();

  const checkpoint = await c.captureCheckpoint(task());
  assert.doesNotMatch(checkpoint, /OTHER_SESSION_PRIVATE_TRANSCRIPT/);
});

test('a disabled preset blocks manual and automatic creation before any pane is changed', async () => {
  const c = controller();
  c.presets = () => [{ id: 'claude', label: 'Claude', kind: 'claude', enabled: false }];
  c.collaboration = { getTaskForTab: () => task() };
  let mutations = 0;
  c.client = { request: async () => { mutations++; } };
  await assert.rejects(c.newAgent('claude', null), /停用|disabled/);
  await assert.rejects(c.createCollaborationAgent('claude', 'tab-a'), /停用|disabled/);
  assert.equal(mutations, 0);
});
