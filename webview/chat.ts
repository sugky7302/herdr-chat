// 對話頁：Copilot 樣式的訊息列表與輸入框。

import type { AgentView, ChatMessage, CompletionItem, FromWebview, PresetView, Transcript, Usage } from '../src/shared';
import { renderMarkdown } from './markdown';
import { shortModel } from '../src/modelName';

type Child = Node | string | null | undefined | false;

export interface ChatHost {
  send(message: FromWebview): void;
  persist(): void;
  h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any>, ...children: Child[]): HTMLElementTagNameMap[K];
  icon(name: string): HTMLElement;
  agent(paneId: string): AgentView | undefined;
  preset(agent: AgentView | undefined): PresetView | undefined;
  drafts: Record<string, Draft>;
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
  { label: '↑', keys: ['up'], title: '上' },
  { label: '↓', keys: ['down'], title: '下' },
  { label: 'Enter', keys: ['enter'], title: '確認' },
  { label: 'Esc', keys: ['esc'], title: '取消' },
  { label: 'Tab', keys: ['tab'], title: 'Tab' },
  { label: 'Ctrl+C', keys: ['ctrl+c'], title: '中斷' },
];

const MAX_DROP_BYTES = 25 * 1024 * 1024;
/** 「傳送中」訊息最多顯示的時間。 */
const PENDING_MS = 15000;

export class ChatView {
  transcript: Transcript | null = null;
  readonly screenOpen = new Set<string>();
  /** 已送出、還沒出現在紀錄中的訊息。 */
  private pending: Record<string, { text: string; at: number }[]> = {};
  private queueEdits: Record<string, QueueEdit> = {};
  private paneId: string | null = null;
  private messages: HTMLElement | null = null;
  private composer: HTMLElement | null = null;
  private scrollButton: HTMLElement | null = null;
  private composerKey = '';
  private bodyKey = '';
  private input: HTMLTextAreaElement | null = null;
  private composingElement: HTMLTextAreaElement | null = null;
  private composerParts: { dialog: HTMLElement; queue: HTMLElement; chips: HTMLElement; toolbar: HTMLElement } | null = null;
  private completion: CompletionState | null = null;
  private completionTimer: number | undefined;
  private nextRequestId = 1;
  private stickToBottom = true;
  /** 目前開啟的標籤選單。 */
  private openPicker: 'model' | 'effort' | null = null;

  constructor(private readonly host: ChatHost) {
    this.installDrop();
  }

  /** 建立對話頁的主體。工具列由呼叫端負責。 */
  mount(paneId: string): HTMLElement[] {
    const { h } = this.host;
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
        title: '捲到最新訊息',
        'aria-label': '捲到最新訊息',
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
      const seen = next.messages.filter((m) => m.role === 'user' || m.role === 'terminal').map((m) => m.text);
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
    document.getElementById(error ? `queue-edit-${paneId}` : `composer-${paneId}`)?.focus();
  }

  onCompletions(requestId: number, items: CompletionItem[]): void {
    if (!this.completion || this.completion.requestId !== requestId) return;
    this.completion.items = items;
    this.completion.index = 0;
    this.renderCompletion();
  }

  addAttachments(paneId: string, paths: string[]): void {
    if (paths.length) this.flash(`已附加 ${paths.length} 個檔案`);
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

  private renderBody(): void {
    if (!this.paneId || !this.messages) return;
    const paneId = this.paneId;
    const { h } = this.host;
    const stick = this.stickToBottom;
    const scrollTop = this.messages.scrollTop;
    const items: HTMLElement[] = [];
    const transcript = this.transcript?.paneId === paneId ? this.transcript : null;
    const agent = this.host.agent(paneId);
    const key = JSON.stringify([transcript?.source, transcript?.messages, this.pending[paneId], agent?.status === 'working', agent?.label, agent?.name, agent?.kind]);
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      if (!transcript) {
        items.push(h('div', { class: 'muted pad' }, h('span', { class: 'spinner' }), '讀取對話…'));
      } else {
        if (transcript.source === 'terminal' && transcript.messages[0]?.role === 'terminal') {
          items.push(h('div', { class: 'notice' }, '這個 agent 沒有可讀的對話紀錄，以下是終端機畫面。'));
        }
        items.push(...this.renderTurns(transcript.messages, agent));
        for (const item of this.pending[paneId] ?? []) items.push(this.renderUser(item.text, true));
        if (agent?.status === 'working') {
          items.push(h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), '工作中…'));
        }
      }
      this.messages.replaceChildren(...items);
    }
    this.renderComposer();
    if (this.messages.isConnected) {
      if (stick) this.scrollToBottom();
      else this.messages.scrollTop = scrollTop;
    }
    this.scrollButton?.classList.toggle('visible', !stick);
  }

  /** 把連續的助理文字與工具呼叫合併成一個回覆區塊。 */
  private renderTurns(messages: ChatMessage[], agent: AgentView | undefined): HTMLElement[] {
    const { h } = this.host;
    const out: HTMLElement[] = [];
    let reply: HTMLElement | null = null;
    const agentName = agent?.label || agent?.name || agent?.kind || 'agent';
    for (const message of messages) {
      if (message.role === 'user') {
        reply = null;
        out.push(this.renderUser(message.text));
        continue;
      }
      if (message.role === 'notice') {
        reply = null;
        out.push(h('div', { class: 'notice' }, message.text));
        continue;
      }
      if (!reply) {
        reply = h('div', { class: 'content' });
        out.push(h('div', { class: 'turn assistant', 'aria-label': `${agentName} 的回覆` }, reply));
      }
      if (message.role === 'assistant') {
        const body = h('div', { class: 'markdown' });
        body.innerHTML = renderMarkdown(message.text);
        reply.append(body);
      } else if (message.role === 'tool') {
        reply.append(
          h(
            'div',
            { class: 'tool', title: message.text },
            this.host.icon('check'),
            h('span', { class: 'tool-name' }, message.tool ?? 'tool'),
            h('span', { class: 'tool-text' }, message.text),
          ),
        );
      } else if (message.role === 'terminal') {
        reply.append(h('pre', { class: 'terminal' }, message.text));
      }
    }
    return out;
  }

  private renderUser(text: string, pending = false): HTMLElement {
    const { h } = this.host;
    return h(
      'div',
      { class: `turn user ${pending ? 'pending' : ''}`, 'aria-label': pending ? '你的訊息（傳送中）' : '你的訊息' },
      h('div', { class: 'bubble', title: pending ? '傳送中' : undefined }, text),
    );
  }

  // ---------- 輸入區 ----------

  private renderComposer(): void {
    if (!this.paneId || !this.composer) return;
    // 組字完成前，延後會更換佇列編輯框與工具列的更新。
    if (this.composingElement?.isConnected) return;
    const paneId = this.paneId;
    const { h, icon, send } = this.host;
    const agent = this.host.agent(paneId);
    const preset = this.host.preset(agent);
    const transcript = this.transcript?.paneId === paneId ? this.transcript : null;
    const key = JSON.stringify([
      paneId,
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
      this.input = h('textarea', { id: `composer-${paneId}`, rows: 1, 'aria-label': '訊息' });
      this.trackComposition(this.input);
    }
    const textarea = this.input;
    if (textarea.value !== draft.text) textarea.value = draft.text;
    textarea.placeholder = waiting
        ? '請點選上方選項；選「Type something」後可在這裡輸入回答'
        : working
          ? '工作中：Enter 加入佇列，⌘/Ctrl+Enter 立即插入'
          : '輸入訊息，/ 指令，@ 檔案（Enter 送出）';
    const autosize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
    };
    textarea.oninput = () => {
      draft.text = textarea.value;
      this.host.persist();
      autosize();
      this.updateCompletion(textarea, paneId);
    };
    textarea.onkeydown = (event) => this.onKeyDown(event, textarea, paneId, submit);
    textarea.onblur = () => setTimeout(() => this.closeCompletion(), 150);
    textarea.onpaste = (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void this.uploadFiles(paneId, files);
      }
    };

    const submit = (mode: 'queue' | 'now') => {
      if (this.composingElement === textarea) return;
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
      if (!working || mode === 'now') (this.pending[paneId] ??= []).push({ text, at: Date.now() });
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
    const chips = (draft.attachments ?? []).map((file) =>
      h(
        'span',
        { class: 'chip', title: file },
        icon('file'),
        h('span', { class: 'chip-text' }, file.split('/').pop() ?? file),
        h(
          'button',
          {
            class: 'chip-remove',
            title: '移除',
            'aria-label': `移除 ${file}`,
            onclick: () => {
              draft.attachments = (draft.attachments ?? []).filter((item) => item !== file);
              this.host.persist();
              this.composerKey = '';
              this.renderComposer();
            },
          },
          '×',
        ),
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
      h('button', { class: 'tool-button', title: '附加檔案', 'aria-label': '附加檔案', onclick: () => send({ type: 'pickFiles', paneId }) }, icon('attach')),
      h('button', { class: 'tool-button trigger', title: '提及檔案（@）', 'aria-label': '提及檔案', onclick: () => insertTrigger('@') }, '@'),
      h('button', { class: 'tool-button trigger', title: '指令（/）', 'aria-label': '指令', onclick: () => insertTrigger('/') }, '/'),
    ];
    if (preset?.models.length) {
      toolbar.push(
        this.chipPicker('model', preset.models, draft.model, '模型', currentModel, !preset.canSwitchModel, (value) => {
          draft.model = value || undefined;
          draft.modelDirty = Boolean(value) && value !== currentModel;
          this.host.persist();
        }),
      );
    }
    if (preset?.efforts.length) {
      toolbar.push(
        this.chipPicker('effort', preset.efforts, draft.effort, 'Effort', currentEffort, !preset.canSwitchEffort, (value) => {
          draft.effort = value || undefined;
          draft.effortDirty = Boolean(value) && value !== currentEffort;
          this.host.persist();
        }),
      );
    }
    toolbar.push(h('div', { class: 'spacer' }));
    if (transcript?.usage) toolbar.push(this.renderUsage(transcript.usage));
    if (agent?.status === 'working') {
      toolbar.push(
        h('button', { class: 'tool-button', title: '中斷（Esc）', 'aria-label': '中斷', onclick: () => send({ type: 'interrupt', paneId }) }, icon('stop')),
        h('button', { class: 'tool-button', title: '立即插入（⌘/Ctrl+Enter）', 'aria-label': '立即插入', disabled: !agent, onclick: () => submit('now') }, icon('bolt')),
      );
    }
    toolbar.push(
      h(
        'button',
        { class: 'send-button', title: working ? '加入佇列（Enter）' : '送出（Enter）', 'aria-label': working ? '加入佇列' : '送出', disabled: !agent, onclick: () => submit('queue') },
        icon('send'),
      ),
    );

    if (!this.composerParts) {
      const dialog = h('div', { class: 'dialog-slot' });
      const queue = h('div', { class: 'queue-slot' });
      const chips = h('div', { class: 'chips', hidden: true });
      const toolbar = h('div', { class: 'input-toolbar' });
      this.composerParts = { dialog, queue, chips, toolbar };
      this.composer.append(dialog, queue,
        h('div', { class: 'completion', role: 'listbox', hidden: true }),
        h('div', { class: 'chat-input' }, chips, textarea, toolbar));
    }
    const parts = this.composerParts;
    parts.dialog.replaceChildren(...this.renderDialog(paneId, transcript, agent));
    parts.queue.replaceChildren(...this.renderQueue(paneId, transcript));
    parts.chips.hidden = !chips.length;
    parts.chips.replaceChildren(...chips);
    parts.toolbar.replaceChildren(...toolbar);
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
    const show = (option: string | undefined) => (option ? (id === 'model' ? shortModel(option) : option) : '預設');
    const button = h(
      'button',
      {
        class: `chip-picker ${this.openPicker === id ? 'open' : ''}`,
        'aria-label': `${label}：${value ?? '目前設定'}`,
        'aria-haspopup': 'listbox',
        'aria-expanded': String(this.openPicker === id),
        title: disabled ? `這個 agent 不支援在對話中切換${label}` : `${label}：${value ?? '目前設定'}（下一則訊息生效）`,
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
              class: `picker-option ${option === value ? 'selected' : ''}`,
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
            option === current ? h('span', { class: 'picker-option-full' }, '目前') : null,
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
   * 用量圓圈。有方案額度時顯示額度剩餘（Claude：5 小時；Codex：一週），否則顯示上下文用量。
   */
  private renderUsage(usage: Usage): HTMLElement {
    const { h } = this.host;
    const context = usage.contextTokens ?? 0;
    const contextPercent = usage.contextWindow ? Math.min(100, (context / usage.contextWindow) * 100) : null;
    const plan = usage.rateLimitPercent !== undefined;
    const remaining = plan ? Math.max(0, 100 - usage.rateLimitPercent!) : null;
    const windowLabel = usage.rateLimitWindowMinutes ? formatWindow(usage.rateLimitWindowMinutes) : '方案';
    const lines = [
      plan
        ? `${windowLabel}用量：剩 ${remaining!.toFixed(0)}%（已用 ${usage.rateLimitPercent!.toFixed(0)}%）${resetText(usage.rateLimitResetsAt)}`
        : '',
      usage.secondaryPercent !== undefined
        ? `${usage.secondaryWindowMinutes ? formatWindow(usage.secondaryWindowMinutes) : '其他'}用量：剩 ${Math.max(0, 100 - usage.secondaryPercent).toFixed(0)}%${resetText(usage.secondaryResetsAt)}`
        : '',
      `上下文：${formatTokens(context)}${usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}（${contextPercent!.toFixed(0)}%）` : ''}`,
      usage.totalTokens !== undefined ? `本對話累計：${formatTokens(usage.totalTokens)}（含快取讀取）` : '',
      plan ? '' : '沒有方案用量資料。Claude 需要執行「herdr: 啟用 Claude 用量顯示」。',
    ].filter(Boolean);
    const shownPercent = plan ? remaining! : contextPercent;
    const level = plan
      ? remaining! <= 15 ? 'high' : remaining! <= 40 ? 'mid' : ''
      : contextPercent === null ? '' : contextPercent >= 85 ? 'high' : contextPercent >= 60 ? 'mid' : '';
    const text = plan ? `${shortWindow(usage.rateLimitWindowMinutes)} 剩 ${remaining!.toFixed(0)}%` : contextPercent !== null ? `${contextPercent.toFixed(0)}%` : formatTokens(context);
    return h(
      'span',
      { class: `usage ${level}`, title: lines.join('\n'), 'aria-label': lines.join('，'), tabindex: 0 },
      shownPercent !== null ? ring(h('span', { class: 'usage-ring' }), shownPercent) : null,
      h('span', { class: 'usage-text' }, text),
    );
  }

  private renderQueue(paneId: string, transcript: Transcript | null): HTMLElement[] {
    const queue = transcript?.queue ?? [];
    const edit = this.queueEdits[paneId];
    if (!queue.length && !edit) return [];
    const { h, icon, send } = this.host;
    return [
      h(
        'section',
        { class: 'queue', 'aria-label': '訊息佇列' },
        h('div', { class: 'queue-title' }, `佇列（${queue.length}）：agent 完成後依序送出`),
        ...queue.map((item, index) =>
          h(
            'div',
            { class: 'queue-item' },
            h('span', { class: 'queue-index' }, String(index + 1)),
            h('span', { class: 'queue-text', title: item.text }, item.text || item.attachments.join(' ')),
            h(
              'button',
              {
                class: 'tool-button', type: 'button', title: '修改訊息', 'aria-label': `修改第 ${index + 1} 則佇列訊息`, disabled: Boolean(edit),
                onclick: () => {
                  this.queueEdits[paneId] = { id: item.id, text: item.text, attachments: [...item.attachments], saving: false };
                  this.composerKey = '';
                  this.renderComposer();
                  document.getElementById(`queue-edit-${paneId}`)?.focus();
                },
              },
              icon('edit'),
            ),
            h(
              'button',
              { class: 'tool-button', title: '立即插入到目前的回合', 'aria-label': '立即插入', disabled: edit?.id === item.id, onclick: () => send({ type: 'insertQueued', paneId, id: item.id }) },
              icon('bolt'),
            ),
            h(
              'button',
              { class: 'tool-button', title: '移除', 'aria-label': '移除', disabled: edit?.id === item.id, onclick: () => send({ type: 'removeQueued', paneId, id: item.id }) },
              icon('close'),
            ),
          ),
        ),
        edit ? this.renderQueueEditor(paneId, edit, queue.some((item) => item.id === edit.id)) : null,
      ),
    ];
  }

  private renderQueueEditor(paneId: string, edit: QueueEdit, available: boolean): HTMLElement {
    const { h, send } = this.host;
    const id = `queue-edit-${paneId}`;
    const finish = () => {
      delete this.queueEdits[paneId];
      this.composerKey = '';
      this.renderComposer();
      document.getElementById(`composer-${paneId}`)?.focus();
    };
    const error = h('div', { id: `${id}-error`, class: 'queue-edit-error', role: 'alert', hidden: !edit.error }, edit.error);
    const textarea = h('textarea', {
      id, name: 'queued-message', rows: 3, value: edit.text, disabled: edit.saving,
      required: !edit.attachments.length, 'aria-describedby': `${id}-help ${id}-error`,
    });
    this.trackComposition(textarea);
    textarea.addEventListener('input', () => {
      edit.text = textarea.value;
      edit.error = undefined;
      error.hidden = true;
      textarea.setCustomValidity('');
    });
    const form = h(
      'form',
      {
        class: 'queue-editor', action: '#', method: 'post', 'aria-labelledby': `${id}-label`,
        onsubmit: (event: SubmitEvent) => {
          event.preventDefault();
          if (edit.saving || !available) return;
          textarea.setCustomValidity(!edit.text.trim() && !edit.attachments.length ? '請輸入訊息。' : '');
          if (!textarea.reportValidity()) return;
          edit.saving = true;
          edit.error = undefined;
          this.composerKey = '';
          this.renderComposer();
          send({ type: 'updateQueued', paneId, id: edit.id, text: edit.text });
        },
      },
      h('label', { id: `${id}-label`, for: id }, '修改佇列訊息'),
      textarea,
      h('div', { id: `${id}-help`, class: 'queue-edit-help' }, available
        ? 'Enter 換行，⌘/Ctrl+Enter 儲存，Esc 取消。附件與排隊順序會保留。'
        : '這則訊息已送出或移除。修改內容仍保留在這裡。'),
      error,
      h('div', { class: 'queue-edit-actions' },
        h('button', { type: 'submit', disabled: edit.saving || !available }, edit.saving ? '儲存中…' : '儲存修改'),
        h('button', { type: 'button', class: 'secondary', disabled: edit.saving, onclick: finish }, '取消'),
        !available ? h('button', {
          type: 'button', class: 'secondary', disabled: edit.saving,
          onclick: () => {
            const draft = this.draft(paneId);
            draft.text = [draft.text, edit.text].filter(Boolean).join('\n\n');
            draft.attachments = [...new Set([...(draft.attachments ?? []), ...edit.attachments])];
            this.host.persist();
            finish();
          },
        }, '移到輸入框') : null,
      ),
    );
    textarea.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229 || this.composingElement === textarea) return;
      if (event.key === 'Escape' && !edit.saving) {
        event.preventDefault();
        finish();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    return form;
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
        { class: `dialog-card ${blocked ? 'blocked' : ''}`, 'aria-label': blocked ? 'agent 等待回應' : '終端機畫面' },
        h(
          'div',
          { class: 'dialog-title' },
          blocked ? 'agent 正在等你回應' : '終端機畫面',
          transcript?.dialogTitle ? h('span', { class: 'dialog-tag' }, transcript.dialogTitle.replace(/^[☐☒✔✓□■]\s*/, '')) : null,
        ),
        options.length && transcript?.dialogQuestion ? h('div', { class: 'dialog-question' }, transcript.dialogQuestion) : null,
        options.length ? h('details', {}, h('summary', {}, '顯示終端機畫面'), preview) : preview,
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
            h('button', { class: 'secondary small', title: item.title, onclick: () => send({ type: 'keys', paneId, keys: item.keys }) }, item.label),
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
      h('div', {}, '放開以附加檔案'),
      h('div', { class: 'drop-sub' }, '從 VS Code 檔案總管拖曳時請按住 Shift'),
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
            '↑↓ 選擇 · Enter 插入',
            h(
              'button',
              {
                class: 'link',
                title: '在 agent 中打開 / 選單並讀取完整清單',
                onmousedown: (event: MouseEvent) => {
                  event.preventDefault();
                  this.host.send({ type: 'refreshCommands', paneId });
                },
              },
              '更新清單',
            ),
          )
        : h('div', { class: 'completion-footer' }, '↑↓ 選擇 · Enter 插入');
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
    if (event.isComposing || event.keyCode === 229 || this.composingElement === textarea) return;
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
    if (event.key === 'Escape' && this.host.agent(paneId)?.status === 'working') {
      event.preventDefault();
      this.host.send({ type: 'interrupt', paneId });
    }
    void textarea;
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatWindow(minutes: number): string {
  if (minutes % 10080 === 0) return `${minutes / 10080} 週`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分鐘`;
}

function ring(element: HTMLElement, percent: number): HTMLElement {
  // CSP 不允許 style 屬性，所以用 CSSOM 設定變數。
  element.style.setProperty('--p', percent.toFixed(1));
  return element;
}


function shortWindow(minutes: number | undefined): string {
  if (!minutes) return '';
  if (minutes === 10080) return '週';
  if (minutes % 60 === 0 && minutes < 1440) return `${minutes / 60}h`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${minutes}m`;
}

function resetText(resetsAt: number | undefined): string {
  if (!resetsAt) return '';
  const date = new Date(resetsAt * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `，${sameDay ? '' : `${date.getMonth() + 1}/${date.getDate()} `}${time} 重設`;
}
