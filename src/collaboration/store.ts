import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CollaborationTask } from './types.ts';

/** The service is the single writer. Replacing a private file makes each snapshot atomic. */
export class TaskStore {
  readonly file: string;
  private readonly directory: string;
  private readonly ownerNonce = randomUUID();
  private ownsLock = false;
  constructor(directory: string) { this.directory = directory; this.file = path.join(directory, 'tasks.json'); }

  private async withGuard<T>(operation: () => Promise<T>): Promise<T> {
    const guardPath = path.join(this.directory, 'owner.guard');
    let guard: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { guard = await fs.open(guardPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!guard) throw new Error('協作 owner.guard 正由另一個視窗操作，或先前啟動被中斷；不會自動移除未確認的鎖。');
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid, nonce: this.ownerNonce }));
      return await operation();
    } finally {
      await guard.close();
      await fs.unlink(guardPath);
    }
  }

  /** Only one extension host may write this workspace's tasks. Never replace a live owner's lock. */
  async acquire(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.withGuard(async () => {
      const lockPath = path.join(this.directory, 'owner.json');
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number; nonce?: string };
        if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid < 1 || typeof owner.nonce !== 'string') throw new Error('協作 owner.json 資料不完整；為保護現有任務，不會覆寫。');
        let exited = false;
        try { process.kill(owner.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exited = true; }
        if (!exited) throw new Error('同一工作區已有另一個 VS Code 視窗擁有協作服務；請在原視窗操作。');
        await fs.unlink(lockPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const ownerFile = await fs.open(lockPath, 'wx', 0o600);
      try { await ownerFile.writeFile(JSON.stringify({ pid: process.pid, nonce: this.ownerNonce })); }
      finally { await ownerFile.close(); }
      this.ownsLock = true;
    });
  }

  async release(): Promise<void> {
    if (!this.ownsLock) return;
    await this.withGuard(async () => {
      const lockPath = path.join(this.directory, 'owner.json');
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid: number; nonce: string };
      if (owner.pid === process.pid && owner.nonce === this.ownerNonce) await fs.unlink(lockPath);
      this.ownsLock = false;
    });
  }

  async load(): Promise<CollaborationTask[]> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.tasks)) throw new Error('不支援的協作紀錄格式。');
      for (const task of data.tasks) {
        if (!task || typeof task.id !== 'string' || !Array.isArray(task.requests) || !Array.isArray(task.events)) {
          throw new Error('協作紀錄損毀；請保留 tasks.json 以便復原。');
        }
        task.userMessages ??= [];
        task.memoryReferences ??= [];
        task.handoffs ??= [];
        task.participants ??= [];
        task.enabled ??= false;
        if (task.plannerDelivery?.status === 'sending') {
          task.plannerDelivery = { status: 'uncertain', at: new Date().toISOString(),
            error: '規劃者入口傳送期間擴充功能重新啟動；請複製入口並執行 status 確認，不會自動重送。' };
        }
        for (const request of task.requests) {
          request.reports ??= request.report ? [{ ...request.report, revision: request.revision ?? 0 }] : [];
          request.replies ??= [];
          request.revision ??= 0;
          // A restart loses the live wait, not the request. Keep the worker reserved until a report arrives.
          if (request.status === 'sending' || request.status === 'running') {
            request.status = 'wait_expired';
            request.error = '擴充功能重新啟動；請查看 agent 狀態或繼續等待，原要求不會重新送出。';
          }
        }
        for (const handoff of task.handoffs) {
          if (handoff.status === 'preparing') {
            handoff.status = 'failed';
            handoff.error = '交接準備期間擴充功能重新啟動；舊規劃者仍已凍結，請重新選擇接手者。';
          }
        }
      }
      return data.tasks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(tasks: CollaborationTask[]): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, tasks }), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}
