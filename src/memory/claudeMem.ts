import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface ClaudeMemConfig {
  baseUrl?: string;
  settingsPath?: string;
  timeoutMs?: number;
  /** Explicit dependencies also make connection resolution testable without a user's settings. */
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  uid?: number;
}

export interface MemoryInput {
  text: string;
  title: string;
  cwd: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

export interface SavedMemory {
  id: number;
  title: string;
  project: string;
  text: string;
}

interface Connection { baseUrl: string; token?: string; timeoutMs: number }

/** Use the same worker configuration as the existing Claude-mem installation. */
export async function resolveClaudeMemConnection(config: ClaudeMemConfig = {}): Promise<Connection> {
  const env = config.environment ?? process.env;
  const home = config.homeDir ?? os.homedir();
  const expand = (value: string) => value.replace(/^~(?=$|[\\/])/, home);
  const settingsPath = expand(config.settingsPath?.trim() || path.join(home, '.claude-mem', 'settings.json'));
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings');
    const value = parsed as Record<string, unknown>;
    const nested = value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : {};
    settings = { ...nested, ...value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('無法讀取 Claude-mem 設定，請檢查 herdr.claudeMemSettingsPath 與設定檔格式。');
    }
  }
  const setting = (key: string) => typeof settings[key] === 'string' ? String(settings[key]).trim() : '';
  const configured = (key: string) => env[key]?.trim() || setting(key);
  const workerUrl = configured('CLAUDE_MEM_WORKER_URL');
  const override = config.baseUrl?.trim() || workerUrl;
  const host = configured('CLAUDE_MEM_WORKER_HOST') || '127.0.0.1';
  const uid = config.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const port = configured('CLAUDE_MEM_WORKER_PORT') || String(37700 + uid % 100);
  if (!override && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('Claude-mem worker port 必須介於 1 與 65535。');
  }
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let url: URL;
  try { url = new URL(override || `http://${address}:${port}`); }
  catch { throw new Error('Claude-mem worker URL 格式不正確。'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Claude-mem URL 請使用 http(s) 位址，不要包含帳密、查詢參數或片段。');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (!loopback && url.protocol !== 'https:') throw new Error('遠端 Claude-mem worker 請使用 HTTPS，或本機 port forwarding。');
  // The file-owned token belongs to the configured worker, not every service on localhost.
  let workerOrigin: string | undefined;
  try { workerOrigin = new URL(workerUrl || `http://${address}:${port}`).origin; } catch { /* No token for an invalid configured origin. */ }
  const allowedRemote = setting('CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST');
  const token = url.origin === workerOrigin && (loopback || (allowedRemote && allowedRemote === url.hostname))
    ? setting('CLAUDE_MEM_LOCAL_API_TOKEN') || undefined : undefined;
  return { baseUrl: url.toString().replace(/\/$/, ''), token, timeoutMs: config.timeoutMs ?? 10_000 };
}

/** An immutable draft revision, not an upsert key: editing content produces a new fingerprint. */
export function memoryFingerprint(taskId: string, operationId: string, title: string, text: string): string {
  return `herdr:${createHash('sha256').update(JSON.stringify([taskId, operationId, title.trim(), text.trim()])).digest('hex')}`;
}

export class ClaudeMemClient {
  private readonly config: () => ClaudeMemConfig;
  constructor(config: () => ClaudeMemConfig = () => ({})) { this.config = config; }

  private async request(endpoint: string, body?: unknown): Promise<unknown> {
    const connection = await resolveClaudeMemConnection(this.config());
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (connection.token) headers['X-Claude-Mem-Token'] = connection.token;
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(connection.timeoutMs),
      });
    } catch {
      throw new Error('無法連線到 Claude-mem worker。內容已保留，可檢查 worker 與 herdr.claudeMemUrl 後重試。');
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error(`Claude-mem 回傳無效內容（HTTP ${response.status}），尚未確認保存成功。`); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Claude-mem 拒絕存取，請檢查 worker 的 API token 與允許的連線設定。');
      if (response.status === 404) throw new Error('這個 Claude-mem worker 沒有提供所需 API，請確認安裝版本與 worker URL。');
      throw new Error(`Claude-mem 暫時無法完成操作（HTTP ${response.status}）。內容已保留。`);
    }
    return result;
  }

  async save(input: MemoryInput): Promise<SavedMemory> {
    if (!input.text.trim()) throw new Error('請輸入要保存的記憶內容。');
    if (!input.title.trim()) throw new Error('請輸入記憶標題。');
    const result = await this.request('/api/memory/save', {
      text: input.text.trim(), title: input.title.trim(), cwd: input.cwd,
      ...(input.project ? { project: input.project } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }) as Record<string, unknown> | null;
    if (result?.success !== true || !Number.isSafeInteger(result.id) || Number(result.id) < 1) {
      if (result?.reason === 'project_excluded') throw new Error('此專案已被 Claude-mem 排除，記憶尚未保存。');
      throw new Error('Claude-mem 尚未確認保存成功。內容已保留，請檢查 worker 後重試。');
    }
    return {
      id: Number(result.id), title: typeof result.title === 'string' ? result.title : input.title.trim(),
      project: typeof result.project === 'string' ? result.project : input.project ?? '', text: input.text.trim(),
    };
  }

  async get(id: number): Promise<SavedMemory> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('記憶 ID 不正確。');
    const result = await this.request(`/api/observation/${id}`) as Record<string, unknown> | null;
    if (!result || result.id !== id || typeof result.narrative !== 'string') throw new Error('找不到這筆記憶的內容。');
    return { id, title: String(result.title ?? ''), project: String(result.project ?? ''), text: result.narrative };
  }
}
