import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, entryPoints: ['src/extension.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'locale-activation-host',
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'locale-host' }));
      builder.onResolve({ filter: /^\.\/controller$/ }, (args) => args.importer.endsWith('/src/extension.ts') ? { path: 'controller', namespace: 'locale-host' } : undefined);
      builder.onResolve({ filter: /^\.\/claudeUsage$/ }, (args) => args.importer.endsWith('/src/extension.ts') ? { path: 'usage', namespace: 'locale-host' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'locale-host' }, (args) => {
        const common = 'const state = () => globalThis.__herdrLocaleHost;';
        if (args.path === 'controller') return { loader: 'ts', resolveDir: root, contents: `
          import {getLocale} from './src/l10n.ts';
          ${common}
          export class Controller {
            constructor() { state().constructedLocale = getLocale(); }
            dispose() {
              const host = state();
              host.disposeCalls = (host.disposeCalls ?? 0) + 1;
              return host.disposePromise;
            }
            async refresh() {}
          }
          export function describe(error) { return String(error); }
        ` };
        if (args.path === 'usage') return { loader: 'js', contents: 'export async function install() { throw new Error("Unexpected settings write"); } export async function uninstall() { throw new Error("Unexpected settings write"); }' };
        return { loader: 'js', contents: `
          ${common}
          const disposable = () => ({dispose() {}});
          export const env = {get language() {return state().language;}};
          export const workspace = {workspaceFolders: []};
          export const Uri = {joinPath(base, ...parts) {const fsPath = [base.fsPath, ...parts].join('/'); return {fsPath, toString() {return fsPath;}};}};
          export const window = {
            registerWebviewViewProvider(id, provider) {state().provider = provider; return disposable();},
            async showInformationMessage(...args) {state().notices.push(args); return undefined;}
          };
          export const commands = {
            registerCommand(id, handler) {state().commands[id] = handler; return disposable();},
            async executeCommand(id) {state().focusedCommands.push(id);}
          };
        ` };
      });
    },
  }],
});
const { activate, deactivate } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('activation reads vscode.env.language before controller setup and passes that locale to the webview', async () => {
  const globals = globalThis as typeof globalThis & { __herdrLocaleHost?: any };
  try {
    for (const language of ['en', 'zh-tw', 'zh-Hant-HK', 'ja']) {
      const state: any = { language, notices: [], commands: {}, focusedCommands: [], posted: [] };
      globals.__herdrLocaleHost = state;
      const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
      const context = {
        storageUri: uri('/test/workspace-storage'), globalStorageUri: uri('/test/global-storage'), extensionUri: uri('/test/extension'),
        workspaceState: {}, globalState: {}, subscriptions: [],
      };
      activate(context);
      // A palette command must survive opening a webview that has not sent ready yet.
      await state.commands['herdr.settings']();
      const webview: any = {
        cspSource: 'vscode-test:', asWebviewUri: (value: any) => value.toString(),
        onDidReceiveMessage(handler: any) { state.receive = handler; },
        postMessage(message: any) { state.posted.push(message); },
      };
      state.provider.resolveWebviewView({ webview, onDidDispose() {} });
      assert.deepEqual(state.focusedCommands, ['herdr.chat.focus']);
      assert.equal(state.posted.length, 0);
      state.receive({ type: 'ready' });
      assert.deepEqual(state.posted[0], { type: 'navigate', view: 'settings' });
      const traditional = language.startsWith('zh');
      assert.equal(state.constructedLocale, traditional ? 'zh-tw' : 'en');
      assert.match(webview.html, new RegExp(`<html lang="${traditional ? 'zh-TW' : 'en'}">`));
      assert.match(webview.html, /Content-Security-Policy/);
      assert.match(webview.html, /webview\.js/);
      await state.commands['herdr.enableClaudeUsage']();
      const [question, options, action] = state.notices[0];
      if (traditional) {
        assert.match(question, /啟用 Claude/); assert.match(action, /啟用/);
      } else {
        assert.doesNotMatch(`${question} ${options.detail} ${action}`, /\p{Script=Han}/u);
        assert.match(question, /Claude/);
      }
      for (const subscription of context.subscriptions as { dispose(): void }[]) subscription.dispose();
      await deactivate();
    }
  } finally { delete globals.__herdrLocaleHost; }
});

for (const subscriptionsFirst of [false, true]) {
  test(`deactivate 等待協作關閉，並且只清理一次（subscriptionsFirst=${subscriptionsFirst}）`, async () => {
    const globals = globalThis as typeof globalThis & { __herdrLocaleHost?: any };
    let finish!: () => void;
    const state: any = {
      language: 'zh-tw', notices: [], commands: {}, focusedCommands: [], posted: [],
      disposePromise: new Promise<void>((resolve) => { finish = resolve; }),
    };
    const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
    const context = {
      storageUri: uri('/test/workspace-storage'), globalStorageUri: uri('/test/global-storage'), extensionUri: uri('/test/extension'),
      workspaceState: {}, globalState: {}, subscriptions: [] as { dispose(): void }[],
    };
    try {
      globals.__herdrLocaleHost = state;
      activate(context);
      if (subscriptionsFirst) for (const subscription of context.subscriptions) subscription.dispose();
      let closed = false;
      const shutdown = deactivate();
      assert.ok(shutdown instanceof Promise);
      void shutdown.then(() => { closed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false, 'VS Code 必須等待協作釋放鎖');
      for (const subscription of context.subscriptions) subscription.dispose();
      assert.equal(state.disposeCalls, 1);
      finish();
      await shutdown;
      await deactivate();
      assert.equal(closed, true);
      assert.equal(state.disposeCalls, 1);
    } finally {
      finish();
      await deactivate();
      delete globals.__herdrLocaleHost;
    }
  });
}
