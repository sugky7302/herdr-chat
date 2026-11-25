import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CollaborationService } from '../src/collaboration/service.ts';
import { callBridge, parseCli } from '../src/collaboration/cli.ts';
import type { CollaborationHost, CollaborationTask, LivePane, RpcInput } from '../src/collaboration/types.ts';
import { formatLocalized, getLocale, setLocale } from '../src/l10n.ts';

setLocale('zh-tw');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pane(id: string, harness = 'claude'): LivePane {
  return { pane_id: id, tab_id: 'tab-1', workspace_id: 'ws-1', terminal_id: `terminal-${id}`, focused: false,
    agent: harness, agent_status: 'idle', agent_session: { agent: harness, kind: 'id', value: `session-${id}`, source: 'native' } };
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'expected asynchronous state change');
}

async function fixture(t: TestContext, overrides: Partial<CollaborationHost> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-collab-'));
  const panes = [pane('planner'), pane('worker', 'codex'), pane('next', 'codex')];
  const calls: { paneId: string; text: string; wait?: boolean; timeoutMs?: number }[] = [];
  const pauses: string[] = [];
  const host: CollaborationHost = {
    listPanes: async () => structuredClone(panes),
    listPresets: () => [{ id: 'codex', label: 'Codex', kind: 'codex', models: ['model-from-config'], efforts: ['high'] }],
    prompt: async (paneId, text, options) => { calls.push({ paneId, text, ...options }); return { agent: { agent_status: 'done' } }; },
    createAgent: async (_preset, tabId) => { const agent = pane(`spawn-${panes.length}`, 'codex'); agent.tab_id = tabId; panes.push(agent); return agent.pane_id; },
    captureCheckpoint: async () => 'ORIGINAL user text\nbranch=work HEAD=abc\nstatus=clean',
    pausePlanner: async (paneId) => { pauses.push(paneId); },
    publish: () => undefined,
    ...overrides,
  };
  const service = new CollaborationService({ storageDir: directory, cliPath: '/extension/dist/herdr-collab.cjs', host });
  await service.initialize();
  const task = await service.ensureTask({ tabId: 'tab-1', title: 'Auth refactor', repositoryRoot: '/repo', checkoutPath: '/repo/work', plannerPaneId: 'planner' });
  await service.enablePlanner(task.id);
  t.after(async () => { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const rpc = (command: RpcInput['command'], args: Record<string, unknown>, caller = 'planner', generation = 1) => service.rpc({ command, taskId: task.id, caller: { paneId: caller, generation }, args });
  const latest = () => service.getTasks().find((item) => item.id === task.id)!;
  const report = (requestId: string, status: 'completed' | 'needs_input' | 'failed', text: string, revision = 0, reportId = `${status}-${revision}`) => rpc('report', { requestId, status, text, revision, reportId }, 'worker');
  return { service, directory, host, panes, calls, pauses, task, rpc, latest, report };
}

test('native done does not complete work; explicit reports are session-pinned and idempotent', async (t) => {
  const f = await fixture(t);
  assert.ok(f.task.participants.some((agent) => agent.paneId === 'worker'), 'same-tab manual agents are included before delegation');
  const request = await f.service.delegateFromUser(f.task.id, 'worker', 'Refactor auth and run tests.');
  await eventually(() => f.latest().requests[0].status === 'awaiting_report');
  assert.equal(f.latest().requests[0].runtimeStatus, 'done');
  assert.equal(f.latest().requests[0].report, undefined);
  assert.equal(f.calls.filter((call) => call.wait).length, 1);
  assert.equal(f.calls.find((call) => call.wait)?.timeoutMs, 180000);
  assert.match(f.calls.find((call) => call.wait)!.text, /--revision 0 --status completed/);
  await assert.rejects(f.rpc('report', { requestId: request.id, revision: 0, status: 'completed', text: 'spoof', reportId: 'x' }, 'next'), { code: 'wrong_reporter' });
  f.panes[1].agent_session!.value = 'replacement-session';
  await assert.rejects(f.report(request.id, 'completed', 'wrong session'), { code: 'session_changed' });
  f.panes[1].agent_session!.value = 'session-worker';
  await f.report(request.id, 'completed', 'Changed auth; 12 tests passed.');
  await f.report(request.id, 'completed', 'Changed auth; 12 tests passed.');
  assert.equal(f.latest().requests[0].reports.length, 1);
  assert.equal(f.latest().requests[0].status, 'completed');
  await assert.rejects(f.report(request.id, 'completed', 'Different evidence.'), { code: 'report_conflict' });
});

test('native timeout retains worker reservation and request ID; late reports complete without redispatch', async (t) => {
  let dispatches = 0;
  const f = await fixture(t, { prompt: async (_pane, _text, options) => {
    if (options?.wait) { dispatches++; throw Object.assign(new Error('socket timed out after possible delivery'), { code: 'timeout' }); }
  } });
  const first = await f.rpc('delegate', { targetPaneId: 'worker', text: 'Slow work', requestId: 'request-stable' }) as any;
  await eventually(() => f.latest().requests[0].status === 'wait_expired');
  await assert.rejects(f.service.delegateFromUser(f.task.id, 'worker', 'Duplicate work'), { code: 'worker_busy' });
  assert.equal((await f.rpc('wait', { requestId: first.request.id, timeoutMs: 10 }) as any).reason, 'wait_expired');
  assert.equal(dispatches, 1);
  const duplicate = await f.rpc('delegate', { targetPaneId: 'worker', text: 'Slow work', requestId: 'request-stable' }) as any;
  assert.equal(duplicate.request.id, first.request.id);
  assert.equal(dispatches, 1);
  await f.report(first.request.id, 'completed', 'The original work completed.');
  assert.equal((await f.rpc('wait', { requestId: first.request.id, timeoutMs: 10 }) as any).reason, 'completed');
  await f.rpc('delegate', { targetPaneId: 'worker', text: 'Slow work', requestId: 'request-stable' });
  assert.equal(dispatches, 1, 'retrying a request ID after completion cannot repeat the work');
});

test('needs_input releases wait; answer continues the same request and an old native wait cannot overwrite it', async (t) => {
  const native = [deferred<{ agent: { agent_status: string } }>(), deferred<{ agent: { agent_status: string } }>()];
  let dispatches = 0;
  const f = await fixture(t, { prompt: async (_pane, _text, options) => options?.wait ? native[dispatches++].promise : undefined });
  const request = await f.service.delegateFromUser(f.task.id, 'worker', 'Preserve existing auth behavior.');
  await eventually(() => dispatches === 1);
  const waiting = f.rpc('wait', { requestId: request.id, timeoutMs: 1000 });
  await f.report(request.id, 'needs_input', 'Should expired tokens return 401 or 403?');
  assert.equal((await waiting as any).reason, 'needs_input');
  const continued = await f.service.answerFromUser(f.task.id, request.id, 'Preserve 401.');
  assert.equal(continued.id, request.id);
  assert.equal(continued.revision, 1);
  await eventually(() => dispatches === 2);
  native[0].resolve({ agent: { agent_status: 'done' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.latest().requests[0].revision, 1);
  assert.equal(f.latest().requests[0].status, 'running');
  await assert.rejects(f.report(request.id, 'completed', 'late revision zero', 0, 'old'), { code: 'stale_revision' });
  await f.report(request.id, 'completed', 'Kept 401; tests pass.', 1);
  native[1].resolve({ agent: { agent_status: 'idle' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const final = f.latest().requests[0];
  assert.equal(final.status, 'completed');
  assert.equal(final.reports.length, 2);
  assert.equal(final.requestedBy.paneId, 'planner');
  assert.equal(final.replies[0].text, 'Preserve 401.');
});

test('handoff freezes the old generation immediately, preserves workers, and delivers pending updates only on explicit accept', async (t) => {
  const capture = deferred<string>();
  const f = await fixture(t, { captureCheckpoint: () => capture.promise });
  await f.service.recordUserMessage(f.task.id, 'planner', 'Keep the old 401 response format.');
  const request = await f.service.delegateFromUser(f.task.id, 'worker', 'Change auth internals.');
  await eventually(() => f.latest().requests[0].status === 'awaiting_report');
  const oldWait = f.rpc('wait', { requestId: request.id, timeoutMs: 1000 });
  const handoff = f.service.beginHandoff(f.task.id, { targetPaneId: 'next' });
  await eventually(() => f.latest().status === 'handoff_pending' && f.pauses.length === 1);
  assert.equal(f.latest().generation, 2);
  assert.equal((await oldWait as any).reason, 'planner_changed');
  await assert.rejects(f.rpc('spawn', { presetId: 'codex' }), { code: 'stale_generation' });
  assert.equal(f.latest().planner.paneId, 'planner');
  await f.report(request.id, 'completed', 'Finished while the planner was changing.');
  capture.resolve('ORIGINAL transcript, no LLM needed');
  await handoff;
  const pending = f.latest(); const handoffId = pending.handoffs.at(-1)!.id;
  assert.equal(pending.status, 'handoff_pending');
  assert.equal(pending.handoffs.at(-1)!.status, 'awaiting_accept');
  assert.match(pending.checkpoint!.text, /Keep the old 401 response format/);
  assert.match(f.calls.find((call) => call.paneId === 'next')!.text, /--generation 2 accept/);
  await assert.rejects(f.rpc('accept', { handoffId }, 'planner', 2), { code: 'wrong_acceptor' });
  const accepted = await f.rpc('accept', { handoffId }, 'next', 2) as { task: CollaborationTask; updates: { type: string; text: string }[] };
  assert.equal(accepted.task.status, 'active');
  assert.equal(accepted.task.planner.paneId, 'next');
  assert.ok(accepted.updates.some((event) => event.type === 'reported' && /while the planner/.test(event.text)));
  assert.equal(accepted.task.requests[0].requestedBy.paneId, 'planner');
  assert.equal(accepted.task.requests[0].generation, 1);
  await assert.rejects(f.rpc('delegate', { targetPaneId: 'worker', text: 'stale planner work' }), { code: 'stale_generation' });
  assert.deepEqual(f.pauses, ['planner']);
});

test('failed pause leaves the planner frozen and never sends work to the candidate', async (t) => {
  const f = await fixture(t, { pausePlanner: async () => { throw new Error('cannot confirm planner stop'); } });
  await assert.rejects(f.service.beginHandoff(f.task.id, { targetPaneId: 'next' }), /cannot confirm planner stop/);
  assert.equal(f.latest().status, 'handoff_pending');
  assert.equal(f.latest().handoffs.at(-1)!.status, 'failed');
  assert.equal(f.calls.filter((call) => call.paneId === 'next').length, 0);
  await assert.rejects(f.rpc('spawn', { presetId: 'codex' }), { code: 'stale_generation' });
});

test('bridge requires the private token and native caller; descriptor is private and CLI returns task state', async (t) => {
  const f = await fixture(t);
  const descriptor = JSON.parse(await fs.readFile(f.service.connectionFile, 'utf8'));
  assert.equal((await fs.stat(f.service.connectionFile)).mode & 0o777, 0o600);
  const body = { command: 'status', taskId: f.task.id, caller: { paneId: 'planner', generation: 1 }, args: {} };
  const denied = await fetch(descriptor.url, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();
  const origin = await fetch(descriptor.url, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, origin: 'https://example.com' }, body: JSON.stringify(body) });
  assert.equal(origin.status, 403);
  await origin.arrayBuffer();
  const args = ['--connection', f.service.connectionFile, '--task', f.task.id, '--generation', '1', 'status'];
  assert.throws(() => parseCli(args, {}), /HERDR_PANE_ID/);
  const result = await callBridge(parseCli(args, { HERDR_PANE_ID: 'planner' })) as any;
  assert.equal(result.task.id, f.task.id);
  await assert.rejects(callBridge(parseCli(args, { HERDR_PANE_ID: 'outside-task' })), { code: 'pane_missing' });
});

test('only one owner can write a workspace; restart retains uncertainty without replaying work', async (t) => {
  const running = deferred<{ agent: { agent_status: string } }>();
  let sent = 0;
  const f = await fixture(t, { prompt: async (_pane, _text, options) => { if (options?.wait) { sent++; return running.promise; } } });
  const request = await f.service.delegateFromUser(f.task.id, 'worker', 'Long-running work');
  await eventually(() => sent === 1);
  const second = new CollaborationService({ storageDir: f.directory, cliPath: '/extension/dist/herdr-collab.cjs', host: f.host });
  await assert.rejects(second.initialize(), /另一個 VS Code 視窗/);
  const previousDescriptor = f.service.connectionFile;
  await f.service.dispose();
  await assert.rejects(fs.access(previousDescriptor));
  const snapshotPath = path.join(f.directory, 'tasks.json');
  const interrupted = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  interrupted.tasks[0].plannerDelivery = { status: 'sending', at: new Date().toISOString() };
  await fs.writeFile(snapshotPath, JSON.stringify(interrupted));
  const restored = new CollaborationService({ storageDir: f.directory, cliPath: '/extension/dist/herdr-collab.cjs', host: f.host });
  await restored.initialize();
  t.after(() => restored.dispose());
  assert.equal(restored.getTasks()[0].requests[0].status, 'wait_expired');
  assert.equal(restored.getTasks()[0].plannerDelivery?.status, 'uncertain');
  assert.equal(sent, 1);
  assert.equal(restored.connectionFile, previousDescriptor, 'original worker commands must reconnect through the same descriptor path');
  await callBridge(parseCli(['--connection', previousDescriptor, '--task', f.task.id, '--generation', '1', 'report', request.id,
    '--revision', '0', '--status', 'completed', '--text', 'Original run finished after restart', '--report-id', 'restored'], { HERDR_PANE_ID: 'worker' }));
  assert.equal(restored.getTasks()[0].requests[0].status, 'completed');
  running.resolve({ agent: { agent_status: 'done' } });
  await restored.dispose();
});

test('reused pane sessions do not inherit old worker reservations or report authority', async (t) => {
  const f = await fixture(t);
  const original = await f.service.delegateFromUser(f.task.id, 'worker', 'Old work');
  await eventually(() => f.latest().requests[0].status === 'awaiting_report');
  f.panes[1].agent_session!.value = 'new-session-worker';
  const replacement = await f.service.delegateFromUser(f.task.id, 'worker', 'New work');
  assert.notEqual(replacement.id, original.id);
  assert.equal(f.latest().requests[0].status, 'failed');
  assert.match(formatLocalized(f.latest().requests[0].error!, f.latest().requests[0].errorLocalization), /結果未確認/);
  assert.deepEqual(f.latest().participants.filter((agent) => agent.paneId === 'worker').map((agent) => agent.session?.value), ['session-worker', 'new-session-worker']);
  await assert.rejects(f.report(original.id, 'completed', 'old work by new process'), { code: 'session_changed' });
  await f.report(replacement.id, 'completed', 'New work completed.');
});

test('unknown native state is not readiness and periodic checkpoints do not create timeline noise', async (t) => {
  const f = await fixture(t);
  f.panes[1].agent_status = 'unknown';
  await assert.rejects(f.service.delegateFromUser(f.task.id, 'worker', 'Unknown worker'), { code: 'agent_not_ready' });
  f.panes[1].agent_status = 'idle';
  f.panes[1].agent_session = undefined;
  await assert.rejects(f.service.delegateFromUser(f.task.id, 'worker', 'Unidentified worker'), { code: 'session_unavailable' });
  const beforeEvents = f.latest().events.length;
  await f.service.prepareCheckpoint(f.task.id);
  await f.service.prepareCheckpoint(f.task.id);
  assert.equal(f.latest().events.length, beforeEvents, 'periodic checkpoint capture does not fill the activity timeline');
});

test('uncertain planner setup is recorded and actual CLI status confirms the entry without replay', async (t) => {
  let failSetup = false;
  let setupAttempts = 0;
  const f = await fixture(t, { prompt: async () => { setupAttempts++; if (failSetup) throw Object.assign(new Error('setup socket timeout'), { code: 'timeout' }); } });
  const next = pane('second-planner'); next.tab_id = 'tab-2'; f.panes.push(next);
  const second = await f.service.ensureTask({ tabId: 'tab-2', title: 'Second task', repositoryRoot: '/repo', checkoutPath: '/repo', plannerPaneId: next.pane_id });
  failSetup = true;
  await assert.rejects(f.service.enablePlanner(second.id), /setup socket timeout/);
  const failed = f.service.getTasks().find((task) => task.id === second.id)!;
  assert.equal(failed.plannerDelivery?.status, 'uncertain');
  assert.match(formatLocalized(failed.events.at(-1)!.text, failed.events.at(-1)!.localization), /不會自動重送/);
  await assert.rejects(f.service.enablePlanner(second.id), { code: 'planner_delivery_uncertain' });
  assert.equal(setupAttempts, 2);
  await f.service.rpc({ command: 'status', taskId: second.id, caller: { paneId: next.pane_id, generation: 1 }, args: {} });
  assert.equal(f.service.getTasks().find((task) => task.id === second.id)!.plannerDelivery?.status, 'sent');
  assert.equal(setupAttempts, 2);
});

test('handoff can recover when the original planner session disappeared without interrupting the replacement', async (t) => {
  const f = await fixture(t);
  f.panes[0].agent_session!.value = 'replacement-planner';
  await f.service.beginHandoff(f.task.id, { targetPaneId: 'next' });
  assert.deepEqual(f.pauses, [], 'do not send Escape to a different session reusing the old pane');
  assert.equal(f.latest().handoffs.at(-1)!.status, 'awaiting_accept');
  assert.ok(f.latest().events.some((event) => /舊規劃者 session 已不存在/.test(formatLocalized(event.text, event.localization))));
  await f.rpc('accept', { handoffId: f.latest().handoffs.at(-1)!.id }, 'next', 2);
  assert.equal(f.latest().planner.paneId, 'next');
  assert.equal(f.latest().handoffs.at(-1)!.from.session?.value, 'session-planner', 'history retains the original planner identity');
});

test('a slow background checkpoint cannot overwrite a newer handoff or newer capture', async (t) => {
  const oldCapture = deferred<string>();
  let captures = 0;
  const f = await fixture(t, { captureCheckpoint: async () => ++captures === 1 ? oldCapture.promise : 'NEW handoff source' });
  const background = f.service.prepareCheckpoint(f.task.id);
  await eventually(() => captures === 1);
  await f.service.beginHandoff(f.task.id, { targetPaneId: 'next' });
  oldCapture.resolve('OLD planner source');
  await background;
  assert.match(f.latest().checkpoint!.text, /NEW handoff source/);
  assert.doesNotMatch(f.latest().checkpoint!.text, /OLD planner source/);

  const slow = deferred<string>();
  let sameGenerationCaptures = 0;
  f.host.captureCheckpoint = async () => ++sameGenerationCaptures === 1 ? slow.promise : 'NEWEST periodic source';
  const earlier = f.service.prepareCheckpoint(f.task.id);
  await eventually(() => sameGenerationCaptures === 1);
  await f.service.prepareCheckpoint(f.task.id);
  slow.resolve('SLOW periodic source');
  await earlier;
  assert.match(f.latest().checkpoint!.text, /NEWEST periodic source/);
  assert.doesNotMatch(f.latest().checkpoint!.text, /SLOW periodic source/);
});

test('disposing during initialization releases both the owner and endpoint; configured presets reach planner prompts', async (t) => {
  const f = await fixture(t);
  assert.match(f.service.getCollaborationPrompt(f.task.id), /model-from-config/);
  assert.equal((await f.rpc('status', {}) as any).presets[0].id, 'codex');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-collab-start-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = new CollaborationService({ storageDir: directory, cliPath: '/extension/dist/herdr-collab.cjs', host: f.host });
  const initializing = service.initialize();
  await service.dispose();
  await initializing;
  assert.ok(!(await fs.readdir(directory)).some((file) => file === 'owner.json' || file === 'owner.guard' || file.startsWith('connection.')));
  const next = new CollaborationService({ storageDir: directory, cliPath: '/extension/dist/herdr-collab.cjs', host: f.host });
  await next.initialize();
  await next.dispose();
});

test('persisted system events follow the current locale while user text and report evidence stay unchanged', async (t) => {
  const previous = getLocale();
  t.after(() => setLocale(previous));
  setLocale('zh-tw');
  const f = await fixture(t);
  const original = 'Created a task for this tab.';
  await f.service.recordUserMessage(f.task.id, 'planner', original);
  const memoryTitle = '保留 {0} 和 $&';
  await f.service.addMemoryReference(f.task.id, { id: 42, title: memoryTitle, text: '原始記憶內容' });
  const request = await f.service.delegateFromUser(f.task.id, 'worker', '不要改變這份工作文字 {0}');
  await f.report(request.id, 'completed', '原始回報：測試 12/12 通過。');
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'tasks.json'), 'utf8')).tasks[0] as CollaborationTask;
  const originalSnapshot = JSON.stringify(disk);
  const created = disk.events.find((event) => event.type === 'task_created')!;
  const saved = disk.events.find((event) => event.type === 'memory_saved')!;
  const user = disk.events.find((event) => event.type === 'user_message')!;
  const report = disk.events.find((event) => event.type === 'reported')!;
  assert.equal(created.text, original, 'persist the canonical English fallback');
  assert.equal(formatLocalized(created.text, created.localization), '已建立此 tab 的任務。');
  assert.equal(formatLocalized(saved.text, saved.localization), `已保存 Claude-mem 記憶 #42：${memoryTitle}`);
  assert.equal(user.localization, undefined);
  assert.equal(formatLocalized(user.text, user.localization), original, 'text equal to a translation key is still user data');
  setLocale('en');
  assert.equal(formatLocalized(created.text, created.localization), original);
  assert.equal(formatLocalized(saved.text, saved.localization), `Saved Claude-mem memory #42: ${memoryTitle}`);
  assert.equal(report.localization, undefined);
  assert.equal(formatLocalized(report.text, report.localization), '原始回報：測試 12/12 通過。');
  assert.equal(JSON.stringify(disk), originalSnapshot, 'changing presentation language never rewrites historical evidence');
});

test('service errors follow locale without changing machine-readable codes or placeholder values', async (t) => {
  const previous = getLocale();
  t.after(() => setLocale(previous));
  const f = await fixture(t);
  setLocale('en');
  await assert.rejects(f.rpc('report', {}, 'worker'), { code: 'invalid_argument', message: 'Required: requestId.' });
  await assert.rejects(f.service.delegateFromUser(f.task.id, 'worker', ''), { code: 'empty_prompt', message: 'Delegation text cannot be empty.' });
  setLocale('zh-tw');
  await assert.rejects(f.rpc('report', {}, 'worker'), { code: 'invalid_argument', message: '需要 requestId。' });
  await assert.rejects(f.service.delegateFromUser(f.task.id, 'worker', ''), { code: 'empty_prompt', message: '派工內容不能為空。' });
});
