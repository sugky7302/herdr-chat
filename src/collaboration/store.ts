import { t } from '../l10n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CollaborationTask } from './types.ts';
import { setError, systemMessage } from './localization.ts';

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
    if (!guard) throw new Error(t("The collaboration owner.guard is in use by another window, or a previous startup was interrupted. An unverified lock will not be removed automatically."));
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
        if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid < 1 || typeof owner.nonce !== 'string') throw new Error(t("The collaboration owner.json is incomplete. It will not be overwritten to protect existing tasks."));
        let exited = false;
        try { process.kill(owner.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exited = true; }
        if (!exited) throw new Error(t("Another VS Code window owns collaboration for this workspace. Use the original window."));
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
      if (data?.version !== 1 || !Array.isArray(data.tasks)) throw new Error(t("Unsupported collaboration history format."));
      for (const task of data.tasks) {
        if (!task || typeof task.id !== 'string' || !Array.isArray(task.requests) || !Array.isArray(task.events)) {
          throw new Error(t("Collaboration history is corrupted. Keep tasks.json for recovery."));
        }
        task.userMessages ??= [];
        task.memoryReferences ??= [];
        task.handoffs ??= [];
        task.participants ??= [];
        task.enabled ??= false;
        if (task.plannerDelivery?.status === 'sending') {
          task.plannerDelivery = { status: 'uncertain', at: new Date().toISOString() };
          setError(task.plannerDelivery, systemMessage('The extension restarted while sending the planner entry. Copy the entry and run status to verify it; it will not be resent automatically.'));
        }
        for (const request of task.requests) {
          request.reports ??= request.report ? [{ ...request.report, revision: request.revision ?? 0 }] : [];
          request.replies ??= [];
          request.revision ??= 0;
          // A restart loses the live wait, not the request. Keep the worker reserved until a report arrives.
          if (request.status === 'sending' || request.status === 'running') {
            request.status = 'wait_expired';
            setError(request, systemMessage('The extension restarted. Inspect the agent status or continue waiting; the original request will not be resent.'));
          }
        }
        for (const handoff of task.handoffs) {
          if (handoff.status === 'preparing') {
            handoff.status = 'failed';
            setError(handoff, systemMessage('The extension restarted while preparing the handoff. The previous planner remains paused; select a successor again.'));
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
