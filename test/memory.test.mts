import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeMemClient, memoryFingerprint, resolveClaudeMemConnection } from '../src/memory/claudeMem.ts';

test('worker 位址沿用 settings/env，使用每個使用者的預設 port，不讀 provider token', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-memory-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  assert.equal((await resolveClaudeMemConnection({ homeDir, environment: {}, uid: 501 })).baseUrl, 'http://127.0.0.1:37701');
  const settingsPath = path.join(homeDir, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({
    env: { CLAUDE_MEM_WORKER_PORT: '37777' }, CLAUDE_MEM_LOCAL_API_TOKEN: 'test-local-token',
  }));
  const resolved = await resolveClaudeMemConnection({ settingsPath, environment: { CLAUDE_MEM_WORKER_PORT: '37800' } });
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:37800');
  assert.equal(resolved.token, 'test-local-token');
  const remote = await resolveClaudeMemConnection({ settingsPath, environment: {}, baseUrl: 'https://memory.example.test' });
  assert.equal(remote.token, undefined, '本機 token 不會送往未指定的遠端');
  const otherLocal = await resolveClaudeMemConnection({ settingsPath, environment: {}, baseUrl: 'http://127.0.0.1:39000' });
  assert.equal(otherLocal.token, undefined, '其他 loopback port 也不會取得原 worker 的 token');
  await fs.writeFile(settingsPath, JSON.stringify({
    CLAUDE_MEM_WORKER_URL: 'https://memory.example.test', CLAUDE_MEM_LOCAL_API_TOKEN: 'test-token',
    CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST: 'memory.example.test',
  }));
  assert.equal((await resolveClaudeMemConnection({ settingsPath, environment: {} })).token, 'test-token');
  assert.equal((await resolveClaudeMemConnection({ settingsPath, environment: {}, baseUrl: 'https://memory.example.test:444' })).token, undefined);
});

test('手動保存走真實 HTTP，保存 cwd 與原文、驗證 receipt，並以 ID 讀回', async (t) => {
  const requests: { method?: string; path?: string; body: any; token?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, token: req.headers['x-claude-mem-token'] as string | undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(req.method === 'POST'
      ? JSON.stringify({ success: true, id: 42, title: '保留格式', project: 'repo-key' })
      : JSON.stringify({ id: 42, title: '保留格式', project: 'repo-key', narrative: '保留原本的 401 格式。' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-memory-http-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const settingsPath = path.join(home, 'settings.json');
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(settingsPath, JSON.stringify({ CLAUDE_MEM_LOCAL_API_TOKEN: 'test-token', CLAUDE_MEM_WORKER_PORT: String(port) }));
  const client = new ClaudeMemClient(() => ({ baseUrl: `http://127.0.0.1:${port}`, settingsPath, environment: {} }));
  const fingerprint = memoryFingerprint('task-a', 'save-a', '保留格式', '保留原本的 401 格式。');
  const saved = await client.save({ title: '保留格式', text: '保留原本的 401 格式。', cwd: '/repo/worktree', metadata: { sourceFingerprint: fingerprint, taskId: 'task-a' } });
  assert.deepEqual(saved, { id: 42, title: '保留格式', text: '保留原本的 401 格式。', project: 'repo-key' });
  assert.equal(requests[0].path, '/api/memory/save');
  assert.equal(requests[0].body.cwd, '/repo/worktree');
  assert.equal(requests[0].body.metadata.taskId, 'task-a');
  assert.equal(requests[0].token, 'test-token');
  assert.deepEqual(await client.get(42), saved);
  assert.equal(requests[1].path, '/api/observation/42');
});

test('HTTP 200 的拒絕或缺少 observation ID 不能變成保存成功', async (t) => {
  let receipt: unknown = { success: false, skipped: true, reason: 'project_excluded' };
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(receipt)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-memory-refused-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const client = new ClaudeMemClient(() => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, environment: {}, homeDir }));
  const draft = { title: '測試', text: '需要保留的內容', cwd: '/repo' };
  await assert.rejects(client.save(draft), /已被 Claude-mem 排除/);
  receipt = { success: true };
  await assert.rejects(client.save(draft), /尚未確認保存成功/);
  assert.equal(draft.text, '需要保留的內容');
});

test('重試同一份草稿使用相同 fingerprint；修改內容會產生新 revision', () => {
  const original = memoryFingerprint('a', 'op-1', '標題', '內容');
  assert.equal(original, memoryFingerprint('a', 'op-1', '標題', '內容'));
  assert.notEqual(original, memoryFingerprint('a', 'op-1', '標題', '新內容'));
  assert.notEqual(original, memoryFingerprint('b', 'op-1', '標題', '內容'));
});
