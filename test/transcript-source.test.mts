import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function fixture(t: TestContext, sessionIds = ['session-nine']) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-pane-source-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const day = new Date();
  const directory = path.join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  await fs.mkdir(directory, { recursive: true });
  const files: Record<string, string> = {};
  for (const id of sessionIds) {
    const file = path.join(directory, `rollout-${id}.jsonl`);
    await fs.writeFile(file, [
      { type: 'session_meta', payload: { id, cwd: '/same-checkout' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `native:${id}` }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    files[id] = file;
  }
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['src/transcript/source.ts'],
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'pane-source-home', setup(builder) {
      builder.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const homedir = () => ${JSON.stringify(home)};` }));
    } }],
  });
  const { TranscriptSource } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const calls: { method: string; params: any }[] = [];
  const source = new TranscriptSource({ request: async (method: string, params: any) => {
    calls.push({ method, params });
    assert.equal(method, 'pane.read');
    return { read: { text: `terminal:${params.pane_id}` } };
  } }, () => 30);
  const pane = (id: string, sessionId?: string) => ({
    pane_id: id, tab_id: 'wE:t1', workspace_id: 'wE', focused: false, agent: 'codex',
    cwd: '/same-checkout', foreground_cwd: '/same-checkout',
    ...(sessionId ? { agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: sessionId } } : {}),
  });
  return { source, calls, files, pane };
}

test('Codex 沒有 session 識別資訊時，顯示自己的終端機，不依工作目錄猜對話', async (t) => {
  const f = await fixture(t);
  const result = await f.source.read(f.pane('wE:p2'));
  assert.equal(result.source, 'terminal');
  assert.equal(result.messages[0].text, 'terminal:wE:p2');
});

test('同目錄的已識別與未識別 pane 不會共用對話，讀取順序不影響結果', async (t) => {
  for (const unknownFirst of [false, true]) {
    const f = await fixture(t);
    const panes = [f.pane('wE:p9', 'session-nine'), f.pane('wE:p2')];
    if (unknownFirst) panes.reverse();
    const results = new Map<string, any>();
    for (const pane of panes) results.set(pane.pane_id, await f.source.read(pane));
    assert.equal(results.get('wE:p9').messages[0].text, 'native:session-nine');
    assert.equal(results.get('wE:p2').messages[0].text, 'terminal:wE:p2');
  }
});

test('並行讀取兩個沒有 session ID 的 pane，各自只讀自己的終端機', async (t) => {
  const f = await fixture(t, ['session-a', 'session-b']);
  const results = await Promise.all(['wE:p2', 'wE:p9'].map((id) => f.source.read(f.pane(id))));
  assert.equal(results[0].messages[0].text, 'terminal:wE:p2');
  assert.equal(results[1].messages[0].text, 'terminal:wE:p9');
});

test('Codex 有明確 session ID 時，只顯示該 session 的原生對話', async (t) => {
  const f = await fixture(t, ['session-a', 'session-b']);
  const results = await Promise.all([f.source.read(f.pane('wE:p2', 'session-a')), f.source.read(f.pane('wE:p9', 'session-b'))]);
  assert.equal(results[0].source, 'codex');
  assert.equal(results[0].messages[0].text, 'native:session-a');
  assert.equal(results[1].messages[0].text, 'native:session-b');
});

test('明確 session ID 找不到紀錄時，不退回同目錄的其他對話', async (t) => {
  const f = await fixture(t);
  const result = await f.source.read(f.pane('wE:p2', 'missing-session'));
  assert.equal(result.source, 'terminal');
  assert.equal(result.messages[0].text, 'terminal:wE:p2');
});

test('pane 失去 session 識別資訊後，不沿用之前快取的原生對話', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.source.read(f.pane('wE:p2', 'session-nine'))).source, 'codex');
  const result = await f.source.read(f.pane('wE:p2'));
  assert.equal(result.source, 'terminal');
  assert.equal(result.messages[0].text, 'terminal:wE:p2');
});

test('明確 session 檔案路徑仍可顯示原生對話', async (t) => {
  const f = await fixture(t);
  const pane: any = f.pane('wE:p9');
  pane.agent_session = { agent: 'codex', kind: 'path', source: 'herdr:codex', value: f.files['session-nine'] };
  const result = await f.source.read(pane);
  assert.equal(result.source, 'codex');
  assert.equal(result.messages[0].text, 'native:session-nine');
});
