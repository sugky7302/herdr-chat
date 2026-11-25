import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { HerdrClient } from '../herdr/client';
import type { PaneInfo } from '../herdr/types';
import type { Transcript } from '../shared';
import { claudeProjectDirName, dshWorkspaceDirName, parseAgy, parseClaude, parseCodex, parseDsh, type ParsedTranscript } from './parse';
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
  private dshFileByPane = new Map<string, string>();

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
      } else if (kind === 'dsh' || kind === 'dsh-tui') {
        const file = await this.findDshFile(pane);
        if (file) return this.withDshStatus(file, await this.fromFile(pane.pane_id, 'dsh', file, parseDsh));
        const idle = await this.dshIdleTranscript(pane);
        if (idle) return idle;
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
    source: 'claude' | 'codex' | 'agy' | 'dsh',
    file: string,
    parse: (text: string) => ParsedTranscript,
  ): Promise<Transcript> {
    const stat = await fs.stat(file);
    let entry = this.cache.get(paneId);
    if (!entry || entry.file !== file || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      const raw = file.endsWith('.zstd')
        ? zstdDecompressSync(await fs.readFile(file)).toString('utf8')
        : await fs.readFile(file, 'utf8');
      const parsed = parse(raw);
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
      // A known session must never fall back to another agent's transcript in the same checkout.
      return match ?? null;
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

  /**
   * 尋找 dsh-tui 的原生對話紀錄（~/.dsh/sessions/<workspace>/<session-id>/session*.jsonl.zstd）。
   * 優先使用 pane 的前景 process PID 對照 ~/.dsh-tui/session-mounts.json，再退回該目錄最新的紀錄。
   */
  private async findDshFile(pane: PaneInfo): Promise<string | null> {
    const session = pane.agent_session;
    if (session?.kind === 'path') return session.value;
    if (session?.kind === 'id') {
      const byId = await findDshSessionLogById(session.value);
      if (byId) return byId;
    }
    const mountedIds = await this.findMountedDshSessions(pane.pane_id);
    for (const id of mountedIds) {
      const file = await findDshSessionLogById(id);
      if (file) {
        this.dshFileByPane.set(pane.pane_id, file);
        return file;
      }
    }
    if (mountedIds.length > 0) {
      // 已掛載新 session 但尚未送出第一則訊息（目錄尚未寫入磁碟）。
      return null;
    }
    const remembered = this.dshFileByPane.get(pane.pane_id);
    if (remembered && (await exists(remembered))) return remembered;
    const cwd = pane.foreground_cwd ?? pane.cwd;
    if (!cwd) return null;
    const files = await recentDshFilesForCwd(cwd);
    const claimed = new Set(this.dshFileByPane.values());
    const found = files.find((f) => !claimed.has(f)) ?? files[0] ?? null;
    if (found) this.dshFileByPane.set(pane.pane_id, found);
    return found;
  }

  private async findMountedDshSessions(paneId: string): Promise<string[]> {
    try {
      const [mountsText, procInfo] = await Promise.all([
        fs.readFile(path.join(os.homedir(), '.dsh-tui', 'session-mounts.json'), 'utf8'),
        this.client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null),
      ]);
      const mounts = JSON.parse(mountsText);
      const owners: { pid: number; sessionIds?: string[] }[] = Array.isArray(mounts?.owners) ? mounts.owners : [];
      if (!owners.length) return [];
      const pids = new Set<number>();
      if (typeof procInfo?.process_info?.foreground_process_group_id === 'number') {
        pids.add(procInfo.process_info.foreground_process_group_id);
      }
      for (const proc of procInfo?.process_info?.foreground_processes ?? []) {
        if (typeof proc?.pid === 'number') pids.add(proc.pid);
      }
      for (const owner of owners) {
        if (pids.has(owner.pid) && Array.isArray(owner.sessionIds) && owner.sessionIds.length) {
          return owner.sessionIds;
        }
      }
    } catch {
      // 忽略讀取失敗。
    }
    return [];
  }

  /** 從 ~/.dsh/storages/session_projcache 與 ~/.dsh-tui 偏好檔補齊 dsh-tui 的模型、effort 與 token 用量。 */
  private async withDshStatus(file: string, transcript: Transcript): Promise<Transcript> {
    const sessionId = path.basename(path.dirname(file));
    const projFile = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const next = { ...transcript };
    try {
      const data = JSON.parse(await fs.readFile(projFile, 'utf8'));
      const rows = data?.record?.rows ?? {};
      const sel = rows.modelSelection?.val?.lastUsed;
      if (typeof sel?.model === 'string' && sel.model) next.model = sel.model;
      if (typeof sel?.reasoningEffort === 'string' && sel.reasoningEffort) next.effort = sel.reasoningEffort;
      const tu = rows.tokenUsage?.val;
      if (tu) {
        const sumBucket = (b: any) =>
          (b?.uncachedInputTokens ?? 0) + (b?.cacheReadTokens ?? 0) + (b?.cacheWriteTokens ?? 0) + (b?.outputTokens ?? 0);
        const contextTokens = tu.last?.buckets ? sumBucket(tu.last.buckets) : next.usage?.contextTokens;
        const totalTokens = tu.totals ? sumBucket(tu.totals) : next.usage?.totalTokens;
        const outputTokens = tu.totals?.outputTokens ?? next.usage?.outputTokens;
        next.usage = {
          ...(next.usage ?? {}),
          contextTokens,
          contextWindow: next.usage?.contextWindow ?? 1_048_576,
          totalTokens,
          outputTokens,
        };
      }
    } catch {
      // 快取不存在時維持從日誌解析出的結果。
    }
    const prefs = await readDshPrefs();
    next.model ??= prefs.model;
    next.effort ??= prefs.effort;
    return next;
  }

  /** 新啟動的 dsh-tui 尚未送出第一則訊息時，直接顯示空白對話並附上目前的模型、effort 與上下文容量。 */
  private async dshIdleTranscript(pane: PaneInfo): Promise<Transcript | null> {
    const prefs = await readDshPrefs();
    return {
      paneId: pane.pane_id,
      source: 'dsh',
      messages: [],
      model: prefs.model,
      effort: prefs.effort,
      usage: {
        contextTokens: 0,
        contextWindow: 1_048_576,
      },
    };
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

function dshSessionRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (process.env.DSH_TUI_SESSION_ROOT?.trim()) roots.push(process.env.DSH_TUI_SESSION_ROOT.trim());
  const dshHome = process.env.DSH_HOME?.trim() || path.join(home, '.dsh');
  roots.push(path.join(dshHome, 'sessions'));
  roots.push(path.join(home, '.dsh-tui', 'sessions'));
  return [...new Set(roots)];
}

/** 找出單一 dsh session 資料夾內最新世代的紀錄檔（例如 session.v4.jsonl.zstd）。 */
async function selectDshGenerationLog(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let best: { name: string; version: number; compressed: boolean } | null = null;
  for (const name of entries) {
    const compressed = name.endsWith('.zstd');
    const base = compressed ? name.slice(0, -'.zstd'.length) : name;
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/.exec(base);
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 0;
    if (!best || version > best.version || (version === best.version && compressed && !best.compressed)) {
      best = { name, version, compressed };
    }
  }
  return best ? path.join(dir, best.name) : null;
}

async function findDshSessionLogById(sessionId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) return null;
  for (const root of dshSessionRoots()) {
    const workspaces = await fs.readdir(root).catch(() => [] as string[]);
    for (const ws of workspaces) {
      for (const candidateId of [sessionId, `session-${sessionId}`]) {
        const found = await selectDshGenerationLog(path.join(root, ws, candidateId));
        if (found) return found;
      }
    }
  }
  return null;
}

async function recentDshFilesForCwd(cwd: string): Promise<string[]> {
  const targetDir = dshWorkspaceDirName(cwd);
  const candidates: { file: string; mtime: number }[] = [];
  for (const root of dshSessionRoots()) {
    const wsDir = path.join(root, targetDir);
    const sessions = await fs.readdir(wsDir).catch(() => [] as string[]);
    for (const sid of sessions) {
      const logFile = await selectDshGenerationLog(path.join(wsDir, sid));
      if (!logFile) continue;
      const stat = await fs.stat(logFile).catch(() => null);
      if (stat) candidates.push({ file: logFile, mtime: stat.mtimeMs });
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime).map((c) => c.file);
}

async function readDshPrefs(): Promise<{ model?: string; effort?: string }> {
  const dir = path.join(os.homedir(), '.dsh-tui');
  let model: string | undefined;
  let effort: string | undefined;
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'model.json'), 'utf8'));
    if (typeof m?.model === 'string' && m.model) model = m.model;
  } catch {
    // 預設為 deepseek-flash
  }
  try {
    const e = JSON.parse(await fs.readFile(path.join(dir, 'effort.json'), 'utf8'));
    if (typeof e?.effort === 'string' && e.effort) effort = e.effort;
  } catch {
    // 預設為 max
  }
  return { model: model ?? 'deepseek-flash', effort: effort ?? 'max' };
}
