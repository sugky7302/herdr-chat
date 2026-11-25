// 把 Claude Code 與 Codex 的原生對話紀錄（JSONL）轉成對話泡泡。
// 這個檔案只做純文字轉換，不讀檔，方便測試。

import type { ChatMessage, Usage } from '../shared';

export interface ParsedTranscript {
  messages: ChatMessage[];
  model?: string;
  effort?: string;
  usage?: Usage;
}

const MAX_MESSAGES = 300;
const MAX_TOOL_SUMMARY = 160;

function eachJson(text: string, visit: (value: any) => void): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // 檔案寫到一半時最後一行可能不完整，略過即可。
    }
  }
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    try {
      return summarizeToolInput(JSON.parse(input));
    } catch {
      return clip(input, MAX_TOOL_SUMMARY);
    }
  }
  if (typeof input !== 'object') return clip(String(input), MAX_TOOL_SUMMARY);
  const value = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const field = value[key];
    if (typeof field === 'string' && field) return clip(field, MAX_TOOL_SUMMARY);
    if (Array.isArray(field) && field.length) return clip(field.join(' '), MAX_TOOL_SUMMARY);
  }
  return clip(JSON.stringify(value), MAX_TOOL_SUMMARY);
}

function pushMessage(messages: ChatMessage[], message: ChatMessage): void {
  if (!message.text.trim() && message.role !== 'tool') return;
  const last = messages[messages.length - 1];
  // 同一回合連續的文字區塊合併成一個泡泡。
  if (last && last.role === message.role && message.role === 'assistant') {
    last.text += '\n\n' + message.text;
    return;
  }
  messages.push(message);
}

function finish(messages: ChatMessage[], model?: string, effort?: string, usage?: Usage): ParsedTranscript {
  return { messages: messages.slice(-MAX_MESSAGES), model, effort, usage };
}

/** 判斷使用者訊息是不是系統自動加入的內容，而不是使用者輸入的文字。 */
function isInjectedUserText(text: string): boolean {
  const start = text.trimStart();
  return (
    start.startsWith('<command-') ||
    start.startsWith('<local-command-') ||
    start.startsWith('<system-reminder>') ||
    start.startsWith('<environment_context>') ||
    start.startsWith('<user_instructions>') ||
    start.startsWith('<turn_aborted>') ||
    start.startsWith('# AGENTS.md instructions') ||
    start.startsWith('Caveat: The messages below')
  );
}

/** 從 `<command-name>/model</command-name><command-args>opus</command-args>` 取出斜線指令。 */
function slashCommand(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

export function parseClaude(text: string): ParsedTranscript {
  const messages: ChatMessage[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  // Claude Code 會把同一則回覆拆成多行，每行帶相同的 usage，所以依訊息 id 只算一次。
  const usageById = new Map<string, any>();
  let lastUsage: any;
  eachJson(text, (entry) => {
    if (entry.isSidechain) return;
    const message = entry.message;
    if (entry.type === 'user' && message) {
      if (entry.isMeta) return;
      const content = message.content;
      if (typeof content === 'string') {
        const command = slashCommand(content);
        if (command) {
          pushMessage(messages, { role: 'notice', text: command });
          const effortMatch = /^\/effort\s+(\S+)/.exec(command);
          if (effortMatch) effort = effortMatch[1];
        } else if (!isInjectedUserText(content)) {
          pushMessage(messages, { role: 'user', text: content });
        }
        return;
      }
      if (Array.isArray(content)) {
        const texts = content
          .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text as string)
          .filter((part: string) => !isInjectedUserText(part));
        if (texts.length) pushMessage(messages, { role: 'user', text: texts.join('\n\n') });
      }
      return;
    }
    if (entry.type === 'assistant' && message) {
      if (typeof message.model === 'string' && message.model !== '<synthetic>') model = message.model;
      if (message.usage && typeof message.usage === 'object') {
        usageById.set(String(message.id ?? entry.uuid ?? usageById.size), message.usage);
        lastUsage = message.usage;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          pushMessage(messages, { role: 'assistant', text: part.text });
        } else if (part?.type === 'tool_use') {
          pushMessage(messages, { role: 'tool', tool: String(part.name ?? 'tool'), text: summarizeToolInput(part.input) });
        }
      }
    }
  });
  let usage: Usage | undefined;
  if (lastUsage) {
    const sum = (u: any) =>
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    usage = {
      contextTokens: sum(lastUsage),
      totalTokens: [...usageById.values()].reduce((total, u) => total + sum(u), 0),
      outputTokens: [...usageById.values()].reduce((total, u) => total + (u.output_tokens ?? 0), 0),
    };
  }
  return finish(messages, model, effort, usage);
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => typeof part?.text === 'string')
    .map((part: any) => part.text as string)
    .join('\n\n');
}

export function parseCodex(text: string): ParsedTranscript {
  const messages: ChatMessage[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  let usage: Usage | undefined;
  eachJson(text, (entry) => {
    const payload = entry.payload ?? {};
    if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info;
      const primary = payload.rate_limits?.primary;
      usage = {
        contextTokens: info?.last_token_usage?.total_tokens ?? usage?.contextTokens,
        contextWindow: info?.model_context_window ?? usage?.contextWindow,
        totalTokens: info?.total_token_usage?.total_tokens ?? usage?.totalTokens,
        outputTokens: info?.total_token_usage?.output_tokens ?? usage?.outputTokens,
        rateLimitPercent: typeof primary?.used_percent === 'number' ? primary.used_percent : usage?.rateLimitPercent,
        rateLimitWindowMinutes: primary?.window_minutes ?? usage?.rateLimitWindowMinutes,
      };
      return;
    }
    if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      const nextEffort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort;
      if (typeof nextEffort === 'string') effort = nextEffort;
      return;
    }
    if (entry.type !== 'response_item') return;
    if (payload.type === 'message') {
      const body = codexText(payload.content);
      if (payload.role === 'user') {
        if (!isInjectedUserText(body)) pushMessage(messages, { role: 'user', text: body });
      } else if (payload.role === 'assistant') {
        pushMessage(messages, { role: 'assistant', text: body });
      }
      return;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
      const input = payload.arguments ?? payload.input ?? payload.action;
      pushMessage(messages, { role: 'tool', tool: String(payload.name ?? 'shell'), text: summarizeToolInput(input) });
    }
  });
  return finish(messages, model, effort, usage);
}

/** Claude Code 把專案路徑中非英數字元換成 - 當作資料夾名稱。 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
