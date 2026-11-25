import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 使用真正的 Controller 方法；只替代 VS Code 載入與對話更新邊界。
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: { contents: 'export { Controller } from "./src/controller.ts"; export { setLocale } from "./src/l10n.ts";', resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'vscode-test-host',
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    },
  }],
});
const { Controller, setLocale } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
setLocale('zh-tw');

interface Item { id: number; text: string; attachments: string[]; model?: string; effort?: string }
function setup(entries: [string, Item[]][]) {
  const controller = Object.create(Controller.prototype);
  controller.queues = new Map(entries);
  const updates: unknown[] = [];
  controller.pushTranscript = async () => updates.push(structuredClone([...controller.queues]));
  return { controller, updates };
}

test('修改待送訊息會保留排隊順序、附件、模型與 effort，並更新畫面', async () => {
  const first = { id: 1, text: '第一則', attachments: [] };
  const edited = { id: 2, text: '原文', attachments: ['/tmp/report.md'], model: 'opus', effort: 'high' };
  const last = { id: 3, text: '第三則', attachments: [] };
  const queue = [first, edited, last];
  const { controller, updates } = setup([['pane-a', queue]]);
  await controller.updateQueued('pane-a', 2, '  修改內容\n保留換行  ');
  assert.deepEqual(queue, [first, { ...edited, text: '修改內容\n保留換行' }, last]);
  assert.deepEqual(queue.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(edited.attachments, ['/tmp/report.md']);
  assert.equal(edited.model, 'opus');
  assert.equal(edited.effort, 'high');
  assert.equal(updates.length, 1);
});

test('拒絕修改已送出或已移除的訊息，也不會重新加入佇列', async () => {
  const { controller, updates } = setup([['pane-a', []]]);
  await assert.rejects(controller.updateQueued('pane-a', 7, '新內容'), /已送出或移除/);
  assert.deepEqual(controller.queues.get('pane-a'), []);
  assert.equal(updates.length, 0);
});

test('無附件時不可把待送訊息清空，驗證失敗後保留原文', async () => {
  const item = { id: 1, text: '原文', attachments: [] };
  const { controller, updates } = setup([['pane-a', [item]]]);
  await assert.rejects(controller.updateQueued('pane-a', 1, ' \n '), /請輸入訊息/);
  assert.equal(item.text, '原文');
  assert.equal(updates.length, 0);
});

test('允許只保留附件，且只修改指定窗格的訊息', async () => {
  const a = { id: 1, text: '原文 A', attachments: ['/tmp/report.md'] };
  const b = { id: 1, text: '原文 B', attachments: [] };
  const { controller } = setup([['pane-a', [a]], ['pane-b', [b]]]);
  await controller.updateQueued('pane-a', 1, '');
  assert.equal(a.text, '');
  assert.deepEqual(a.attachments, ['/tmp/report.md']);
  assert.equal(b.text, '原文 B');
});
