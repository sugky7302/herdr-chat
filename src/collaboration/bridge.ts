import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RpcInput } from './types.ts';

export interface CollaborationBridge {
  connectionFile: string;
  dispose(): Promise<void>;
}

const commands = new Set(['status', 'spawn', 'delegate', 'wait', 'report', 'answer', 'accept']);

/** A private loopback endpoint owned by this extension host; it is not a separate daemon. */
export async function startBridge(directory: string, dispatch: (input: RpcInput) => Promise<unknown>): Promise<CollaborationBridge> {
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let port = 0;
  const server = createServer(async (req, res) => {
    const reply = (status: number, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const providedAuth = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}` || providedAuth.length !== expectedAuth.length || !timingSafeEqual(providedAuth, expectedAuth)) {
      req.resume();
      reply(403, { ok: false, error: { code: 'unauthorized', message: '此連線未獲協作服務授權。' } });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      req.resume(); reply(404, { ok: false, error: { code: 'not_found', message: 'Unknown collaboration endpoint.' } }); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw Object.assign(new Error('協作訊息超過 1 MiB。'), { code: 'too_large' });
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcInput;
      if (!input || !commands.has(input.command) || typeof input.taskId !== 'string' || !input.caller || typeof input.caller.paneId !== 'string' || !Number.isSafeInteger(input.caller.generation) || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
        throw Object.assign(new Error('不完整的協作要求。'), { code: 'invalid_request' });
      }
      reply(200, { ok: true, result: await dispatch(input) });
    } catch (error) {
      reply(400, { ok: false, error: { code: (error as { code?: string }).code ?? 'collaboration_error', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  // An explicit wait can last 180 seconds; the HTTP connection must outlive it.
  server.requestTimeout = 210000;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  // Keep the path stable across extension reloads: workers retain this path in their original prompt.
  // The TaskStore owner lock excludes another host until this descriptor is closed and removed.
  const connectionFile = path.join(directory, 'connection.json');
  const temporaryConnection = `${connectionFile}.${token.slice(0, 16)}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporaryConnection, JSON.stringify({ version: 1, url: `http://127.0.0.1:${port}/rpc`, token, pid: process.pid }), { mode: 0o600 });
    await fs.rename(temporaryConnection, connectionFile);
  } catch (error) {
    server.close();
    throw error;
  } finally {
    await fs.unlink(temporaryConnection).catch(() => undefined);
  }
  return {
    connectionFile,
    async dispose() {
      server.close();
      server.closeAllConnections();
      // The service releases its exclusive owner lock only after this descriptor has been removed.
      await fs.unlink(connectionFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}
