import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, entryPoints: ['src/controller.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'disposal-host',
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'disposal-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'disposal-host' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    },
  }],
});
const { Controller } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('Controller.dispose 停止更新，並等待協作清理完成；重複呼叫共用同一個 Promise', async (context) => {
  const controller = Object.create(Controller.prototype);
  const calls: string[] = [];
  let finish!: () => void;
  const collaborationClosed = new Promise<void>((resolve) => { finish = resolve; });
  controller.events = { dispose() { calls.push('events'); } };
  controller.collaboration = { dispose() { calls.push('collaboration'); return collaborationClosed; } };
  controller.disposables = [{ dispose() { calls.push('subscription'); } }];
  controller.refreshTimer = setTimeout(() => calls.push('refresh'), 0);
  controller.pollTimer = setInterval(() => calls.push('poll'), 0);
  context.after(() => {
    finish();
    clearTimeout(controller.refreshTimer);
    clearInterval(controller.pollTimer);
  });
  const shutdown = controller.dispose();
  assert.ok(shutdown instanceof Promise);
  assert.equal(controller.dispose(), shutdown);
  let closed = false;
  void shutdown.then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(calls, ['events', 'collaboration', 'subscription']);
  finish();
  await shutdown;
  assert.equal(closed, true);
  assert.equal(controller.dispose(), shutdown);
  assert.deepEqual(calls, ['events', 'collaboration', 'subscription']);
});
