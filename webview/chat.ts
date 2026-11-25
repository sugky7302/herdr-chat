// 對話頁：Copilot 樣式的訊息列表與輸入框。

import { getIntlLocale, t } from '../src/l10n.ts';
import { shortModel } from '../src/modelName';
import type { AgentView, ChatMessage, CompletionItem, FromWebview, PresetView, Transcript } from '../src/shared';
import { renderMarkdown } from './markdown';

type Child = Node | string | null | undefined | false;

export interface ChatHost {
  send(message: FromWebview): void;
  persist(): void;
  h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any>, ...children: Child[]): HTMLElementTagNameMap[K];
  icon(name: string): HTMLElement;
  agent(paneId: string): AgentView | undefined;
  preset(agent: AgentView | undefined): PresetView | undefined;
  drafts: Record<string, Draft>;
  saveMemory?(paneId: string, message: ChatMessage, messageIndex: number, selectedText?: string): void;
  readOnly?(paneId: string): string | undefined;
}

export interface Draft {
  text: string;
  model?: string;
  effort?: string;
  modelDirty?: boolean;
  effortDirty?: boolean;
  attachments?: string[];
}

interface CompletionState {
  trigger: '/' | '@';
  start: number;
  query: string;
  items: CompletionItem[];
  index: number;
  requestId: number;
}

interface QueueEdit {
  id: number;
  text: string;
  attachments: string[];
  saving: boolean;
  error?: string;
}

const SCREEN_KEYS: { label: string; keys: string[]; title: string }[] = [
  { label: '↑', keys: ['up'], title: "Up" },
  { label: '↓', keys: ['down'], title: "Down" },
  { label: 'Enter', keys: ['enter'], title: "Confirm" },
  { label: 'Esc', keys: ['esc'], title: "Cancel" },
  { label: 'Tab', keys: ['tab'], title: 'Tab' },
  { label: 'Ctrl+C', keys: ['ctrl+c'], title: "Interrupt" },
];

const MAX_DROP_BYTES = 25 * 1024 * 1024;
/** 「傳送中」訊息最多顯示的時間。 */
const PENDING_MS = 15000;

export class ChatView {
  transcript: Transcript | null = null;
  readonly screenOpen = new Set<string>();
  /** 已送出、還沒出現在紀錄中的訊息。 */
  private pending: Record<string, { text: string; attachments?: string[]; at: number }[]> = {};
  private queueEdits: Record<string, QueueEdit> = {};
  private paneId: string | null = null;
  private messages: HTMLElement | null = null;
  private composer: HTMLElement | null = null;
  private scrollButton: HTMLElement | null = null;
  private composerKey = '';
  private bodyKey = '';
  private input: HTMLTextAreaElement | null = null;
  private composingElement: HTMLTextAreaElement | null = null;
  private composerParts: { dialog: HTMLElement; queue: HTMLElement; mode: HTMLElement; chips: HTMLElement; toolbar: HTMLElement; form: HTMLFormElement } | null = null;
  private completion: CompletionState | null = null;
  private completionTimer: number | undefined;
  private nextRequestId = 1;
  private stickToBottom = true;
  /** 保留手動開關狀態；目前回合完成時自動摺疊。 */
  private readonly toolGroups = new Map<string, { open: boolean; active: boolean }>();
  /** 進行中回合的即時秒數計時器與起始時間。 */
  private thinkingTimer: number | undefined;
  private activeTurnStart = new Map<string, number>();
  /** 目前開啟的標籤選單。 */
  private openPicker: 'model' | 'effort' | null = null;

  constructor(private readonly host: ChatHost) {
    this.installDrop();
  }

  /** 建立對話頁的主體。工具列由呼叫端負責。 */
  mount(paneId: string): HTMLElement[] {
    const { h } = this.host;
    this.rememberToolGroups();
    if (this.paneId !== paneId) {
      this.stickToBottom = true;
      this.completion = null;
    }
    this.paneId = paneId;
    this.composerKey = '';
    this.bodyKey = '';
    this.input = null;
    this.composingElement = null;
    this.composerParts = null;
    const previous = this.messages;
    const keepScroll = previous && !this.stickToBottom ? previous.scrollTop : null;
    this.messages = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
    this.messages.addEventListener('scroll', () => this.onScroll());
    this.scrollButton = h(
      'button',
      {
        class: 'scroll-bottom',
        title: t("Scroll to latest message"),
        'aria-label': t("Scroll to latest message"),
        onclick: () => this.scrollToBottom(true),
      },
      this.host.icon('down'),
    );
    this.composer = h('div', { class: 'composer' });
    const wrap = h('div', { class: 'messages-wrap' }, this.messages, this.scrollButton);
    this.renderBody();
    const messages = this.messages;
    requestAnimationFrame(() => {
      if (this.messages !== messages || !messages.isConnected) return;
      if (this.stickToBottom) this.scrollToBottom();
      else if (keepScroll !== null) messages.scrollTop = keepScroll;
    });
    return [wrap, this.composer];
  }

  /** 更新目前窗格的內容，不重建聊天區。 */
  refresh(): void {
    this.renderBody();
  }

  setTranscript(next: Transcript): void {
    const list = this.pending[next.paneId];
    if (list?.length) {
      const seen = next.messages.filter((m) => m.role === 'user').map((m) => m.text);
      const queued = (next.queue ?? []).map((item) => item.text);
      const now = Date.now();
      // 紀錄中出現、已進入佇列，或超過 15 秒的「傳送中」訊息都移除，避免同一則訊息顯示兩次。
      this.pending[next.paneId] = list.filter(
        (item) =>
          now - item.at < PENDING_MS &&
          !queued.includes(item.text) &&
          !seen.some((existing) => existing.includes(item.text.trim())),
      );
    }
    this.transcript = next;
    this.renderBody();
  }

  clearTranscript(): void {
    this.transcript = null;
  }

  finishQueueEdit(paneId: string, id: number, error?: string): void {
    const edit = this.queueEdits[paneId];
    if (!edit || edit.id !== id) return;
    if (error) {
      edit.saving = false;
      edit.error = error;
    } else {
      delete this.queueEdits[paneId];
    }
    if (this.paneId !== paneId) return;
    this.composerKey = '';
    this.renderComposer();
    document.getElementById(`composer-${paneId}`)?.focus();
  }

  private cancelQueueEdit(paneId: string): void {
    if (this.queueEdits[paneId]?.saving) return;
    delete this.queueEdits[paneId];
    this.closeCompletion();
    this.composerKey = '';
    this.renderComposer();
    document.getElementById(`composer-${paneId}`)?.focus();
  }

  onCompletions(requestId: number, items: CompletionItem[]): void {
    if (!this.completion || this.completion.requestId !== requestId) return;
    this.completion.items = items;
    this.completion.index = 0;
    this.renderCompletion();
  }

  addAttachments(paneId: string, paths: string[]): void {
    if (paths.length) this.flash(t("Files attached: {0}", paths.length));
    const draft = this.draft(paneId);
    draft.attachments = [...new Set([...(draft.attachments ?? []), ...paths])];
    this.host.persist();
    if (this.paneId === paneId) {
      this.composerKey = '';
      this.renderComposer();
    }
  }

  private draft(paneId: string): Draft {
    return (this.host.drafts[paneId] ??= { text: '' });
  }

  // ---------- 捲動 ----------

  private atBottom(): boolean {
    const m = this.messages;
    return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 32;
  }

  private onScroll(): void {
    this.stickToBottom = this.atBottom();
    this.scrollButton?.classList.toggle('visible', !this.stickToBottom);
  }

  private scrollToBottom(smooth = false): void {
    if (!this.messages) return;
    this.messages.scrollTo({ top: this.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.stickToBottom = true;
    this.scrollButton?.classList.remove('visible');
  }

  // ---------- 訊息 ----------

  /** 在重建訊息前保存原生 details 狀態，不依賴非同步的 toggle 事件。 */
  private rememberToolGroups(): string | undefined {
    let focused: string | undefined;
    for (const group of this.messages?.querySelectorAll<HTMLDetailsElement>('.tool-group') ?? []) {
      const key = group.dataset.toolKey!;
      const state = this.toolGroups.get(key);
      if (state) state.open = group.open;
      if (group.contains(document.activeElement)) focused = key;
    }
    return focused;
  }

  private renderBody(): void {
    if (!this.paneId || !this.messages) return;
    const paneId = this.paneId;
    const { h } = this.host;
    const stick = this.stickToBottom;
    const scrollTop = this.messages.scrollTop;
    const items: HTMLElement[] = [];
    const transcript = this.transcript?.paneId === paneId ? this.transcript : null;
    const agent = this.host.agent(paneId);
    const key = JSON.stringify([transcript?.source, transcript?.messages, this.pending[paneId], agent?.status, agent?.label, agent?.name, agent?.kind]);
    if (key !== this.bodyKey) {
      const focusedTool = this.rememberToolGroups();
      this.bodyKey = key;
      if (!transcript) {
        items.push(h('div', { class: 'muted pad' }, h('span', { class: 'spinner' }), t("Loading conversation…")));
      } else {
        const turns = this.renderTurns(transcript.messages, agent);
        items.push(...turns);
        for (const item of this.pending[paneId] ?? []) items.push(this.renderUser(item.text, true, item.attachments));
        const hasThinkingHeader = turns.some((node) => node.querySelector('.turn-log.active'));
        if (agent?.status === 'working' && items.length > 0 && !hasThinkingHeader) {
          items.push(h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), t("Working…")));
        }
      }
      this.messages.replaceChildren(...this.groupExchanges(items));
      if (focusedTool) {
        for (const group of this.messages.querySelectorAll<HTMLElement>('.tool-group')) {
          if (group.dataset.toolKey === focusedTool) group.querySelector('summary')?.focus({ preventScroll: true });
        }
      }
      this.syncThinkingTimer();
    }
    this.renderComposer();
    if (this.messages.isConnected) {
      if (stick) this.scrollToBottom();
      else this.messages.scrollTop = scrollTop;
    }
    this.scrollButton?.classList.toggle('visible', !stick);
  }

  /**
   * 把每則使用者訊息與後面的回覆包成一組。
   * 使用者訊息在組內用 sticky 固定，捲動回覆時問題會停在上方，捲到下一組時換成下一個問題。
   */
  private groupExchanges(items: HTMLElement[]): HTMLElement[] {
    const { h } = this.host;
    const out: HTMLElement[] = [];
    let group: HTMLElement | null = null;
    for (const item of items) {
      if (item.classList.contains('user')) {
        group = h('div', { class: 'exchange' }, item);
        const bubble = item.querySelector<HTMLElement>('.bubble');
        const exchange = group;
        // 問題固定在上方時，點一下會捲回這個問題的開頭。
        bubble?.addEventListener('click', () => {
          if (!this.messages || window.getSelection()?.toString()) return;
          const offset = exchange.getBoundingClientRect().top - this.messages.getBoundingClientRect().top;
          if (offset >= -1) return;
          this.messages.scrollTo({ top: this.messages.scrollTop + offset, behavior: 'smooth' });
        });
        out.push(group);
      } else if (group) {
        group.append(item);
      } else {
        out.push(item);
      }
    }
    return out;
  }

  /**
   * 把連續的助理文字與工具呼叫合併成一個回覆區塊。
   * 回合有工具呼叫時，外層摺疊顯示處理耗時，內層再把連續指令摺疊。
   */
  private renderTurns(messages: ChatMessage[], agent: AgentView | undefined): HTMLElement[] {
    const { h } = this.host;
    const out: HTMLElement[] = [];
    const agentName = agent?.label || agent?.name || agent?.kind || 'agent';
    const working = agent?.status === 'working';
    const finished = agent?.status === 'idle' || agent?.status === 'done' || agent?.status === 'shell';
    const lastUser = messages.reduce((last, message, index) => (message.role === 'user' ? index : last), -1);
    const occurrences = new Map<string, number>();
    let userText = '';
    let userTimestamp: number | undefined;
    const lastIndex = messages.length - 1;

    interface TurnItem {
      message: ChatMessage;
      index: number;
    }

    let turnItems: TurnItem[] = [];
    let turnStart = -1;
    let turnUserText = '';
    let turnUserTs: number | undefined;

    const bindDetails = (identity: string, start: number, defaultOpen: boolean) => {
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const groupKey = JSON.stringify([identity, occurrence]);
      const previous = this.toolGroups.get(groupKey);
      // 等待確認或暫時失去狀態時，保留展開內容，直到確認工作完成。
      const active = start > lastUser && !finished && (previous ? previous.active : working || agent?.status === 'blocked');
      const open = previous ? Boolean(previous.open && !(previous.active && !active)) : defaultOpen;
      this.toolGroups.set(groupKey, { open, active });
      return { groupKey, open };
    };

    const renderCommandGroup = (tools: TurnItem[], turnUser: string, isTurnLast: boolean): HTMLDetailsElement => {
      const first = tools[0];
      const identity = JSON.stringify([this.paneId, this.transcript?.source, 'cmd', turnUser, first.message.tool, first.message.text]);
      const { groupKey, open } = bindDetails(identity, first.index, false);
      const list = h('div', { class: 'tool-list' });
      for (const item of tools) {
        const iconName = toolIconName(item.message.tool);
        list.append(
          h(
            'div',
            { class: 'tool', title: item.message.text },
            this.host.icon(iconName),
            h('span', { class: 'tool-name' }, item.message.tool ?? 'tool'),
            h('span', { class: 'tool-text' }, toolSummary(item.message.tool, item.message.text)),
          ),
        );
      }
      const active = working && isTurnLast;
      const summaryIcon = this.host.icon(groupIconName(tools.map((item) => item.message.tool)));
      const label = commandGroupLabel(tools.map((item) => item.message));
      const count = h(
        'span',
        { class: 'tool-count' },
        ...(active
          ? [h('span', { class: 'spinner' }), label]
          : [summaryIcon, label]),
      );
      return h(
        'details',
        { class: `tool-group tool-command-group${active ? ' active' : ''}`, open, 'data-tool-key': groupKey },
        h('summary', {}, count),
        list,
      );
    };

    const flushTurn = () => {
      if (!turnItems.length) return;
      const items = turnItems;
      const start = turnStart;
      const currentUserText = turnUserText;
      const currentUserTs = turnUserTs;
      turnItems = [];
      turnStart = -1;

      const reply = h('div', { class: 'content' });
      out.push(h('div', { class: 'turn assistant', 'aria-label': t("Reply from {0}", agentName) }, reply));

      const hasTools = items.some((item) => item.message.role === 'tool');
      if (!hasTools) {
        for (const item of items) {
          if (item.message.role === 'assistant') {
            const body = h('div', { class: 'markdown' });
            body.innerHTML = renderMarkdown(item.message.text);
            reply.append(body);
            this.appendMemoryAction(reply, item.message, item.index, body);
          } else if (item.message.role === 'terminal') {
            reply.append(h('pre', { class: 'terminal' }, item.message.text));
          }
        }
        return;
      }

      // 找出最後一筆工具呼叫的位置；在它之後的助理回覆與終端機畫面放在外層摺疊區外，保持永遠可見。
      let lastToolIdx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].message.role === 'tool') {
          lastToolIdx = i;
          break;
        }
      }

      const firstTool = items.find((item) => item.message.role === 'tool')!;
      const identity = JSON.stringify([this.paneId, this.transcript?.source, currentUserText, firstTool.message.tool, firstTool.message.text]);
      const { groupKey, open } = bindDetails(identity, start, false);

      const logBody = h('div', { class: 'turn-log-body' });
      let toolBatch: TurnItem[] = [];
      let toolSteps = 0;

      const flushToolBatch = (batchEndIdx: number) => {
        if (!toolBatch.length) return;
        const isLast = items[batchEndIdx].index === lastIndex;
        logBody.append(renderCommandGroup(toolBatch, currentUserText, isLast));
        toolBatch = [];
      };

      for (let i = 0; i <= lastToolIdx; i++) {
        const item = items[i];
        if (item.message.role === 'tool') {
          toolSteps++;
          toolBatch.push(item);
        } else {
          flushToolBatch(i - 1);
          if (item.message.role === 'assistant') {
            const body = h('div', { class: 'markdown' });
            body.innerHTML = renderMarkdown(item.message.text);
            logBody.append(body);
            this.appendMemoryAction(logBody, item.message, item.index, body);
          } else if (item.message.role === 'terminal') {
            // 終端機畫面維持在外層，不被摺疊。
            reply.append(h('pre', { class: 'terminal' }, item.message.text));
          }
        }
      }
      flushToolBatch(lastToolIdx);

      const isTurnActive = working && items[items.length - 1].index === lastIndex;
      const recordedMs = turnDurationMs(currentUserTs, items);
      const explicitStart = turnStartTime(currentUserTs, items);
      let activeStart = explicitStart;
      if (isTurnActive) {
        if (activeStart !== undefined) {
          this.activeTurnStart.set(groupKey, activeStart);
        } else {
          activeStart = this.activeTurnStart.get(groupKey);
        }
      } else {
        this.activeTurnStart.delete(groupKey);
      }
      // 只有起始時間屬於最近 1 小時內的即時對話，才用 Date.now() 動態累計秒數；否則使用紀錄中的時間差。
      const now = Date.now();
      const isLiveStart = activeStart !== undefined && activeStart <= now && now - activeStart < 3_600_000;
      const activeMs = isLiveStart
        ? Math.max(recordedMs ?? 1000, now - activeStart!)
        : recordedMs;
      const durationText = (isTurnActive ? activeMs : recordedMs) !== undefined
        ? formatDurationMs((isTurnActive ? activeMs : recordedMs)!)
        : undefined;
      const headerLabel = isTurnActive
        ? durationText
          ? t('Thinking… {0}', durationText)
          : t('Thinking…')
        : durationText
          ? toolSteps === 1 ? t('Processed in {0} · {1} step', durationText, toolSteps) : t('Processed in {0} · {1} steps', durationText, toolSteps)
          : toolSteps === 1 ? t('Thought · {0} step', toolSteps) : t('Thought · {0} steps', toolSteps);

      const count = h(
        'span',
        { class: 'tool-count' },
        ...(isTurnActive ? [h('span', { class: 'spinner' }), headerLabel] : [headerLabel]),
      );
      const outerDetails = h(
        'details',
        {
          class: `tool-group turn-log${isTurnActive ? ' active' : ''}`,
          open,
          'data-tool-key': groupKey,
          ...(isTurnActive ? { 'data-turn-start': String(isLiveStart ? activeStart! : now - (recordedMs ?? 0)) } : {}),
        },
        h('summary', {}, count),
        logBody,
      );
      reply.prepend(outerDetails);

      for (let i = lastToolIdx + 1; i < items.length; i++) {
        const item = items[i];
        if (item.message.role === 'assistant') {
          const body = h('div', { class: 'markdown' });
          body.innerHTML = renderMarkdown(item.message.text);
          reply.append(body);
          this.appendMemoryAction(reply, item.message, item.index, body);
        } else if (item.message.role === 'terminal') {
          reply.append(h('pre', { class: 'terminal' }, item.message.text));
        }
      }
    };

    messages.forEach((message, index) => {
      // 略過後備終端機文字，保留可讀訊息的原始索引。
      if (message.role === 'terminal' && this.transcript?.source === 'terminal') return;
      if (message.role === 'user') {
        flushTurn();
        userText = message.text;
        userTimestamp = message.endTimestamp ?? message.timestamp;
        const turn = this.renderUser(message.text);
        this.appendMemoryAction(turn, message, index, turn.querySelector('.bubble')!);
        out.push(turn);
        return;
      }
      if (message.role === 'notice') {
        flushTurn();
        out.push(h('div', { class: 'notice' }, message.text));
        return;
      }
      if (!turnItems.length) {
        turnStart = index;
        turnUserText = userText;
        turnUserTs = userTimestamp;
      }
      turnItems.push({ message, index });
    });
    flushTurn();
    return out;
  }

  private syncThinkingTimer(): void {
    window.clearInterval(this.thinkingTimer);
    this.thinkingTimer = undefined;
    const activeLog = this.messages?.querySelector<HTMLElement>('.turn-log.active[data-turn-start]');
    if (!activeLog) return;
    const key = activeLog.dataset.toolKey;
    let start = Number(activeLog.dataset.turnStart);
    if (!Number.isFinite(start) || start <= 0) start = Date.now();
    if (key && !this.activeTurnStart.has(key)) this.activeTurnStart.set(key, start);
    this.thinkingTimer = window.setInterval(() => {
      const node = this.messages?.querySelector<HTMLElement>('.turn-log.active[data-turn-start]');
      if (!node || !node.isConnected) {
        window.clearInterval(this.thinkingTimer);
        this.thinkingTimer = undefined;
        return;
      }
      const count = node.querySelector<HTMLElement>(':scope > summary > .tool-count');
      if (!count) return;
      const label = t('Thinking… {0}', formatDurationMs(Math.max(1000, Date.now() - start)));
      const spinner = count.querySelector('.spinner') ?? this.host.h('span', { class: 'spinner' });
      count.replaceChildren(spinner, label);
    }, 1000);
  }

  private appendMemoryAction(parent: HTMLElement, message: ChatMessage, messageIndex: number, body: Element): void {
    if (!this.host.saveMemory || !this.paneId || !message.text.trim()) return;
    const paneId = this.paneId;
    const { h } = this.host;
    parent.append(h('div', { class: 'message-actions' }, h('button', {
      class: 'link save-message-memory', title: t("Save this message or the selected text"),
      onclick: () => {
        const selection = window.getSelection();
        const selectedText = selection?.rangeCount && body.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : undefined;
        this.host.saveMemory?.(paneId, message, messageIndex, selectedText);
      },
    }, t("Save as memory"))));
  }

  private renderUser(text: string, pending = false, extraAttachments?: string[]): HTMLElement {
    const { h, icon } = this.host;
    const parsed = splitUserAttachments(text);
    const files = [...parsed.attachments, ...(extraAttachments ?? []).filter((f) => !parsed.attachments.includes(f))];
    const chips = files.map((file) =>
      h(
        'span',
        { class: 'chip', title: file },
        icon('file'),
        h('span', { class: 'chip-text' }, file.split('/').pop() ?? file),
      ),
    );
    return h(
      'div',
      { class: `turn user ${pending ? 'pending' : ''}`, 'aria-label': pending ? t("Your message (sending)") : t("Your message") },
      h(
        'div',
        { class: 'bubble', title: pending ? t("Sending") : undefined },
        chips.length ? h('div', { class: 'bubble-chips' }, ...chips) : null,
        parsed.body ? h('div', { class: 'bubble-text' }, parsed.body) : null,
      ),
    );
  }

  // ---------- 輸入區 ----------

  private renderComposer(): void {
    if (!this.paneId || !this.composer) return;
    // 組字完成前，延後編輯模式與工具列的更新。
    if (this.composingElement?.isConnected) return;
    const paneId = this.paneId;
    const { h, icon, send } = this.host;
    const agent = this.host.agent(paneId);
    const preset = this.host.preset(agent);
    const transcript = this.transcript?.paneId === paneId ? this.transcript : null;
    const readOnly = this.host.readOnly?.(paneId);
    const edit = this.queueEdits[paneId];
    const available = transcript ? Boolean(edit && transcript.queue?.some((item) => item.id === edit.id)) : null;
    const key = JSON.stringify([
      paneId,
      readOnly,
      agent?.status,
      preset?.id,
      transcript && [transcript.model, transcript.effort, transcript.screen, transcript.dialog, transcript.queue, transcript.usage],
      this.screenOpen.has(paneId),
      this.queueEdits[paneId] && [this.queueEdits[paneId].id, this.queueEdits[paneId].saving, this.queueEdits[paneId].error],
    ]);
    if (key === this.composerKey && this.composer.childElementCount) return;
    this.composerKey = key;

    const draft = this.draft(paneId);
    const currentModel = transcript?.model;
    const currentEffort = transcript?.effort;
    if (!draft.modelDirty) draft.model = currentModel;
    if (!draft.effortDirty) draft.effort = currentEffort;

    const focused = document.activeElement;
    const old = focused instanceof HTMLTextAreaElement && this.composer.contains(focused) ? focused : null;
    const focusedId = old?.id;
    const selection = old ? [old.selectionStart, old.selectionEnd] : null;
    const working = agent?.status === 'working' || agent?.status === 'blocked';
    const waiting = agent?.status === 'blocked' || Boolean(transcript?.dialog?.length);

    if (!this.input) {
      this.input = h('textarea', { id: `composer-${paneId}`, name: 'message', rows: 1, 'aria-label': t('Message') });
      this.trackComposition(this.input);
    }
    const textarea = this.input;
    const text = edit ? edit.text : draft.text;
    if (textarea.value !== text) textarea.value = text;
    textarea.disabled = Boolean(readOnly);
    textarea.readOnly = Boolean(edit?.saving);
    textarea.required = Boolean(edit && !edit.attachments.length);
    if (edit) {
      textarea.removeAttribute('aria-label');
      textarea.setAttribute('aria-labelledby', `queue-edit-${paneId}-label`);
      textarea.setAttribute('aria-describedby', `queue-edit-${paneId}-help queue-edit-${paneId}-error`);
    } else {
      textarea.setAttribute('aria-label', t('Message'));
      textarea.removeAttribute('aria-labelledby');
      textarea.removeAttribute('aria-describedby');
    }
    if (edit?.error) textarea.setAttribute('aria-invalid', 'true');
    else textarea.removeAttribute('aria-invalid');
    textarea.placeholder = edit ? t('Edit queued message (Enter to save, Shift+Enter for a new line)') : waiting
        ? t('Choose an option above. After choosing “Type something”, enter your answer here.')
        : working
          ? t("Working: Enter to queue, ⌘/Ctrl+Enter to send immediately")
          : t("Message, / commands, @ files (Enter to send)");
    const autosize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
    };
    textarea.oninput = () => {
      if (edit) {
        edit.text = textarea.value;
        edit.error = undefined;
        textarea.removeAttribute('aria-invalid');
        const error = document.getElementById(`queue-edit-${paneId}-error`);
        if (error) { error.hidden = true; error.textContent = ''; }
      } else {
        draft.text = textarea.value;
        this.host.persist();
      }
      autosize();
      this.updateCompletion(textarea, paneId);
    };
    textarea.onkeydown = (event) => this.onKeyDown(event, textarea, paneId, submit);
    textarea.onblur = () => setTimeout(() => this.closeCompletion(), 150);
    textarea.onpaste = (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        if (edit) this.flash(t('Attachments are preserved while editing queued messages.'));
        else void this.uploadFiles(paneId, files);
      }
    };

    const submit = (mode: 'queue' | 'now') => {
      if (this.composingElement === textarea || this.host.readOnly?.(paneId)) return;
      if (edit) {
        if (edit.saving || !available || !agent) return;
        if (!edit.text.trim() && !edit.attachments.length) {
          edit.error = t('Enter a message.');
          this.composerKey = '';
          this.renderComposer();
          textarea.focus();
          return;
        }
        edit.saving = true;
        edit.error = undefined;
        this.closeCompletion();
        this.composerKey = '';
        this.renderComposer();
        textarea.focus();
        send({ type: 'updateQueued', paneId, id: edit.id, text: edit.text });
        return;
      }
      const text = draft.text.trim();
      const attachments = draft.attachments ?? [];
      if (!text && !attachments.length) return;
      send({
        type: 'send',
        paneId,
        text,
        attachments,
        mode,
        model: draft.modelDirty ? draft.model : undefined,
        effort: draft.effortDirty ? draft.effort : undefined,
      });
      if (!working || mode === 'now') (this.pending[paneId] ??= []).push({ text, attachments: [...attachments], at: Date.now() });
      draft.text = '';
      draft.attachments = [];
      draft.modelDirty = false;
      draft.effortDirty = false;
      this.host.persist();
      this.closeCompletion();
      this.stickToBottom = true;
      this.composerKey = '';
      this.renderBody();
      document.getElementById(`composer-${paneId}`)?.focus();
    };

    // 附加檔案
    const chips = (edit?.attachments ?? draft.attachments ?? []).map((file) =>
      h(
        'span',
        { class: 'chip', title: file },
        icon('file'),
        h('span', { class: 'chip-text' }, file.split('/').pop() ?? file),
        !edit ? h(
          'button',
          {
            class: 'chip-remove',
            type: 'button',
            title: t("Remove"),
            'aria-label': t("Remove {0}", file),
            onclick: () => {
              draft.attachments = (draft.attachments ?? []).filter((item) => item !== file);
              this.host.persist();
              this.composerKey = '';
              this.renderComposer();
            },
          },
          '×',
        ) : null,
      ),
    );

    const insertTrigger = (trigger: string) => {
      const start = textarea.selectionStart ?? textarea.value.length;
      const before = textarea.value.slice(0, start);
      const needsSpace = before && !/\s$/.test(before);
      const text = trigger === '/' ? '/' : `${needsSpace ? ' ' : ''}@`;
      if (trigger === '/' && textarea.value.trim()) {
        textarea.value = '/' + textarea.value.replace(/^\//, '');
        textarea.setSelectionRange(1, 1);
      } else {
        textarea.setRangeText(text, start, textarea.selectionEnd ?? start, 'end');
      }
      textarea.dispatchEvent(new Event('input'));
      textarea.focus();
    };

    const toolbar: HTMLElement[] = [
      h('button', { type: 'button', class: 'tool-button', title: edit ? t('Keep attachments while editing') : t("Attach files"), 'aria-label': t("Attach files"), disabled: Boolean(edit), onclick: () => send({ type: 'pickFiles', paneId }) }, icon('attach')),
      h('button', { type: 'button', class: 'tool-button trigger', title: t("Mention a file (@)"), 'aria-label': t("Mention a file"), disabled: Boolean(edit?.saving), onclick: () => insertTrigger('@') }, '@'),
      h('button', { type: 'button', class: 'tool-button trigger', title: t("Commands (/)"), 'aria-label': t("Commands"), disabled: Boolean(edit?.saving), onclick: () => insertTrigger('/') }, '/'),
    ];
    const pill: HTMLElement[] = [];
    if (!edit && preset?.models.length) {
      pill.push(
        this.chipPicker('model', preset.models, draft.model, t("Model"), currentModel, !preset.canSwitchModel, (value) => {
          draft.model = value || undefined;
          draft.modelDirty = Boolean(value) && value !== currentModel;
          this.host.persist();
        }),
      );
    }
    if (!edit && preset?.efforts.length) {
      pill.push(
        this.chipPicker('effort', preset.efforts, draft.effort, t('Effort'), currentEffort, !preset.canSwitchEffort, (value) => {
          draft.effort = value || undefined;
          draft.effortDirty = Boolean(value) && value !== currentEffort;
          this.host.persist();
        }),
      );
    }
    if (pill.length) toolbar.push(h('span', { class: 'model-pill' }, ...pill));
    toolbar.push(h('div', { class: 'spacer' }));
    if (transcript?.usage) toolbar.push(this.renderUsage(transcript));
    if (agent?.status === 'working') {
      toolbar.push(
        h('button', { type: 'button', class: 'tool-button', title: edit ? t('Interrupt agent') : t("Interrupt (Esc)"), 'aria-label': t("Interrupt"), onclick: () => send({ type: 'interrupt', paneId }) }, icon('stop')),
        ...(!edit ? [h('button', { type: 'button', class: 'tool-button', title: t("Send immediately (⌘/Ctrl+Enter)"), 'aria-label': t("Send immediately"), disabled: !agent, onclick: () => submit('now') }, icon('bolt'))] : []),
      );
    }
    toolbar.push(
      h(
        'button',
        { type: 'submit', class: 'send-button', title: edit ? (edit.saving ? t("Saving changes…") : t("Save changes (Enter)")) : working ? t("Queue message (Enter)") : t("Send (Enter)"), 'aria-label': edit ? t("Save changes") : working ? t("Queue message") : t("Send"), disabled: !agent || Boolean(edit && (edit.saving || !available)) },
        icon(edit ? 'edit' : 'send'),
      ),
    );

    if (!this.composerParts) {
      const dialog = h('div', { class: 'dialog-slot' });
      const queue = h('div', { class: 'queue-slot' });
      const mode = h('div', { class: 'composer-mode', hidden: true });
      const chips = h('div', { class: 'chips', hidden: true });
      const toolbar = h('div', { class: 'input-toolbar' });
      const form = h('form', { class: 'chat-input', action: '#', method: 'post', noValidate: true, 'aria-label': t('Message') }, mode, chips, textarea, toolbar);
      this.composerParts = { dialog, queue, mode, chips, toolbar, form };
      this.composer.append(dialog, queue,
        h('div', { class: 'completion', role: 'listbox', hidden: true }),
        form);
    }
    const parts = this.composerParts;
    parts.form.onsubmit = (event) => { event.preventDefault(); submit('queue'); };
    parts.form.setAttribute('aria-busy', String(Boolean(edit?.saving)));
    parts.mode.hidden = !edit;
    parts.mode.replaceChildren(...(edit ? this.renderQueueEditMode(paneId, edit, available, transcript?.queue?.findIndex((item) => item.id === edit.id) ?? -1) : []));
    parts.dialog.replaceChildren(...this.renderDialog(paneId, transcript, agent));
    parts.queue.replaceChildren(...this.renderQueue(paneId, transcript));
    parts.chips.hidden = !chips.length;
    parts.chips.replaceChildren(...chips);
    parts.toolbar.replaceChildren(...toolbar);
    if (readOnly) {
      parts.dialog.replaceChildren(h('div', { class: 'task-readonly-notice', role: 'status' }, readOnly));
      for (const button of this.composer.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
    }
    autosize();
    const restoreFocus = focusedId ? document.getElementById(focusedId) : null;
    if (restoreFocus instanceof HTMLTextAreaElement && restoreFocus !== old) {
      restoreFocus.focus();
      if (selection) restoreFocus.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
    }
    this.renderCompletion();
  }

  private trackComposition(textarea: HTMLTextAreaElement): void {
    textarea.addEventListener('compositionstart', () => {
      this.composingElement = textarea;
      window.clearTimeout(this.completionTimer);
      this.closeCompletion();
    });
    textarea.addEventListener('compositionend', () => {
      if (this.composingElement === textarea) this.composingElement = null;
      const paneId = this.paneId;
      // 等候最後一個 input 事件保存完整文字，再套用背景更新。
      window.setTimeout(() => {
        if (this.paneId !== paneId) return;
        this.composerKey = '';
        this.renderBody();
        if (textarea === this.input) this.updateCompletion(textarea, paneId!);
      }, 0);
    });
  }

  /**
   * Copilot 樣式的標籤選單：顯示目前的值，點選後在上方開啟選項清單。
   * 模型顯示短名稱（claude-opus-5-5 → opus-5.5）；effort 只顯示值。
   */
  private chipPicker(
    id: 'model' | 'effort',
    options: string[],
    value: string | undefined,
    label: string,
    current: string | undefined,
    disabled: boolean,
    onChange: (value: string) => void,
  ): HTMLElement {
    const { h } = this.host;
    const all = current && !options.includes(current) ? [current, ...options] : options;
    const show = (option: string | undefined) => (option ? (id === 'model' ? shortModel(option) : option) : t("Default"));
    const button = h(
      'button',
      {
        type: 'button',
        class: `chip-picker ${this.openPicker === id ? 'open' : ''}`,
        'aria-label': t("{0}: {1}", label, value ?? t("Current setting")),
        'aria-haspopup': 'listbox',
        'aria-expanded': String(this.openPicker === id),
        title: disabled ? t("This agent does not support changing {0} during a conversation", label) : t("{0}: {1} (applies to the next message)", label, value ?? t("Current setting")),
        disabled,
      },
      h('span', { class: 'chip-picker-text' }, show(value)),
      h('span', { class: 'chip-picker-caret', 'aria-hidden': 'true' }, '▾'),
    );
    const wrap = h('span', { class: 'chip-picker-wrap' }, button);
    const close = () => {
      this.openPicker = null;
      wrap.querySelector('.picker-menu')?.remove();
      button.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      this.openPicker = id;
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      const menu = h(
        'div',
        { class: 'picker-menu', role: 'listbox', 'aria-label': label },
        h('div', { class: 'picker-menu-title' }, label),
        ...all.map((option) =>
          h(
            'button',
            {
              type: 'button', class: `picker-option ${option === value ? 'selected' : ''}`,
              role: 'option',
              'aria-selected': String(option === value),
              title: option,
              onclick: (event: MouseEvent) => {
                event.stopPropagation();
                value = option;
                onChange(option);
                (button.querySelector('.chip-picker-text') as HTMLElement).textContent = show(option);
                close();
              },
            },
            h('span', { class: 'picker-check', 'aria-hidden': 'true' }, option === value ? '✓' : ''),
            h('span', { class: 'picker-option-text' }, show(option)),
            option === current ? h('span', { class: 'picker-option-full' }, t("Current")) : null,
          ),
        ),
      );
      wrap.append(menu);
      // 選單超出側邊欄右側時往左移。
      const overflow = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 6);
      if (overflow > 0) menu.style.left = `${-overflow}px`;
      (menu.querySelector('.selected') as HTMLElement | null ?? menu.querySelector('.picker-option') as HTMLElement | null)?.focus();
      menu.addEventListener('keydown', (event) => {
        const items = [...menu.querySelectorAll<HTMLElement>('.picker-option')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close();
          button.focus();
        }
      });
    };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.openPicker === id && wrap.querySelector('.picker-menu')) close();
      else {
        this.composer?.querySelectorAll('.picker-menu').forEach((menu) => menu.remove());
        open();
      }
    });
    wrap.addEventListener('focusout', (event) => {
      if (!wrap.contains(event.relatedTarget as Node | null)) setTimeout(() => {
        if (!wrap.contains(document.activeElement)) close();
      }, 0);
    });
    // 重新繪製輸入區時保持選單開啟。
    if (this.openPicker === id && !disabled) queueMicrotask(open);
    return wrap;
  }

  /**
   * 用量圓圈。三種模式依序：方案額度（Claude 5 小時、Codex 一週）、
   * DeepSeek 餘額、上下文用量。
   */
  private renderUsage(transcript: Transcript): HTMLElement {
    const usage = transcript.usage!;
    const { h } = this.host;
    const context = usage.contextTokens ?? 0;
    const contextPercent = usage.contextWindow ? Math.min(100, (context / usage.contextWindow) * 100) : null;
    const plan = usage.rateLimitPercent !== undefined;
    const credit = plan ? undefined : transcript.deepseek;
    const creditText = credit ? formatMoney('USD', credit.totalUsd) : '';
    const balanceLines = credit
      ? credit.balances.map((item) =>
          item.currency === 'USD'
            ? t("{0} balance: {1}", item.currency, formatMoney('USD', item.total))
            : t("{0} balance: {1} (≈ {2})", item.currency, formatMoney(item.currency, item.total), formatMoney('USD', item.usd)),
        )
      : [];
    const planPercent = plan ? Math.max(0, 100 - usage.rateLimitPercent!) : null;
    const windowLabel = usage.rateLimitWindowMinutes ? formatWindow(usage.rateLimitWindowMinutes) : t("Plan");
    const lines = [
      plan
        ? t("{0} usage: {1}% remaining ({2}% used){3}", windowLabel, formatNumber(planPercent!), formatNumber(usage.rateLimitPercent!), resetText(usage.rateLimitResetsAt))
        : '',
      usage.secondaryPercent !== undefined
        ? t("{0} usage: {1}% remaining{2}", usage.secondaryWindowMinutes ? formatWindow(usage.secondaryWindowMinutes) : t("Other"), formatNumber(Math.max(0, 100 - usage.secondaryPercent)), resetText(usage.secondaryResetsAt))
        : '',
      credit ? t("DeepSeek credit: {0} ({1}% remaining)", creditText, formatNumber(credit.percentLeft)) : '',
      credit ? t("Estimated spend from local logs: {0}", formatMoney('USD', credit.estimatedSpend)) : '',
      ...balanceLines,
      usage.contextWindow ? t("Context: {0} / {1} ({2}%)", formatTokens(context), formatTokens(usage.contextWindow), formatNumber(contextPercent!)) : t("Context: {0}", formatTokens(context)),
      usage.totalTokens !== undefined ? t("Conversation total: {0} (including cached reads)", formatTokens(usage.totalTokens)) : '',
      plan || credit ? '' : t("Plan usage is unavailable. For Claude, run “herdr: Enable Claude usage display”."),
    ].filter(Boolean);
    const shownPercent = plan ? planPercent : credit ? credit.percentLeft : contextPercent;
    const level = plan
      ? planPercent! <= 15 ? 'high' : planPercent! <= 40 ? 'mid' : ''
      : credit
        ? credit.percentLeft <= 15 ? 'high' : credit.percentLeft <= 40 ? 'mid' : ''
        : contextPercent === null ? '' : contextPercent >= 85 ? 'high' : contextPercent >= 60 ? 'mid' : '';
    const text = plan
      ? t("{0} {1}% left", shortWindow(usage.rateLimitWindowMinutes), formatNumber(planPercent!))
      : credit ? creditText : contextPercent !== null ? `${formatNumber(contextPercent)}%` : formatTokens(context);
    return h(
      'span',
      { class: `usage ${level}`, title: lines.join('\n'), 'aria-label': lines.join('; '), tabindex: 0 },
      shownPercent !== null ? ring(h('span', { class: 'usage-ring' }), shownPercent) : null,
      h('span', { class: 'usage-text' }, text),
    );
  }

  private renderQueue(paneId: string, transcript: Transcript | null): HTMLElement[] {
    const queue = transcript?.queue ?? [];
    const edit = this.queueEdits[paneId];
    if (!queue.length) return [];
    const { h, icon, send } = this.host;
    return [
      h(
        'section',
        { class: 'queue', 'aria-label': t("Message queue") },
        h('div', { class: 'queue-title' }, t("Queue ({0}): sent in order when the agent finishes", queue.length)),
        ...queue.map((item, index) =>
          h(
            'div',
            { class: 'queue-item' },
            h('span', { class: 'queue-index' }, String(index + 1)),
            h('span', { class: 'queue-text', title: item.text }, item.text || item.attachments.join(' ')),
            h(
              'button',
              {
                class: 'tool-button', type: 'button', title: t("Edit message"), 'aria-label': t("Edit queued message {0}", index + 1), disabled: Boolean(edit),
                onclick: () => {
                  this.queueEdits[paneId] = { id: item.id, text: item.text, attachments: [...item.attachments], saving: false };
                  this.closeCompletion();
                  this.openPicker = null;
                  this.composerKey = '';
                  this.renderComposer();
                  this.input?.focus();
                  if (!this.composingElement) this.input?.setSelectionRange(item.text.length, item.text.length);
                },
              },
              icon('edit'),
            ),
            h(
              'button',
              { class: 'tool-button', title: t("Send immediately into the current turn"), 'aria-label': t("Send immediately"), disabled: edit?.id === item.id, onclick: () => send({ type: 'insertQueued', paneId, id: item.id }) },
              icon('bolt'),
            ),
            h(
              'button',
              { class: 'tool-button', title: t("Remove"), 'aria-label': t("Remove"), disabled: edit?.id === item.id, onclick: () => send({ type: 'removeQueued', paneId, id: item.id }) },
              icon('close'),
            ),
          ),
        ),
      ),
    ];
  }

  private renderQueueEditMode(paneId: string, edit: QueueEdit, available: boolean | null, index: number): HTMLElement[] {
    const { h } = this.host;
    const id = `queue-edit-${paneId}`;
    return [
      h('div', { class: 'queue-edit-heading' },
        h('label', { id: `${id}-label`, for: `composer-${paneId}` }, available ? t('Edit queued message {0}', index + 1) : t('Edit queued message')),
        h('button', { type: 'button', class: 'tool-button', title: t('Cancel edit (Esc)'), 'aria-label': t('Cancel edit'), disabled: edit.saving, onclick: () => this.cancelQueueEdit(paneId) }, t('Cancel')),
      ),
      h('div', { id: `${id}-help`, class: 'queue-edit-help' }, available === null ? t('Loading queue…') : available
        ? t('Enter to save, Shift+Enter for a new line, Esc to cancel.')
        : t('This message has been sent or removed. Your edits are still in the composer.')),
      h('div', { id: `${id}-error`, class: 'queue-edit-error', role: 'alert', hidden: !edit.error }, edit.error),
      ...(available === false ? [h('button', {
        type: 'button', class: 'secondary', 'aria-label': t('Keep as new message'), disabled: edit.saving,
        onclick: () => {
          const draft = this.draft(paneId);
          draft.text = [draft.text, edit.text].filter(Boolean).join('\n\n');
          draft.attachments = [...new Set([...(draft.attachments ?? []), ...edit.attachments])];
          this.host.persist();
          this.cancelQueueEdit(paneId);
        },
      }, t('Keep as new message'))] : []),
    ];
  }

  /** 確認畫面：把選項顯示成按鈕。沒有偵測到選項時顯示終端機畫面與按鍵。 */
  private renderDialog(paneId: string, transcript: Transcript | null, agent: AgentView | undefined): HTMLElement[] {
    const { h, send } = this.host;
    const options = transcript?.dialog ?? [];
    const blocked = agent?.status === 'blocked' || options.length > 0;
    const screen = transcript?.screen;
    if (!blocked && !this.screenOpen.has(paneId)) return [];
    if (screen === undefined && !options.length) return [];
    const lines = (screen ?? '').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const preview = h('pre', { class: 'terminal' }, lines.slice(-18).join('\n'));
    return [
      h(
        'section',
        { class: `dialog-card ${blocked ? 'blocked' : ''}`, 'aria-label': blocked ? t("Agent awaiting a response") : t("Terminal output") },
        h(
          'div',
          { class: 'dialog-title' },
          blocked ? t("Agent is waiting for your response") : t("Terminal output"),
          transcript?.dialogTitle ? h('span', { class: 'dialog-tag' }, transcript.dialogTitle.replace(/^[☐☒✔✓□■]\s*/, '')) : null,
        ),
        options.length && transcript?.dialogQuestion ? h('div', { class: 'dialog-question' }, transcript.dialogQuestion) : null,
        options.length ? h('details', {}, h('summary', {}, t("Show terminal output")), preview) : preview,
        options.length
          ? h(
              'div',
              { class: 'dialog-options' },
              ...options.map((option) =>
                h(
                  'button',
                  {
                    class: `option ${option.highlighted ? 'highlighted' : ''}`,
                    onclick: () => send({ type: 'chooseOption', paneId, number: option.number }),
                  },
                  h('span', { class: 'option-number' }, String(option.number)),
                  h(
                    'span',
                    { class: 'option-body' },
                    h('span', { class: 'option-text' }, option.text),
                    option.description ? h('span', { class: 'option-desc' }, option.description) : null,
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { class: 'screen-keys' },
          ...SCREEN_KEYS.map((item) =>
            h('button', { class: 'secondary small', title: t(item.title), onclick: () => send({ type: 'keys', paneId, keys: item.keys }) }, item.label),
          ),
        ),
      ),
    ];
  }

  // ---------- 拖曳檔案 ----------

  /**
   * 整個側邊欄都可以拖放檔案。拖曳時顯示覆蓋畫面，並把游標設成「複製」（+）。
   * 從 VS Code 檔案總管拖曳時，VS Code 要求按住 Shift 才會把檔案交給 webview。
   */
  private installDrop(): void {
    const { h } = this.host;
    const overlay = h(
      'div',
      { class: 'drop-overlay', 'aria-hidden': 'true' },
      h('div', { class: 'drop-plus' }, '+'),
      h('div', {}, t("Drop to attach files")),
      h('div', { class: 'drop-sub' }, t("Hold Shift when dragging from the VS Code Explorer")),
    );
    document.body.append(overlay);
    let depth = 0;
    const active = () => this.paneId !== null && document.querySelector('main.pane') !== null;
    const hasFiles = (event: DragEvent) => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      return types.some((type) => type === 'Files' || type.includes('uri-list') || type === 'resourceurls' || type === 'codefiles');
    };
    window.addEventListener('dragenter', (event) => {
      if (!active() || !hasFiles(event)) return;
      event.preventDefault();
      depth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (event) => {
      if (!active() || !hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', (event) => {
      depth = 0;
      document.body.classList.remove('dragging');
      if (!active()) return;
      event.preventDefault();
      const paneId = this.paneId!;
      if (this.queueEdits[paneId]) {
        this.flash(t('Attachments are preserved while editing queued messages.'));
        return;
      }
      const data = event.dataTransfer;
      if (!data) return;
      const uriList = data.getData('application/vnd.code.uri-list') || data.getData('text/uri-list');
      const resources = data.getData('resourceurls');
      let uris: string[] = [];
      if (uriList) uris = uriList.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
      else if (resources) {
        try {
          uris = JSON.parse(resources);
        } catch {
          uris = [];
        }
      }
      if (uris.length) {
        this.host.send({ type: 'dropUris', paneId, uris });
        return;
      }
      const files = Array.from(data.files);
      if (files.length) void this.uploadFiles(paneId, files);
    });
  }

  /** 附加成功後短暫顯示提示。 */
  private flash(text: string): void {
    const { h } = this.host;
    const toast = h('div', { class: 'toast', role: 'status' }, text);
    document.body.append(toast);
    setTimeout(() => toast.classList.add('hide'), 1600);
    setTimeout(() => toast.remove(), 2000);
  }

  private async uploadFiles(paneId: string, files: File[]): Promise<void> {
    const payload: { name: string; base64: string }[] = [];
    for (const file of files) {
      if (file.size > MAX_DROP_BYTES) continue;
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      payload.push({ name: file.name || `pasted-${Date.now()}.png`, base64: btoa(binary) });
    }
    if (payload.length) this.host.send({ type: 'dropFiles', paneId, files: payload });
  }

  // ---------- @ 與 / 補全 ----------

  private updateCompletion(textarea: HTMLTextAreaElement, paneId: string): void {
    if (this.composingElement === textarea) return;
    const caret = textarea.selectionStart ?? 0;
    const before = textarea.value.slice(0, caret);
    const slash = /^\/([^\s]*)$/.exec(before);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    let next: { trigger: '/' | '@'; start: number; query: string } | null = null;
    if (slash) next = { trigger: '/', start: 0, query: slash[1] };
    else if (at) next = { trigger: '@', start: caret - at[2].length - 1, query: at[2] };
    if (!next) {
      this.closeCompletion();
      return;
    }
    const requestId = this.nextRequestId++;
    this.completion = { ...next, items: this.completion?.trigger === next.trigger ? this.completion.items : [], index: 0, requestId };
    window.clearTimeout(this.completionTimer);
    this.completionTimer = window.setTimeout(
      () => this.host.send({ type: 'complete', requestId, paneId, trigger: next!.trigger, query: next!.query }),
      next.trigger === '@' ? 120 : 30,
    );
    this.renderCompletion();
  }

  private closeCompletion(): void {
    if (!this.completion) return;
    this.completion = null;
    this.renderCompletion();
  }

  private renderCompletion(): void {
    const popup = this.composer?.querySelector<HTMLElement>('.completion');
    if (!popup) return;
    const state = this.completion;
    if (!state || !state.items.length) {
      popup.hidden = true;
      popup.replaceChildren();
      return;
    }
    const { h } = this.host;
    popup.hidden = false;
    const paneId = this.paneId!;
    const rows = state.items.map((item, index) =>
      h(
        'div',
        {
          class: `completion-item ${index === state.index ? 'selected' : ''}`,
          role: 'option',
          'aria-selected': String(index === state.index),
          onmousedown: (event: MouseEvent) => {
            event.preventDefault();
            this.accept(item);
          },
        },
        item.kind === 'file' ? this.host.icon('file') : null,
        h('span', { class: 'completion-label' }, item.label),
        item.description ? h('span', { class: 'completion-desc' }, item.description) : null,
      ),
    );
    const footer =
      state.trigger === '/'
        ? h(
            'div',
            { class: 'completion-footer' },
            t("↑↓ to select · Enter to insert"),
            h(
              'button',
              {
                class: 'link',
                title: t("Open the agent’s / menu and read the complete list"),
                onmousedown: (event: MouseEvent) => {
                  event.preventDefault();
                  this.host.send({ type: 'refreshCommands', paneId });
                },
              },
              t("Refresh list"),
            ),
          )
        : h('div', { class: 'completion-footer' }, t("↑↓ to select · Enter to insert"));
    popup.replaceChildren(...rows, footer);
    popup.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private accept(item: CompletionItem): void {
    const state = this.completion;
    const textarea = this.composer?.querySelector<HTMLTextAreaElement>('.chat-input > textarea');
    if (!state || !textarea) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    textarea.setRangeText(item.insert, state.start, caret, 'end');
    this.completion = null;
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
    this.renderCompletion();
  }

  private onKeyDown(event: KeyboardEvent, textarea: HTMLTextAreaElement, paneId: string, submit: (mode: 'queue' | 'now') => void): void {
    if (event.isComposing || event.keyCode === 229 || this.composingElement === textarea || this.host.readOnly?.(paneId)) return;
    const state = this.completion;
    if (state && state.items.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.index = (state.index + delta + state.items.length) % state.items.length;
        this.renderCompletion();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
        event.preventDefault();
        this.accept(state.items[state.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeCompletion();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const waiting = Boolean(this.transcript?.paneId === paneId && this.transcript.dialog?.length);
      submit(event.metaKey || event.ctrlKey || waiting ? 'now' : 'queue');
      return;
    }
    if (event.key === 'Escape' && this.queueEdits[paneId]) {
      event.preventDefault();
      this.cancelQueueEdit(paneId);
      return;
    }
    if (event.key === 'Escape' && this.host.agent(paneId)?.status === 'working') {
      event.preventDefault();
      this.host.send({ type: 'interrupt', paneId });
    }
    void textarea;
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${formatNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${formatNumber(value / 1000, value >= 100_000 ? 0 : 1)}k`;
  return formatNumber(value);
}

function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: fractionDigits }).format(value);
}

function formatWindow(minutes: number): string {
  const [value, unit] = minutes % 10080 === 0 ? [minutes / 10080, 'week']
    : minutes % 1440 === 0 ? [minutes / 1440, 'day']
      : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return new Intl.NumberFormat(getIntlLocale(), { style: 'unit', unit: String(unit), unitDisplay: 'long' }).format(Number(value));
}

/** 金額顯示：USD 用 US$、CNY 用 ¥，其他幣別保留代號。 */
function formatMoney(currency: string, value: number): string {
  const symbol = currency === 'USD' ? 'US$' : currency === 'CNY' ? '¥' : `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

function ring(element: HTMLElement, percent: number): HTMLElement {
  // CSP 不允許 style 屬性，所以用 CSSOM 設定變數。
  element.style.setProperty('--p', percent.toFixed(1));
  return element;
}


function shortWindow(minutes: number | undefined): string {
  if (!minutes) return '';
  if (minutes === 10080) return t("week");
  if (minutes % 60 === 0 && minutes < 1440) return `${minutes / 60}h`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${minutes}m`;
}

function resetText(resetsAt: number | undefined): string {
  if (!resetsAt) return '';
  const date = new Date(resetsAt * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(getIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  const day = sameDay ? '' : `${date.toLocaleDateString(getIntlLocale(), { month: 'numeric', day: 'numeric' })} `;
  return t(', resets {0}', `${day}${time}`);
}

/**
 * 將使用者訊息尾端或行內的 `@"path/to/file"` 與 `@path/to/file` 附加檔案拆成附件清單與純文字，
 * 讓對話泡泡顯示與輸入框相同的檔案標籤（chip）。
 */
export function splitUserAttachments(text: string): { body: string; attachments: string[] } {
  const attachments: string[] = [];
  const tokenPattern = /@"([^"\n]+)"|@((?:\/|\.\.?\/|~\/)[^\s]+|[^\s@]+\.[A-Za-z0-9]{1,10})(?=\s|$)/g;
  const body = text
    .replace(tokenPattern, (_full, quoted: string | undefined, unquoted: string | undefined) => {
      const file = (quoted ?? unquoted ?? '').trim();
      if (file && !attachments.includes(file)) attachments.push(file);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, attachments };
}

/** 工具呼叫的一行摘要。提問工具只顯示問題文字，不顯示 JSON。 */
function toolSummary(tool: string | undefined, text: string): string {
  if (tool === 'AskUserQuestion' || /^\{"questions"/.test(text)) {
    const questions = [...text.matchAll(/"question":"((?:[^"\\]|\\.)*)"/g)].map((match) => {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1];
      }
    });
    if (questions.length) return questions.join(getIntlLocale() === 'zh-TW' ? '；' : '; ');
  }
  return text;
}

type ToolCategory = 'command' | 'search' | 'read' | 'edit' | 'other';

function classifyTool(tool: string | undefined): ToolCategory {
  const name = (tool ?? '').toLowerCase();
  if (!name) return 'other';
  if (
    name === 'bash' ||
    name === 'shell' ||
    name === 'exec_command' ||
    name === 'run_command' ||
    name === 'local_shell_call' ||
    name === 'write_stdin'
  ) {
    return 'command';
  }
  if (
    name.includes('search') ||
    name.includes('grep') ||
    name.includes('glob') ||
    name.includes('find') ||
    name.includes('web') ||
    name.includes('fetch')
  ) {
    return 'search';
  }
  if (name.includes('read') || name.includes('view') || name.includes('cat') || name.includes('list')) {
    return 'read';
  }
  if (
    name.includes('edit') ||
    name.includes('write') ||
    name.includes('patch') ||
    name.includes('replace') ||
    name.includes('create')
  ) {
    return 'edit';
  }
  return 'other';
}

function toolIconName(tool: string | undefined): string {
  switch (classifyTool(tool)) {
    case 'command':
      return 'terminal';
    case 'search':
      return 'search';
    case 'read':
      return 'file';
    case 'edit':
      return 'edit';
    default:
      return 'tool';
  }
}

function groupIconName(tools: (string | undefined)[]): string {
  const cats = new Set(tools.map(classifyTool));
  if (cats.has('command')) return 'terminal';
  if (cats.has('search')) return 'search';
  if (cats.has('edit')) return 'edit';
  if (cats.has('read')) return 'file';
  return 'terminal';
}

function categoryActionLabel(cat: ToolCategory): string {
  switch (cat) {
    case 'command':
      return t('Ran commands');
    case 'search':
      return t('Searched');
    case 'read':
      return t('Read files');
    case 'edit':
      return t('Edited files');
    default:
      return t('Used tools');
  }
}

function commandGroupLabel(messages: ChatMessage[]): string {
  const labels: string[] = [];
  for (const msg of messages) {
    const label = categoryActionLabel(classifyTool(msg.tool));
    if (!labels.includes(label)) labels.push(label);
  }
  const summary = labels.join(' ') || t('Ran commands');
  if (messages.length === 1) {
    const detail = toolSummary(messages[0].tool, messages[0].text);
    return detail ? t('{0} “{1}”', summary, detail) : t('{0} · {1} step', summary, 1);
  }
  return t('{0} · {1} steps', summary, messages.length);
}

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function turnStartTime(userTimestamp: number | undefined, items: { message: ChatMessage }[]): number | undefined {
  let start = userTimestamp;
  for (const { message } of items) {
    const t0 = message.timestamp;
    if (t0 !== undefined && (start === undefined || t0 < start)) start = t0;
  }
  return start;
}

function turnDurationMs(userTimestamp: number | undefined, items: { message: ChatMessage }[]): number | undefined {
  const start = turnStartTime(userTimestamp, items);
  let end: number | undefined;
  for (const { message } of items) {
    const t1 = message.endTimestamp ?? message.timestamp;
    if (t1 !== undefined && (end === undefined || t1 > end)) end = t1;
  }
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}
