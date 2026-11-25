import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Snapshot } from './types';

export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function resolveSocketPath(configured: string | undefined): string {
  if (configured && configured.trim()) return configured.replace(/^~(?=$|\/)/, os.homedir());
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  return path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
}

let nextId = 1;

/**
 * herdr socket API 用戶端。
 * 每個請求使用一條新連線。herdr 每行傳一個 JSON，回應的 id 與請求相同。
 */
export class HerdrClient {
  constructor(public socketPath: string) {}

  request<T = any>(method: string, params: object = {}, timeoutMs = 15000): Promise<T> {
    const id = `vscode:${nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => finish(new HerdrError('timeout', `herdr ${method} 逾時（${timeoutMs} ms）`)),
        timeoutMs,
      );
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id !== id) continue;
          if (message.error) finish(new HerdrError(message.error.code ?? 'error', message.error.message ?? 'herdr 錯誤'));
          else finish(null, message.result as T);
        }
      });
      socket.on('error', (err) => finish(new HerdrError('connection', `無法連線到 herdr：${err.message}`)));
      socket.on('close', () => finish(new HerdrError('connection', `herdr 在回應 ${method} 前關閉連線`)));
    });
  }

  async snapshot(): Promise<Snapshot> {
    const result = await this.request<{ snapshot: Snapshot }>('session.snapshot');
    return result.snapshot;
  }
}

const GLOBAL_EVENTS = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.closed',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
];

/**
 * 訂閱 herdr 事件。任何事件都會觸發 'change'。
 * agent 狀態事件需要指定 pane，所以 pane 清單改變時會重新訂閱。
 * 連線中斷時會自動重新連線。
 */
export class HerdrEvents extends EventEmitter {
  private socket: net.Socket | undefined;
  private panes: string[] = [];
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelay = 1000;
  private disposed = false;
  private immediate = false;

  constructor(private readonly client: HerdrClient) {
    super();
  }

  start(): void {
    this.connect();
  }

  watchPanes(paneIds: string[]): void {
    const next = [...new Set(paneIds)].sort();
    if (next.join(',') === this.panes.join(',')) return;
    this.panes = next;
    this.reconnectNow();
  }

  reconnectNow(): void {
    this.immediate = true;
    this.socket?.destroy();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.socket?.destroy();
    this.removeAllListeners();
  }

  private connect(): void {
    if (this.disposed) return;
    const socket = net.createConnection(this.client.socketPath);
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const subscriptions = [
        ...GLOBAL_EVENTS.map((type) => ({ type })),
        ...this.panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      ];
      socket.write(JSON.stringify({ id: 'vscode:events', method: 'events.subscribe', params: { subscriptions } }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 'vscode:events') {
          if (message.error) {
            // 常見原因：訂閱的 pane 剛好被關閉。移除 pane 訂閱後重連，下一次更新會重新指定 pane。
            this.emit('subscribeFailed', new HerdrError(message.error.code, message.error.message));
            this.panes = [];
            socket.destroy();
          } else {
            this.retryDelay = 1000;
            this.emit('connected');
          }
          continue;
        }
        this.emit('change', message);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket || this.disposed) return;
      this.emit('disconnected');
      const delay = this.immediate ? 50 : this.retryDelay;
      this.immediate = false;
      this.retryTimer = setTimeout(() => this.connect(), delay);
      if (delay !== 50) this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    });
  }
}
