import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['src/settings/vscodeHost.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'settings-configuration-host', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'settings-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'settings-host' }, () => ({ loader: 'js', contents: `
      export const ConfigurationTarget = {Global: 1, Workspace: 2, WorkspaceFolder: 3};
      export const workspace = new Proxy({}, {get(_, key) {return globalThis.__herdrSettingsWorkspace[key];}});
    ` }));
  } }],
});
const { createSettingsHost } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
  const writes: any[] = [];
  const resource = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` });
  const first = resource('/project/a'), second = resource('/project/b');
  let selected = first;
  const preset = (id: string) => [{ id, label: id, kind: 'claude' }];
  const layers: Record<string, any> = {
    '/project/a': { key: 'herdr.agentPresets', defaultValue: preset('default'), globalValue: preset('user'), workspaceValue: preset('workspace') },
    '/project/b': { key: 'herdr.agentPresets', defaultValue: preset('default'), globalValue: preset('user'), workspaceValue: preset('workspace'), workspaceFolderValue: preset('folder-b') },
  };
  const workspace: any = {
    workspaceFile: resource('/projects.code-workspace'),
    workspaceFolders: [{ name: 'a', uri: first }, { name: 'b', uri: second }], isTrusted: true,
    getWorkspaceFolder(uri: any) { return this.workspaceFolders.find((folder: any) => folder.uri.fsPath === uri.fsPath); },
    getConfiguration(section: string, uri: any) {
      assert.equal(section, 'herdr');
      const capturedPath = uri?.fsPath;
      return {
        inspect: (key: string) => { assert.equal(key, 'agentPresets'); return layers[capturedPath]; },
        get: (key: string) => key === 'agentDefaults' ? { user: { model: 'project-model' } } : undefined,
        update: async (key: string, value: unknown, target: number) => { writes.push({ key, value, target, path: capturedPath }); },
      };
    },
  };
  const globals = globalThis as any;
  globals.__herdrSettingsWorkspace = workspace;
  const host = createSettingsHost({
    settingsWorkspace: () => ({ resource: selected, root: `${selected.fsPath}-checkout` }),
    currentState: () => ({ connected: false }), client: { socketPath: '/run/herdr.sock', request: async () => ({}) },
  });
  return { host, workspace, writes, layers, selectB: () => { selected = second; }, cleanup: () => { delete globals.__herdrSettingsWorkspace; } };
}

test('user settings edit the global value while displaying current project overrides', async () => {
  const f = fixture();
  try {
    f.selectB();
    const config = f.host.read('user');
    assert.equal(config.presets[0].id, 'user');
    assert.deepEqual(config.projectDefaults, { user: { model: 'project-model' } });
    assert.equal(config.workspaceRoot, '/project/b-checkout');
    await config.write([{ id: 'saved-user', label: 'User', kind: 'claude' }]);
    assert.equal(f.writes[0].target, 1);
    assert.equal(f.writes[0].key, 'agentPresets');
  } finally { f.cleanup(); }
});

test('multi-folder workspace inheritance and captured write target do not follow a UI selection change', async () => {
  const f = fixture();
  try {
    const config = f.host.read('workspace');
    assert.equal(config.presets[0].id, 'workspace');
    assert.equal(config.inherited, true);
    assert.equal(config.workspaceLabel, 'a');
    f.selectB();
    assert.equal(f.host.read('workspace').presets[0].id, 'folder-b');
    assert.notEqual(config.workspaceKey, f.host.read('workspace').workspaceKey);
    await config.write(undefined);
    assert.deepEqual(f.writes, [{ key: 'agentPresets', value: undefined, target: 3, path: '/project/a' }]);
  } finally { f.cleanup(); }
});

test('single-folder workspace uses Workspace target and reports an unopened window correctly', async () => {
  const f = fixture();
  try {
    f.workspace.workspaceFolders = f.workspace.workspaceFolders.slice(0, 1);
    f.workspace.workspaceFile = undefined;
    await f.host.read('workspace').write([]);
    assert.equal(f.writes[0].target, 2);
    f.workspace.workspaceFolders = [];
    assert.equal(f.host.read('workspace').workspaceAvailable, false);
  } finally { f.cleanup(); }
});
