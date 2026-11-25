import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HerdrClient } from '../herdr/client';
import type { PaneInfo } from '../herdr/types';
import type { Transcript } from '../shared';
import { claudeProjectDirName, parseAgy, parseClaude, parseCodex, type ParsedTranscript } from './parse';
import { readStatus } from '../claudeUsage';

interface CacheEntry {
  file: string;
  mtimeMs: number;
  size: number;
  parsed: ParsedTranscript;
}

/**
 * 依照 pane 的 agent 種類讀取對話紀錄。
 * Claude 與 Codex 讀原生 JSONL 紀錄；其他 agent 或找不到紀錄時讀終端機文字。
 */
export class TranscriptSource {
  private cache = new Map<string, CacheEntry>();
  private codexFileByPane = new Map<string, string>();

  constructor(
    private readonly client: HerdrClient,
    private readonly terminalLines: () => number,
  ) {}

  async read(pane: PaneInfo): Promise<Transcript> {
    const kind = pane.agent ?? null;
    try {
      if (kind === 'claude') {
        const file = await this.findClaudeFile(pane);
        if (file) return this.withClaudeStatus(pane, await this.fromFile(pane.pane_id, 'claude', file, parseClaude));
      } else if (kind === 'codex') {
        const file = await this.findCodexFile(pane);
        if (file) return this.fromFile(pane.pane_id, 'codex', file, parseCodex);
      } else if (kind === 'agy') {
        const file = await this.findAgyFile(pane);
        if (file) return this.fromFile(pane.pane_id, 'agy', file, parseAgy);
      }
    } catch {
      // 讀不到原生紀錄時改用終端機文字。
    }
    return this.fromTerminal(pane);
  }

  /** 加上 statusline 腳本保存的方案用量（5 小時、7 天）與上下文上限。 */
  private async withClaudeStatus(pane: PaneInfo, transcript: Transcript): Promise<Transcript> {
    const sessionId = pane.agent_session?.kind === 'id' ? pane.agent_session.value : undefined;
    const status = sessionId ? await readStatus(sessionId) : null;
    if (!status) return transcript;
    const usage = { ...(transcript.usage ?? {}) };
    if (status.fiveHour) {
      usage.rateLimitPercent = status.fiveHour.usedPercent;
      usage.rateLimitWindowMinutes = 300;
      usage.rateLimitResetsAt = status.fiveHour.resetsAt;
    }
    if (status.sevenDay) {
      usage.secondaryPercent = status.sevenDay.usedPercent;
      usage.secondaryWindowMinutes = 10080;
      usage.secondaryResetsAt = status.sevenDay.resetsAt;
    }
    if (status.contextWindow) usage.contextWindow = status.contextWindow;
    return { ...transcript, usage };
  }

  private async fromFile(
    paneId: string,
    source: 'claude' | 'codex' | 'agy',
    file: string,
    parse: (text: string) => ParsedTranscript,
  ): Promise<Transcript> {
    const stat = await fs.stat(file);
    let entry = this.cache.get(paneId);
    if (!entry || entry.file !== file || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      const parsed = parse(await fs.readFile(file, 'utf8'));
      entry = { file, mtimeMs: stat.mtimeMs, size: stat.size, parsed };
      this.cache.set(paneId, entry);
    }
    return { paneId, source, ...entry.parsed };
  }

  private async fromTerminal(pane: PaneInfo): Promise<Transcript> {
    const result = await this.client.request<any>('pane.read', {
      pane_id: pane.pane_id,
      source: 'recent_unwrapped',
      lines: this.terminalLines(),
      strip_ansi: true,
    });
    const text: string = result?.read?.text ?? result?.text ?? '';
    return {
      paneId: pane.pane_id,
      source: 'terminal',
      messages: [{ role: 'terminal', text: text.replace(/\s+$/, '') }],
    };
  }

  private async findClaudeFile(pane: PaneInfo): Promise<string | null> {
    const session = pane.agent_session;
    if (!session) return null;
    if (session.kind === 'path') return session.value;
    const root = path.join(os.homedir(), '.claude', 'projects');
    const name = `${session.value}.jsonl`;
    for (const cwd of [pane.cwd, pane.foreground_cwd]) {
      if (!cwd) continue;
      const candidate = path.join(root, claudeProjectDirName(cwd), name);
      if (await exists(candidate)) return candidate;
    }
    // 對話途中切換過目錄時，紀錄可能放在別的專案資料夾。
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      const candidate = path.join(root, dir, name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  private async findCodexFile(pane: PaneInfo): Promise<string | null> {
    const session = pane.agent_session;
    if (session?.kind === 'path') return session.value;
    const files = await recentCodexFiles();
    if (session?.kind === 'id') {
      const match = files.find((file) => file.includes(session.value));
      if (match) return match;
    }
    // 沒有 session id 時，用工作目錄找最近更新的紀錄。
    // 同一目錄同時有多個 Codex 時可能配錯，所以記住第一次的結果。
    const remembered = this.codexFileByPane.get(pane.pane_id);
    if (remembered && (await exists(remembered))) return remembered;
    const cwd = pane.foreground_cwd ?? pane.cwd;
    if (!cwd) return null;
    const claimed = new Set(this.codexFileByPane.values());
    for (const file of files) {
      if (claimed.has(file)) continue;
      if ((await codexSessionCwd(file)) === cwd) {
        this.codexFileByPane.set(pane.pane_id, file);
        return file;
      }
    }
    return null;
  }

  private async findAgyFile(pane: PaneInfo): Promise<string | null> {
    const session = pane.agent_session;
    if (!session) return null;
    if (session.kind === 'path') return session.value;
    const logsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', session.value, '.system_generated', 'logs');
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const candidate = path.join(logsDir, name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 列出最近三天的 Codex 紀錄，最新的在前面。 */
async function recentCodexFiles(): Promise<string[]> {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files: { file: string; mtime: number }[] = [];
  const now = new Date();
  for (let offset = 0; offset < 3; offset++) {
    const day = new Date(now.getTime() - offset * 86400000);
    const dir = path.join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    );
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) files.push({ file, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
}

async function codexSessionCwd(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // 第一行含有很長的系統指示，可能超過讀取範圍，所以用正規表示式找 cwd。
    const head = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    return match ? JSON.parse(`"${match[1]}"`) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
