import { t } from '../l10n.ts';
import { randomUUID } from 'node:crypto';
import { TaskStore } from './store.ts';
import { startBridge } from './bridge.ts';
import type { CollaborationBridge } from './bridge.ts';
import { englishMessage, setError, systemMessage } from './localization.ts';
import type {
  AgentIdentity, Caller, CollaborationEvent, CollaborationOptions, CollaborationRequest,
  CollaborationTask, EnsureTaskInput, Handoff, HandoffInput, LivePane, LocalizedMessage, MemoryReference, RpcInput,
} from './types.ts';

export class CollaborationError extends Error {
  readonly code: string;
  readonly localization?: LocalizedMessage;
  constructor(code: string, message: string | LocalizedMessage) {
    super(typeof message === 'string' ? message : t(message.message, ...(message.args ?? [])));
    this.name = 'CollaborationError'; this.code = code;
    if (typeof message === 'object') this.localization = message;
  }
}

const fail = (code: string, message: string | LocalizedMessage): never => { throw new CollaborationError(code, message); };
const errorText = (error: unknown): string | LocalizedMessage => error instanceof CollaborationError
  ? error.localization ?? error.message : error instanceof Error ? error.message : String(error);
const now = () => new Date().toISOString();
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const isFinished = (request: CollaborationRequest) => request.status === 'completed' || request.status === 'failed';
const stringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) return fail('invalid_argument', systemMessage('Required: {0}.', name));
  return value;
};
const optionalString = (args: Record<string, unknown>, name: string) => typeof args[name] === 'string' ? args[name] as string : undefined;
const boundedTimeout = (value: unknown, fallback = 180000) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 180000) return fail('invalid_timeout', systemMessage("Timeout must be between 1 and 180000 ms."));
  return value;
};

function identity(pane: LivePane): AgentIdentity {
  return {
    paneId: pane.pane_id, tabId: pane.tab_id, harness: pane.agent ?? pane.display_agent ?? 'terminal',
    name: pane.name ?? pane.label ?? undefined, terminalId: pane.terminal_id,
    session: pane.agent_session ? { kind: pane.agent_session.kind, value: pane.agent_session.value, source: pane.agent_session.source } : undefined,
  };
}

function checkIdentity(expected: AgentIdentity, live: LivePane): void {
  const actual = identity(live);
  if (expected.paneId !== actual.paneId || expected.tabId !== actual.tabId || expected.harness !== actual.harness ||
      (expected.terminalId && expected.terminalId !== actual.terminalId) ||
      (expected.session && (expected.session.kind !== actual.session?.kind || expected.session.value !== actual.session?.value))) {
    fail('session_changed', systemMessage("This pane's agent or session has changed. Select the agent again; previous requests will not be sent to the new session."));
  }
}

function addParticipant(task: CollaborationTask, agent: AgentIdentity): boolean {
  const exists = task.participants.some((item) => item.paneId === agent.paneId && item.tabId === agent.tabId && item.harness === agent.harness &&
    item.session?.kind === agent.session?.kind && item.session?.value === agent.session?.value &&
    (!item.terminalId || !agent.terminalId || item.terminalId === agent.terminalId));
  if (!exists) task.participants.push(structuredClone(agent));
  return !exists;
}

function addEvent(task: CollaborationTask, type: CollaborationEvent['type'], text: string | LocalizedMessage, extra: { paneId?: string; requestId?: string } = {}): void {
  const at = now();
  task.updatedAt = at;
  task.events.push({ id: randomUUID(), at, type,
    text: typeof text === 'string' ? text : englishMessage(text),
    ...(typeof text === 'object' ? { localization: text } : {}), ...extra });
}

function taskIn(tasks: CollaborationTask[], id: string): CollaborationTask {
  return tasks.find((task) => task.id === id) ?? fail('task_missing', systemMessage("Task not found."));
}
function requestIn(task: CollaborationTask, id: string): CollaborationRequest {
  return task.requests.find((request) => request.id === id) ?? fail('request_missing', systemMessage("Delegation request not found."));
}

/** Durable task state is independent of native terminal status. Only an explicit report completes work. */
export class CollaborationService {
  private readonly options: CollaborationOptions;
  private readonly store: TaskStore;
  private tasks: CollaborationTask[] = [];
  private serial: Promise<void> = Promise.resolve();
  private bridge?: CollaborationBridge;
  private disposed = false;
  private disposal?: Promise<void>;
  private initialization?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly captureVersions = new Map<string, number>();

  constructor(options: CollaborationOptions) { this.options = options; this.store = new TaskStore(options.storageDir); }

  get connectionFile(): string { return this.bridge?.connectionFile ?? ''; }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new CollaborationError('service_closed', systemMessage("The collaboration service has stopped.")));
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await this.store.acquire();
      try {
        if (this.disposed) return;
        this.tasks = await this.store.load();
        if (this.disposed) return;
        this.bridge = await startBridge(this.options.storageDir, (input) => this.rpc(input));
        if (this.disposed) return;
        await this.store.save(this.tasks);
        if (!this.disposed) this.publish();
      } catch (error) { await this.bridge?.dispose(); this.bridge = undefined; await this.store.release(); throw error; }
    })();
    return this.initialization;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const listener of [...this.listeners]) listener();
    this.disposal = (async () => {
      await this.initialization?.catch(() => undefined);
      const bridge = this.bridge; this.bridge = undefined;
      await bridge?.dispose(); await this.serial; await this.store.release();
    })();
    return this.disposal;
  }

  getTasks(): CollaborationTask[] { return structuredClone(this.tasks); }
  getTaskForTab(tabId: string): CollaborationTask | undefined {
    const task = this.tasks.find((item) => item.tabId === tabId && item.status !== 'archived');
    return task ? structuredClone(task) : undefined;
  }

  private task(taskId: string): CollaborationTask { return structuredClone(taskIn(this.tasks, taskId)); }
  private publish(): void {
    try { this.options.host.publish(this.getTasks()); } catch { /* Persisted state is still authoritative. */ }
    for (const listener of [...this.listeners]) listener();
  }

  /** Clone first: failed persistence must never publish an operation as successfully committed. */
  private mutate<T>(change: (tasks: CollaborationTask[]) => T): Promise<T> {
    const operation = this.serial.then(async () => {
      if (this.disposed) return fail('service_closed', systemMessage("The collaboration service has stopped."));
      const draft = structuredClone(this.tasks);
      const result = change(draft);
      await this.store.save(draft);
      this.tasks = draft;
      this.publish();
      return structuredClone(result);
    });
    this.serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async pane(paneId: string, tabId: string): Promise<LivePane> {
    const pane = (await this.options.host.listPanes()).find((item) => item.pane_id === paneId && item.tab_id === tabId);
    if (!pane) return fail('pane_missing', systemMessage("This agent is outside the task tab, or its pane has closed."));
    return pane;
  }

  private assertActive(task: CollaborationTask): void {
    if (task.status !== 'active') fail('planner_frozen', task.status === 'archived' ? systemMessage('This task is archived.') : systemMessage('Handoff is in progress. The previous planner is paused until the new planner accepts.'));
  }

  private assertPlanner(task: CollaborationTask, caller: Caller, live: LivePane): void {
    if (caller.generation !== task.generation) fail('stale_generation', systemMessage("Planning authority has moved. Stop delegating and use the new planner's entry."));
    this.assertActive(task);
    if (!task.enabled) fail('planner_disabled', systemMessage("Enable collaboration on the task page first."));
    if (caller.paneId !== task.planner.paneId) fail('not_planner', systemMessage("Only the current planner can delegate, create agents, and answer requests for this task."));
    checkIdentity(task.planner, live);
    this.checkCallerSession(caller, live);
  }

  private checkCallerSession(caller: Caller, live: LivePane): void {
    const sessionValue = live.agent_session?.value;
    if (!sessionValue) fail('session_unavailable', systemMessage("A verifiable native agent session is not available yet. Wait for the agent to be ready."));
    if (caller.sessionValue && caller.sessionValue !== sessionValue) fail('session_changed', systemMessage("The CLI entry does not match the current native session."));
  }

  private assertAvailable(tasks: CollaborationTask[], live: LivePane): void {
    for (const task of tasks) for (const request of task.requests) {
      if (request.target.paneId !== live.pane_id || isFinished(request)) continue;
      try { checkIdentity(request.target, live); }
      catch {
        request.status = 'failed'; request.updatedAt = now();
        setError(request, systemMessage('The original worker session no longer exists, and its result is unconfirmed. The new session can receive new requests; the original work will not be resent.'));
        addEvent(task, 'state_changed', request.errorLocalization!, { requestId: request.id, paneId: live.pane_id });
        continue;
      }
      fail('worker_busy', systemMessage("This worker session already has an unfinished request. Wait for its report or answer its question first."));
    }
  }

  private assertReady(live: LivePane): void {
    if (!live.agent && !live.display_agent) fail('agent_missing', systemMessage("No agent has started in this pane."));
    if (live.agent_status === 'working') fail('agent_busy', systemMessage("This agent is still working on its previous turn."));
    if (live.agent_status === 'blocked') fail('agent_blocked', systemMessage("This agent is waiting for native permission or a menu selection. Handle it in that pane first."));
    if (live.agent_status !== 'idle' && live.agent_status !== 'done') fail('agent_not_ready', systemMessage("Agent readiness has not been confirmed. Native idle or done status is required."));
    if (!live.agent_session?.value) fail('session_unavailable', systemMessage("A verifiable native agent session is not available yet. Confirm that the agent has finished starting."));
  }

  async ensureTask(input: EnsureTaskInput): Promise<CollaborationTask> {
    const current = this.getTaskForTab(input.tabId);
    if (current) return current.title === input.title ? current : this.updateTaskTitle(current.id, input.title);
    const livePanes = (await this.options.host.listPanes()).filter((pane) => pane.tab_id === input.tabId);
    const live = livePanes.find((pane) => pane.pane_id === input.plannerPaneId) ?? fail('pane_missing', systemMessage("The planner is outside the task tab, or its pane has closed."));
    return this.mutate((tasks) => {
      const found = tasks.find((item) => item.tabId === input.tabId && item.status !== 'archived');
      if (found) return found;
      const at = now();
      const planner = identity(live);
      const task: CollaborationTask = {
        id: randomUUID(), tabId: input.tabId, title: input.title, repositoryRoot: input.repositoryRoot,
        checkoutPath: input.checkoutPath, createdAt: at, updatedAt: at, status: 'active', generation: 1, enabled: false,
        planner, participants: [planner], requests: [], events: [], handoffs: [], userMessages: [], memoryReferences: [],
      };
      for (const pane of livePanes) if (pane.agent_session?.value) addParticipant(task, identity(pane));
      addEvent(task, 'task_created', systemMessage("Created a task for this tab.")); tasks.push(task); return task;
    });
  }

  async updateTaskTitle(taskId: string, title: string): Promise<CollaborationTask> {
    if (!title.trim()) return fail('empty_title', systemMessage("The task title cannot be empty."));
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); task.title = title; task.updatedAt = now(); return task;
    });
  }

  async registerParticipant(taskId: string, paneId: string): Promise<CollaborationTask> {
    const before = this.task(taskId);
    const live = await this.pane(paneId, before.tabId);
    if (!live.agent_session?.value) return fail('session_unavailable', systemMessage("A participant cannot be registered without a verifiable native agent session."));
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      if (addParticipant(task, identity(live))) {
        addEvent(task, 'state_changed', systemMessage('Registered {0} as a participant in this task.', live.name ?? live.pane_id), { paneId });
      }
      return task;
    });
  }

  async setPlannerFromUser(taskId: string, paneId: string): Promise<CollaborationTask> {
    const before = this.task(taskId);
    const live = await this.pane(paneId, before.tabId);
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); this.assertActive(task);
      if (task.enabled) fail('handoff_required', systemMessage("Collaboration is enabled. Use handoff to change the planner."));
      this.assertAvailable(tasks, live);
      task.planner = identity(live);
      addParticipant(task, task.planner);
      addEvent(task, 'planner_selected', systemMessage('Selected {0} as the planner.', task.planner.name ?? paneId), { paneId });
      return task;
    });
  }

  private prefix(task: CollaborationTask, generation = task.generation): string {
    return `${quote(this.options.nodeCommand ?? 'node')} ${quote(this.options.cliPath)} --connection ${quote(this.connectionFile)} --task ${quote(task.id)} --generation ${generation}`;
  }

  getCollaborationPrompt(taskId: string): string {
    const task = this.task(taskId);
    const entry = this.prefix(task);
    return [
      `You are the planner for Herdr task ${task.id} (tab ${task.tabId}, generation ${task.generation}).`,
      `Goal: ${task.goal ?? task.title}`,
      `Use this exact CLI entry from your own pane; HERDR_PANE_ID must remain the real caller:`, entry,
      'All commands return JSON. Preserve request IDs. Do not directly impersonate another pane or bypass this bridge to delegate.',
      `${entry} status`,
      `${entry} spawn <preset-id> [--model <model>] [--effort <effort>]`,
      `${entry} delegate <target-pane-id> "work and expected evidence" --wait --timeout 180000`,
      `${entry} wait <request-id> --timeout 180000`,
      `${entry} answer <request-id> "answer" --wait`,
      'One worker has one active request. Native idle/done is not task completion: wait for the worker\'s explicit report.',
      'needs_input releases wait: ask the user when needed, then answer the SAME request ID. Native blocked approval must be handled by the user in that pane.',
      'A timeout means delivery/completion is uncertain. Inspect status and wait again; never resend the work automatically.',
      'If stale_generation or planner_frozen is returned, stop orchestrating: a handoff is in progress. Original workers continue.',
      'Use status after any CLI connection interruption. Select supported preset IDs from the extension configuration.',
      `Available agent presets: ${JSON.stringify(this.options.host.listPresets?.() ?? [])}`,
    ].join('\n');
  }

  async enablePlanner(taskId: string): Promise<CollaborationTask> {
    const before = this.task(taskId);
    const live = await this.pane(before.planner.paneId, before.tabId);
    checkIdentity(before.planner, live); this.assertReady(live);
    const result = await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); this.assertActive(task); checkIdentity(task.planner, live);
      if (task.enabled) {
        if (task.plannerDelivery?.status === 'uncertain') fail('planner_delivery_uncertain', systemMessage("Delivery of the planner entry is unconfirmed and will not be retried automatically. Copy the collaboration entry to the original pane and run status to verify it."));
        return { task, send: false };
      }
      task.enabled = true;
      task.plannerDelivery = { status: 'sending', at: now() };
      // Pin the session that was actually enabled, including one discovered after task creation.
      task.planner = identity(live);
      addParticipant(task, task.planner);
      addEvent(task, 'planner_enabled', systemMessage("Created the collaboration entry and started sending it to the planner."), { paneId: task.planner.paneId });
      return { task, send: true };
    });
    if (result.send) {
      try {
        await this.options.host.prompt(result.task.planner.paneId, this.getCollaborationPrompt(taskId), { wait: false, timeoutMs: 15000 });
        await this.mutate((tasks) => {
          const task = taskIn(tasks, taskId);
          if (task.generation === result.task.generation) task.plannerDelivery = { status: 'sent', at: now() };
        });
      } catch (error) {
        await this.mutate((tasks) => {
          const task = taskIn(tasks, taskId);
          if (task.generation !== result.task.generation) return;
          task.plannerDelivery = { status: 'uncertain', at: now() };
          setError(task.plannerDelivery, errorText(error));
          addEvent(task, 'state_changed', systemMessage('{0}; delivery of the planner entry is unconfirmed. Copy the entry and run status. It will not be resent automatically.', task.plannerDelivery.error), { paneId: task.planner.paneId });
        });
        throw error;
      }
    }
    return this.task(taskId);
  }

  async disablePlanner(taskId: string): Promise<CollaborationTask> {
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      if (task.status === 'archived') fail('task_archived', systemMessage("This task is archived."));
      task.enabled = false;
      task.status = 'active';
      task.generation++;
      delete task.plannerDelivery;
      for (const handoff of task.handoffs) {
        if (handoff.status === 'preparing' || handoff.status === 'awaiting_accept') {
          handoff.status = 'failed';
          setError(handoff, systemMessage("Collaboration was disabled."));
        }
      }
      addEvent(task, 'state_changed', systemMessage("Disabled collaboration for this task."), { paneId: task.planner.paneId });
      return task;
    });
  }

  async recordUserMessage(taskId: string, paneId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      if (task.status === 'archived') fail('task_archived', systemMessage("This task is archived."));
      task.goal ??= text;
      task.userMessages.push({ paneId, text, at: now() });
      addEvent(task, 'user_message', text, { paneId });
    });
  }

  private async checkpoint(task: CollaborationTask): Promise<string> {
    let source: string;
    try { source = await this.options.host.captureCheckpoint(task); }
    catch (error) {
      const marker = '# Original conversation / repository context\n\n';
      const previous = task.checkpoint?.text;
      const sourceIndex = previous?.indexOf(marker) ?? -1;
      source = `Live source unavailable: ${error instanceof Error ? error.message : String(error)}\n${previous && sourceIndex >= 0 ? previous.slice(sourceIndex + marker.length) : ''}`;
    }
    return [
      '# Herdr task checkpoint (captured original state; not an LLM summary)',
      JSON.stringify({ id: task.id, tabId: task.tabId, title: task.title, goal: task.goal, generation: task.generation,
        repositoryRoot: task.repositoryRoot, checkoutPath: task.checkoutPath, planner: task.planner,
        userMessages: task.userMessages, requests: task.requests, memoryReferences: task.memoryReferences }, null, 2),
      '# Original conversation / repository context', source,
    ].join('\n\n');
  }

  async prepareCheckpoint(taskId: string): Promise<CollaborationTask> {
    const before = this.task(taskId);
    const version = (this.captureVersions.get(taskId) ?? 0) + 1;
    this.captureVersions.set(taskId, version);
    const text = await this.checkpoint(before);
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      // A slow old-pane capture must not overwrite a handoff or a newer successful capture.
      if (task.generation !== before.generation || this.captureVersions.get(taskId) !== version) return task;
      task.checkpoint = { text, capturedAt: now() };
      task.updatedAt = now();
      return task;
    });
  }

  async archiveTask(tabId: string): Promise<void> {
    await this.mutate((tasks) => {
      const task = tasks.find((item) => item.tabId === tabId && item.status !== 'archived');
      if (!task) return;
      task.status = 'archived'; task.generation++;
      addEvent(task, 'task_archived', systemMessage("The task is archived. Previously delegated work can still report results."));
    });
  }

  async addMemoryReference(taskId: string, reference: Omit<MemoryReference, 'savedAt'>): Promise<void> {
    await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      const index = task.memoryReferences.findIndex((item) => String(item.id) === String(reference.id));
      const saved = { ...reference, savedAt: index >= 0 ? task.memoryReferences[index].savedAt : now() };
      if (index >= 0) task.memoryReferences[index] = saved;
      else task.memoryReferences.push(saved);
      addEvent(task, 'memory_saved', systemMessage('Saved Claude-mem memory #{0}: {1}', reference.id, reference.title ?? ''));
    });
  }

  async removeMemoryReference(taskId: string, memoryId: number): Promise<void> {
    await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      const index = task.memoryReferences.findIndex((item) => Number(item.id) === Number(memoryId));
      if (index < 0) return;
      const [removed] = task.memoryReferences.splice(index, 1);
      addEvent(task, 'state_changed', systemMessage('Removed Claude-mem memory #{0}: {1}', removed.id, removed.title ?? ''));
    });
  }

  async delegateFromUser(taskId: string, targetPaneId: string, text: string): Promise<CollaborationRequest> {
    return this.delegate(taskId, targetPaneId, text);
  }

  private workerPrompt(task: CollaborationTask, request: CollaborationRequest, text: string): string {
    const entry = this.prefix(task, request.generation);
    return [
      `Herdr request ${request.id}; revision ${request.revision}.`,
      `Original sender: ${JSON.stringify(request.requestedBy)}. Target: ${JSON.stringify(request.target)}.`,
      text,
      'Work only on this request. Report explicit results with the CLI below from your own pane. Include changes, tests, failures, and remaining work.',
      `${entry} report ${quote(request.id)} --revision ${request.revision} --status completed --text "result and evidence"`,
      `If input is needed: ${entry} report ${quote(request.id)} --revision ${request.revision} --status needs_input --text "specific question"`,
      `If unable to complete: ${entry} report ${quote(request.id)} --revision ${request.revision} --status failed --text "reason and completed work"`,
      'Do not mark completed until the requested work is actually complete. Report once; duplicate report IDs are safe, duplicate work is not.',
      'If the planner changes, keep working and report this original request. The bridge routes it to the task and retains original attribution.',
    ].join('\n\n');
  }

  private async delegate(taskId: string, targetPaneId: string, text: string, caller?: Caller, requestId?: string): Promise<CollaborationRequest> {
    if (!text.trim()) return fail('empty_prompt', systemMessage("Delegation text cannot be empty."));
    const before = this.task(taskId);
    const panes = await this.options.host.listPanes();
    const target = panes.find((item) => item.pane_id === targetPaneId && item.tab_id === before.tabId) ?? fail('pane_missing', systemMessage("The target agent is outside this task tab."));
    const sender = panes.find((item) => item.pane_id === before.planner.paneId && item.tab_id === before.tabId);
    const reserved = await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); this.assertActive(task);
      if (caller) this.assertPlanner(task, caller, sender ?? fail('pane_missing', systemMessage("The planner pane has closed.")));
      const existing = requestId ? task.requests.find((item) => item.id === requestId) : undefined;
      if (existing) {
        if (existing.prompt !== text || existing.target.paneId !== targetPaneId || existing.generation !== task.generation || existing.requestedBy.paneId !== task.planner.paneId) fail('request_conflict', systemMessage("The same request ID cannot be used for different work."));
        return { request: existing, send: false };
      }
      this.assertReady(target);
      if (task.planner.paneId === targetPaneId) fail('self_delegation', systemMessage("You cannot delegate to the current planner."));
      this.assertAvailable(tasks, target);
      const at = now();
      const request: CollaborationRequest = {
        id: requestId ?? randomUUID(), taskId, requestedBy: structuredClone(task.planner), target: identity(target),
        generation: task.generation, prompt: text, status: 'sending', createdAt: at, updatedAt: at,
        revision: 0, reports: [], replies: [], runtimeStatus: target.agent_status,
      };
      task.requests.push(request);
      addParticipant(task, request.target);
      addEvent(task, 'delegated', text, { requestId: request.id, paneId: targetPaneId });
      return { request, send: true };
    });
    if (reserved.send) this.launchNative(taskId, reserved.request.id, reserved.request.revision, this.workerPrompt(this.task(taskId), reserved.request, text));
    return reserved.request;
  }

  /** No retries here: a failed socket/wait does not prove the prompt was never delivered. */
  private launchNative(taskId: string, requestId: string, revision: number, prompt: string): void {
    void this.runNative(taskId, requestId, revision, prompt).catch(() => undefined);
  }

  private async runNative(taskId: string, requestId: string, revision: number, prompt: string): Promise<void> {
    let result: { agent?: { agent_status?: string } } | void;
    let deliveryError: unknown;
    let attempted = false;
    try {
      const request = requestIn(this.task(taskId), requestId);
      const live = await this.pane(request.target.paneId, request.target.tabId);
      checkIdentity(request.target, live);
      // Once reserved, a planner handoff does not cancel the original worker.
      const shouldSend = await this.mutate((tasks) => {
        const task = taskIn(tasks, taskId); const current = requestIn(task, requestId);
        if (current.revision === revision && current.status === 'sending') {
          current.status = 'running'; current.updatedAt = now();
          addEvent(task, 'state_changed', systemMessage("Sending to the native agent and waiting for an explicit report."), { requestId, paneId: current.target.paneId });
          return true;
        }
        return false;
      });
      if (!shouldSend) return;
      attempted = true;
      result = await this.options.host.prompt(request.target.paneId, prompt, { wait: true, timeoutMs: this.options.nativeTimeoutMs ?? 180000 });
    } catch (error) { deliveryError = error; }
    if (this.disposed) return;
    await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); const request = requestIn(task, requestId);
      // A report can arrive before agent.prompt resolves, and a question can already have been answered.
      if (request.revision !== revision || request.report || isFinished(request)) return;
      request.updatedAt = now();
      if (deliveryError) {
        const definitive = !attempted;
        request.status = definitive ? 'failed' : 'wait_expired';
        const detail = errorText(deliveryError);
        setError(request, definitive ? detail : systemMessage('{0}; delivery or completion is unconfirmed. The work will not be resent automatically. Inspect the pane or keep waiting.', typeof detail === 'string' ? detail : englishMessage(detail)));
      } else {
        request.runtimeStatus = result?.agent?.agent_status ?? 'unknown';
        request.status = request.runtimeStatus === 'blocked' ? 'needs_input' : 'awaiting_report';
        if (request.runtimeStatus === 'blocked') setError(request, systemMessage('The native agent is waiting for permission or a menu selection. Handle it in the pane; this is not a worker completion report.'));
      }
      addEvent(task, 'state_changed', request.errorLocalization ?? request.error ?? systemMessage('Native status: {0}. Waiting for the worker\'s explicit report.', request.runtimeStatus), { requestId, paneId: request.target.paneId });
    });
  }

  async answerFromUser(taskId: string, requestId: string, text: string): Promise<CollaborationRequest> {
    return this.answer(taskId, requestId, text);
  }

  private async answer(taskId: string, requestId: string, text: string, caller?: Caller): Promise<CollaborationRequest> {
    if (!text.trim()) return fail('empty_answer', systemMessage("The answer cannot be empty."));
    const before = this.task(taskId); const prior = requestIn(before, requestId);
    const panes = await this.options.host.listPanes();
    const target = panes.find((item) => item.pane_id === prior.target.paneId && item.tab_id === before.tabId) ?? fail('pane_missing', systemMessage("The original worker pane has closed."));
    checkIdentity(prior.target, target); this.assertReady(target);
    const sender = caller ? panes.find((item) => item.pane_id === caller.paneId && item.tab_id === before.tabId) : undefined;
    const updated = await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId); this.assertActive(task);
      if (caller) this.assertPlanner(task, caller, sender ?? fail('pane_missing', systemMessage("The planner pane has closed.")));
      const request = requestIn(task, requestId);
      if (request.status !== 'needs_input' || request.report?.status !== 'needs_input') fail('not_awaiting_answer', systemMessage("This request has no unanswered worker question. Handle native permission menus in the pane."));
      request.replies.push({ text, at: now(), by: structuredClone(task.planner) });
      request.revision++; request.status = 'sending'; request.report = undefined; setError(request, undefined); request.updatedAt = now();
      addEvent(task, 'answered', text, { requestId, paneId: request.target.paneId });
      return request;
    });
    this.launchNative(taskId, requestId, updated.revision, this.workerPrompt(this.task(taskId), updated, `Continue the same request after this answer:\n${text}\n\nOriginal work:\n${updated.prompt}`));
    return updated;
  }

  private async report(input: RpcInput): Promise<CollaborationRequest> {
    const id = stringArg(input.args, 'requestId');
    const reportId = stringArg(input.args, 'reportId');
    const text = stringArg(input.args, 'text');
    const status = input.args.status;
    if (status !== 'completed' && status !== 'needs_input' && status !== 'failed') return fail('invalid_report', systemMessage("Report status must be completed, needs_input, or failed."));
    const before = this.task(input.taskId); const request = requestIn(before, id);
    const live = await this.pane(input.caller.paneId, before.tabId);
    // Workers are deliberately not gated on the NEW planner generation.
    if (input.caller.paneId !== request.target.paneId) return fail('wrong_reporter', systemMessage("Only the target worker of the original request can report results."));
    checkIdentity(request.target, live); this.checkCallerSession(input.caller, live);
    return this.mutate((tasks) => {
      const task = taskIn(tasks, input.taskId); const current = requestIn(task, id);
      checkIdentity(current.target, live);
      const previous = current.reports.find((item) => item.reportId === reportId);
      if (previous) {
        if (previous.text !== text || previous.status !== status || previous.revision !== input.args.revision) fail('report_conflict', systemMessage("The same report ID cannot contain different content."));
        return current;
      }
      if (input.args.revision !== current.revision) fail('stale_revision', systemMessage("This report belongs to an earlier turn. Use the revision supplied by the latest answer."));
      if (isFinished(current) || current.report) fail('already_reported', systemMessage("This turn has already been reported. Check status and do not repeat the work."));
      // Pin a native session that became visible only after first dispatch.
      current.target.session ??= identity(live).session;
      const report: NonNullable<CollaborationRequest['report']> = { status, text, at: now(), reportId };
      current.report = report; current.reports.push({ ...report, revision: current.revision });
      current.status = status; current.updatedAt = report.at; setError(current, undefined);
      addEvent(task, 'reported', text, { requestId: id, paneId: current.target.paneId });
      return current;
    });
  }

  private waitFor(taskId: string, requestId: string, generation: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (reason: string, request?: CollaborationRequest) => {
        if (settled) return; settled = true;
        clearTimeout(timer); this.listeners.delete(check);
        resolve({ reason, request: request ? structuredClone(request) : undefined });
      };
      const check = () => {
        if (this.disposed) { finish('service_closed'); return; }
        const task = taskIn(this.tasks, taskId); const request = requestIn(task, requestId);
        if (task.generation !== generation || task.status !== 'active') { finish('planner_changed', request); return; }
        if (isFinished(request) || request.status === 'needs_input') finish(request.status, request);
      };
      this.listeners.add(check);
      timer = setTimeout(() => finish('wait_expired', requestIn(this.task(taskId), requestId)), timeoutMs);
      check();
    });
  }

  private async spawn(taskId: string, caller: Caller, args: Record<string, unknown>): Promise<unknown> {
    const before = this.task(taskId); const live = await this.pane(caller.paneId, before.tabId);
    this.assertPlanner(before, caller, live);
    // This reservation is a durable event; no host/native calls occur under the storage lock.
    await this.mutate((tasks) => { this.assertPlanner(taskIn(tasks, taskId), caller, live); });
    const paneId = await this.options.host.createAgent(stringArg(args, 'presetId'), before.tabId, optionalString(args, 'model'), optionalString(args, 'effort'));
    const created = await this.pane(paneId, before.tabId);
    return this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      const agent = identity(created); addParticipant(task, agent);
      addEvent(task, 'agent_created', systemMessage('Created {0} in this task.', agent.name ?? agent.harness), { paneId });
      return { agent, generation: task.generation, plannerChanged: task.generation !== caller.generation || task.status !== 'active',
        ready: !!created.agent_session?.value && (created.agent_status === 'idle' || created.agent_status === 'done'), runtimeStatus: created.agent_status,
        next: 'Use status to confirm the new agent has a native session and idle/done state before delegating.' };
    });
  }

  async beginHandoff(taskId: string, input: HandoffInput): Promise<CollaborationTask> {
    if ((!input.targetPaneId && !input.presetId) || (input.targetPaneId && input.presetId)) return fail('invalid_target', systemMessage("Select an existing agent or a new agent preset."));
    const frozen = await this.mutate((tasks) => {
      const task = taskIn(tasks, taskId);
      if (task.status === 'archived') fail('task_archived', systemMessage("This task is archived."));
      if (input.targetPaneId === task.planner.paneId) fail('same_planner', systemMessage("Select another agent to take over."));
      if (task.handoffs.at(-1)?.status === 'preparing') fail('handoff_preparing', systemMessage("The handoff is still being prepared."));
      task.generation++; task.status = 'handoff_pending';
      const handoff: Handoff = {
        id: randomUUID(), generation: task.generation, from: structuredClone(task.planner), status: 'preparing', createdAt: now(), checkpoint: '',
      };
      task.handoffs.push(handoff);
      addEvent(task, 'handoff_started', systemMessage("The previous planner is paused. Workers continue while the new planner is asked to explicitly accept."), { paneId: task.planner.paneId });
      handoff.checkpointEventId = task.events.at(-1)?.id;
      return task;
    });
    const handoff = frozen.handoffs.at(-1)!;
    const captureVersion = (this.captureVersions.get(taskId) ?? 0) + 1;
    this.captureVersions.set(taskId, captureVersion);
    try {
      if (this.options.host.pausePlanner) {
        const previous = (await this.options.host.listPanes()).find((pane) => pane.pane_id === frozen.planner.paneId);
        let sameSession = false;
        if (previous) { try { checkIdentity(frozen.planner, previous); sameSession = true; } catch { /* The original session is gone; never pause its replacement. */ } }
        if (sameSession) await this.options.host.pausePlanner(frozen.planner.paneId);
        else await this.mutate((tasks) => {
          const task = taskIn(tasks, taskId);
          addEvent(task, 'state_changed', systemMessage("The previous planner session no longer exists. The stop operation was skipped to avoid interrupting its replacement in the same pane."), { paneId: frozen.planner.paneId });
        });
      }
      const checkpoint = await this.checkpoint(frozen);
      const paneId = input.targetPaneId ?? await this.options.host.createAgent(input.presetId!, frozen.tabId, input.model, input.effort);
      const live = await this.pane(paneId, frozen.tabId); this.assertReady(live);
      const prepared = await this.mutate((tasks) => {
        const task = taskIn(tasks, taskId);
        if (task.generation !== handoff.generation) fail('stale_handoff', systemMessage("This handoff has been superseded by a newer handoff."));
        this.assertAvailable(tasks, live);
        const current = task.handoffs.find((item) => item.id === handoff.id)!;
        current.target = identity(live); current.checkpoint = checkpoint; current.status = 'awaiting_accept';
        if (this.captureVersions.get(taskId) === captureVersion) task.checkpoint = { text: checkpoint, capturedAt: now() };
        addParticipant(task, current.target);
        addEvent(task, 'handoff_sent', systemMessage("The handoff data is ready. Waiting for the target agent to accept; the planner has not changed yet."), { paneId });
        return task;
      });
      const instruction = [
        `You are the candidate planner for Herdr handoff ${handoff.id}. The previous planner is frozen; existing workers keep running.`,
        'Read this checkpoint, then explicitly accept BEFORE orchestrating any work:',
        `${this.prefix(prepared)} accept ${quote(handoff.id)}`,
        'The accept response contains results and messages that arrived after this checkpoint. Read those updates before delegating.',
        this.getCollaborationPrompt(taskId), checkpoint,
      ].join('\n\n');
      await this.options.host.prompt(paneId, instruction, { wait: false, timeoutMs: 15000 });
    } catch (error) {
      if (!this.disposed) await this.mutate((tasks) => {
        const task = taskIn(tasks, taskId); const current = task.handoffs.find((item) => item.id === handoff.id)!;
        if (current.status === 'accepted') return;
        current.status = 'failed'; setError(current, errorText(error));
        addEvent(task, 'handoff_failed', systemMessage('{0}; the previous planner remains paused.', current.error));
      });
      throw error;
    }
    return this.task(taskId);
  }

  private async accept(input: RpcInput): Promise<unknown> {
    const id = stringArg(input.args, 'handoffId');
    const before = this.task(input.taskId); const handoff = before.handoffs.find((item) => item.id === id) ?? fail('handoff_missing', systemMessage("Handoff not found."));
    const live = await this.pane(input.caller.paneId, before.tabId);
    if (!handoff.target || handoff.target.paneId !== input.caller.paneId) return fail('wrong_acceptor', systemMessage("Only the agent designated for this handoff can accept it."));
    checkIdentity(handoff.target, live); this.checkCallerSession(input.caller, live);
    return this.mutate((tasks) => {
      const task = taskIn(tasks, input.taskId); const current = task.handoffs.find((item) => item.id === id)!;
      if (input.caller.generation !== task.generation || current.generation !== task.generation || task.status === 'archived') fail('stale_handoff', systemMessage("This handoff generation is no longer valid."));
      if (current.status !== 'awaiting_accept' && current.status !== 'accepted' && current.status !== 'failed') fail('handoff_not_ready', systemMessage("The handoff data is not ready yet."));
      checkIdentity(current.target!, live);
      const index = task.events.findIndex((event) => event.id === current.checkpointEventId);
      const updates = task.events.slice(index + 1).filter((event) => !['handoff_sent', 'handoff_accepted', 'handoff_delta'].includes(event.type));
      if (current.status !== 'accepted') {
        this.assertAvailable(tasks, live);
        current.status = 'accepted'; current.acceptedAt = now(); setError(current, undefined);
        current.target = identity(live); task.planner = identity(live); task.enabled = true; task.status = 'active'; task.plannerDelivery = { status: 'sent', at: now() };
        addParticipant(task, task.planner);
        addEvent(task, 'handoff_accepted', systemMessage("The new planner explicitly accepted. Planning authority has transferred."), { paneId: live.pane_id });
        if (updates.length) addEvent(task, 'handoff_delta', systemMessage('Delivered {0} updates from the handoff period to the new planner.', updates.length), { paneId: live.pane_id });
      }
      return { task, updates, requests: task.requests, next: 'Read updates and requests; use status/wait to collect subsequent worker reports.' };
    });
  }

  /** Public for the private HTTP bridge and deterministic transport tests. */
  async rpc(input: RpcInput): Promise<unknown> {
    if (this.disposed) return fail('service_closed', systemMessage("The collaboration service has stopped."));
    if (input.command === 'report') return this.report(input);
    if (input.command === 'accept') return this.accept(input);
    const task = this.task(input.taskId); const live = await this.pane(input.caller.paneId, task.tabId);
    if (input.command === 'status') {
      const participants = [task.planner, ...task.participants, ...task.requests.map((item) => item.target)].filter((item) => item.paneId === input.caller.paneId);
      if (!participants.length) return fail('not_participant', systemMessage("This pane is not a participant in this task."));
      const matched = participants.some((participant) => { try { checkIdentity(participant, live); return true; } catch { return false; } });
      if (!matched) return fail('session_changed', systemMessage("The current session in this pane is not a participant in this task."));
      this.checkCallerSession(input.caller, live);
      if (task.planner.paneId === input.caller.paneId && input.caller.generation === task.generation && task.plannerDelivery?.status !== 'sent' && task.status === 'active') {
        await this.mutate((tasks) => {
          const current = taskIn(tasks, input.taskId);
          if (current.generation === input.caller.generation) current.plannerDelivery = { status: 'sent', at: now() };
        });
      }
      return { task: this.task(input.taskId), presets: this.options.host.listPresets?.() ?? [], panes: (await this.options.host.listPanes()).filter((item) => item.tab_id === task.tabId).map((item) => ({ ...identity(item), runtimeStatus: item.agent_status })) };
    }
    this.assertPlanner(this.task(input.taskId), input.caller, live);
    if (input.command === 'spawn') return this.spawn(input.taskId, input.caller, input.args);
    if (input.command === 'delegate') {
      const request = await this.delegate(input.taskId, stringArg(input.args, 'targetPaneId'), stringArg(input.args, 'text'), input.caller, optionalString(input.args, 'requestId'));
      return input.args.wait === true ? this.waitFor(input.taskId, request.id, input.caller.generation, boundedTimeout(input.args.timeoutMs)) : { request };
    }
    if (input.command === 'answer') {
      const request = await this.answer(input.taskId, stringArg(input.args, 'requestId'), stringArg(input.args, 'text'), input.caller);
      return input.args.wait === true ? this.waitFor(input.taskId, request.id, input.caller.generation, boundedTimeout(input.args.timeoutMs)) : { request };
    }
    if (input.command === 'wait') {
      const id = stringArg(input.args, 'requestId'); requestIn(task, id);
      return this.waitFor(input.taskId, id, input.caller.generation, boundedTimeout(input.args.timeoutMs));
    }
    return fail('unknown_command', systemMessage("Unknown collaboration command."));
  }
}
