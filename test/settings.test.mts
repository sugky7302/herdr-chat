import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { AgentPreset } from '../src/presets.ts';
import type { SettingsHost } from '../src/settings/service.ts';
import type { SettingsScope, SkillInfo, SkillRoot } from '../src/settings/types.ts';

// Exercise the real service with an injectable host, without VS Code, a native
// Herdr server, network requests, or installing anything on the test machine.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/settings/service.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
});
const { SettingsService, validatePresets, parseIntegrations } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
) as typeof import('../src/settings/service.ts');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function preset(id = 'claude'): AgentPreset {
  return { id, label: id === 'claude' ? 'Claude' : 'Codex', kind: id, models: [], efforts: [] };
}

interface RawIntegration { target: string; available: boolean; state: string }
interface ApiCall { method: string; params: object }
interface ConfigurationWrite { scope: SettingsScope; workspaceKey: string; value: AgentPreset[] | undefined }

function fixture() {
  const defaults = [preset()];
  const state = {
    workspaceKey: 'workspace:/repo/a', workspaceRoot: '/repo/a', workspaceAvailable: true,
    trusted: true, socketPath: '/test/herdr.sock', externalVersion: 0,
    userPresets: structuredClone(defaults),
    workspacePresets: undefined as AgentPreset[] | undefined,
    projectDefaults: {} as Record<string, { model?: string; effort?: string }>,
    integrations: [{ target: 'claude', available: true, state: 'not_installed' }] as RawIntegration[],
    skills: [] as SkillInfo[], skillRoots: [] as SkillRoot[],
  };
  const calls: ApiCall[] = [];
  const writes: ConfigurationWrite[] = [];
  const scanRoots: (string | undefined)[] = [];
  const hooks: {
    write?: (write: ConfigurationWrite) => Promise<void>;
    list?: () => Promise<unknown>;
    mutate?: (method: string, target: string) => Promise<unknown>;
    scan?: () => Promise<{ skills: SkillInfo[]; skillRoots: SkillRoot[]; skillError?: string }>;
  } = {};
  const host: SettingsHost = {
    read(scope) {
      const workspaceKey = state.workspaceKey;
      return {
        scope, workspaceKey, workspaceRoot: state.workspaceRoot,
        workspaceAvailable: state.workspaceAvailable, workspaceLabel: state.workspaceRoot,
        inherited: scope === 'workspace' && state.workspacePresets === undefined,
        presets: structuredClone(scope === 'workspace' ? state.workspacePresets ?? state.userPresets : state.userPresets),
        projectDefaults: structuredClone(state.projectDefaults),
        revisionData: structuredClone({ user: state.userPresets, workspace: state.workspacePresets, external: state.externalVersion }),
        diagnostics: {
          connected: true, socketPath: state.socketPath, nodePath: 'node',
          claudeMemUrl: 'http://127.0.0.1:37777', trusted: state.trusted,
        },
        async write(value) {
          const write = { scope, workspaceKey, value: structuredClone(value) };
          writes.push(write);
          await hooks.write?.(write);
          if (scope === 'workspace') state.workspacePresets = structuredClone(value);
          else state.userPresets = structuredClone(value ?? defaults);
        },
      };
    },
    async request(method, params = {}) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'integration.list') return hooks.list ? hooks.list() : { integrations: structuredClone(state.integrations) };
      if (method === 'integration.install' || method === 'integration.uninstall') {
        const target = (params as { target: string }).target;
        if (hooks.mutate) return hooks.mutate(method, target);
        state.integrations.find((item) => item.target === target)!.state = method === 'integration.install' ? 'current' : 'not_installed';
        return { target, details: { messages: [`${method}: ${target}`] } };
      }
      throw new Error(`Unexpected API method: ${method}`);
    },
    async scanSkills(root) {
      scanRoots.push(root);
      return hooks.scan ? hooks.scan() : { skills: structuredClone(state.skills), skillRoots: structuredClone(state.skillRoots) };
    },
  };
  return { service: new SettingsService(host), state, hooks, calls, writes, scanRoots };
}

test('settings saves are bound to their user or workspace scope and reset removes only that override', async () => {
  const f = fixture();
  const user = await f.service.load('user');
  const workspace = await f.service.load('workspace');
  assert.notEqual(user.revision, workspace.revision);
  assert.equal(workspace.inherited, true);
  await assert.rejects(f.service.save('workspace', user.revision, [preset('codex')]), /changed/);
  assert.equal(f.writes.length, 0);

  const saved = await f.service.save('workspace', workspace.revision, [preset('codex')]);
  assert.equal(saved.inherited, false);
  assert.equal(saved.presets[0].kind, 'codex');
  assert.equal(f.state.userPresets[0].kind, 'claude');
  assert.equal(f.writes[0].scope, 'workspace');
  const reset = await f.service.reset('workspace', saved.revision);
  assert.equal(reset.inherited, true);
  assert.equal(reset.presets[0].kind, 'claude');
  assert.equal(f.writes[1].value, undefined);

  const currentUser = await f.service.load('user');
  await f.service.save('user', currentUser.revision, [preset('codex')]);
  assert.equal(f.writes[2].scope, 'user');
  assert.equal(f.state.workspacePresets, undefined);
});

test('external config edits, project defaults, or a worktree switch invalidate a displayed draft', async (t) => {
  for (const change of ['config', 'project defaults', 'workspace'] as const) await t.test(change, async () => {
    const f = fixture();
    const snapshot = await f.service.load('workspace');
    if (change === 'config') f.state.externalVersion++;
    if (change === 'project defaults') f.state.projectDefaults.claude = { model: 'sonnet' };
    if (change === 'workspace') { f.state.workspaceKey = 'workspace:/repo/b'; f.state.workspaceRoot = '/repo/b'; }
    await assert.rejects(f.service.save('workspace', snapshot.revision, [preset('codex')]), /changed/);
    assert.deepEqual(f.writes, []);
  });
});

test('workspace writes require a workspace and unknown scopes never reach configuration writes', async () => {
  const f = fixture();
  f.state.workspaceAvailable = false;
  const snapshot = await f.service.load('workspace');
  await assert.rejects(f.service.save('workspace', snapshot.revision, []), /Open a workspace/);
  await assert.rejects(f.service.load('global' as SettingsScope), /Unknown settings scope/);
  await assert.rejects(f.service.reset('global' as SettingsScope, snapshot.revision), /Unknown settings scope/);
  assert.deepEqual(f.writes, []);
  const user = await f.service.load('user');
  await f.service.save('user', user.revision, []);
  assert.deepEqual(f.state.userPresets, [], 'an intentionally empty agent menu is a valid user setting');
});

test('overlapping saves cannot overwrite one another, and a failed write does not leave the editor locked', async () => {
  const f = fixture();
  const snapshot = await f.service.load('user');
  const started = deferred();
  const release = deferred();
  f.hooks.write = async () => { started.resolve(); await release.promise; };
  const pending = f.service.save('user', snapshot.revision, [preset('codex')]);
  await started.promise;
  await assert.rejects(f.service.save('user', snapshot.revision, []), /save is in progress/);
  await assert.rejects(f.service.reset('user', snapshot.revision), /save is in progress/);
  assert.equal(f.writes.length, 1);
  release.resolve();
  const saved = await pending;

  f.hooks.write = async () => { throw new Error('configuration write refused'); };
  await assert.rejects(f.service.save('user', saved.revision, []), /write refused/);
  f.hooks.write = undefined;
  await f.service.save('user', saved.revision, []);
  assert.deepEqual(f.state.userPresets, []);
});

test('advanced presets survive validation and saves without sharing mutable input objects', async () => {
  const f = fixture();
  const draft = [{
    ...preset(), enabled: false, models: ['sonnet'], defaultModel: 'sonnet',
    modelArgs: ['--model', '{model}'], slashCommands: ['/custom'],
    providerExtension: { endpoint: 'http://localhost:1234', flags: ['retain-me'] },
  }];
  const validated = validatePresets(draft) as typeof draft;
  assert.deepEqual(validated, draft);
  validated[0].providerExtension.flags.push('changed');
  assert.deepEqual(draft[0].providerExtension.flags, ['retain-me']);
  const snapshot = await f.service.load('user');
  const saved = await f.service.save('user', snapshot.revision, draft);
  assert.deepEqual(saved.presets, draft);
  draft[0].models.push('later-edit');
  assert.deepEqual(saved.presets[0].models, ['sonnet']);
  assert.deepEqual(f.state.userPresets[0].models, ['sonnet']);
});

test('invalid replacement arrays are rejected before any settings can be lost', async () => {
  const f = fixture();
  const snapshot = await f.service.load('user');
  const invalid: unknown[] = [
    null, {}, [null], [preset(), preset()], [{ ...preset(), id: '__shell__' }],
    [{ ...preset(), label: ' ' }], [{ id: 'missing', label: 'No launch configuration' }],
    [{ ...preset(), command: 'claude' }], [{ ...preset(), kind: 'claude; arbitrary-command' }],
    [{ ...preset(), enabled: 'true' }], [{ ...preset(), models: ['sonnet', 1] }],
    [{ ...preset(), args: ['--model', 'a\0b'] }], [{ ...preset(), switchStyle: 'shell' }],
    [{ ...preset(), models: ['sonnet'], defaultModel: 'unlisted' }],
    [{ ...preset(), efforts: ['low'], defaultEffort: 'high' }],
    Array.from({ length: 101 }, (_, i) => ({ ...preset(), id: `agent${i}` })),
  ];
  for (const raw of invalid) await assert.rejects(f.service.save('user', snapshot.revision, raw));
  assert.deepEqual(f.writes, []);
  assert.equal(f.state.userPresets[0].kind, 'claude');
  assert.deepEqual(validatePresets([{ id: 'custom', label: 'Custom', command: '/opt/my-agent --interactive' }]),
    [{ id: 'custom', label: 'Custom', command: '/opt/my-agent --interactive' }]);
});

test('settings still load when an older server lacks integrations or skill discovery fails', async () => {
  const f = fixture();
  f.hooks.list = async () => { throw new Error('unknown method integration.list'); };
  f.hooks.scan = async () => { throw new Error('skill directory unavailable'); };
  const snapshot = await f.service.load('workspace');
  assert.equal(snapshot.presets[0].kind, 'claude');
  assert.ok(snapshot.catalog.some((item) => item.kind === 'codex'));
  assert.match(snapshot.integrationError!, /unknown method/);
  assert.match(snapshot.skillError!, /directory unavailable/);
  assert.deepEqual(snapshot.integrations, []);
  assert.deepEqual(snapshot.skills, []);
  assert.deepEqual(f.scanRoots, ['/repo/a']);
});

test('native integration states and target names are parsed without pretending an executable was detected', () => {
  const result = parseIntegrations({ integrations: [
    { target: 'claude', available: true, state: 'not_installed' },
    { target: 'codex', available: false, state: 'outdated' },
    { target: 'antigravity_cli', available: true, state: 'current' },
    { target: 'pi', available: true, state: 'future-state' },
    { target: 'claude', available: true, state: 'current' },
    { target: 'antigravity-cli', available: true, state: 'current' },
    { target: 'letta', available: true, state: 'current' },
    { target: 'arbitrary-shell-command', state: 'current' }, null,
  ] });
  assert.deepEqual(result.map((entry) => [entry.target, entry.installed, entry.supported, entry.status]), [
    ['claude', false, true, 'not_installed'], ['codex', true, true, 'outdated'],
    ['antigravity_cli', true, true, 'current'], ['pi', false, false, 'unknown'],
  ]);
  assert.ok(result[1].detail);
  assert.equal(result[1].cliAvailable, undefined, 'recommendation flags cannot prove a CLI executable is installed');
  for (const raw of [undefined, [], {}, { integrations: {} }]) assert.throws(() => parseIntegrations(raw), /invalid integration list/);
});

test('unknown, CLI-only, invalid-action, and untrusted integration requests never reach a mutation API', async () => {
  const f = fixture();
  for (const target of ['letta', 'antigravity-cli', 'claude; rm -rf /', '../claude']) {
    await assert.rejects(f.service.runIntegration('user', target, 'install'), /Unsupported/);
  }
  await assert.rejects(f.service.runIntegration('user', 'claude', 'download' as 'install'), /Unsupported/);
  f.state.trusted = false;
  await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /Trust this workspace/);
  assert.deepEqual(f.calls, []);
});

test('a target must be supported by the connected server before it can be mutated', async () => {
  const f = fixture();
  await assert.rejects(f.service.runIntegration('user', 'codex', 'install'), /does not expose/);
  f.state.integrations[0].state = 'future-state';
  await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /does not expose/);
  assert.ok(f.calls.every((call) => call.method === 'integration.list'));
});

test('revoking trust or changing the socket during discovery prevents the pending integration mutation', async (t) => {
  for (const change of ['trust', 'socket'] as const) await t.test(change, async () => {
    const f = fixture();
    const discovery = deferred<unknown>();
    f.hooks.list = () => discovery.promise;
    const pending = f.service.runIntegration('user', 'claude', 'install');
    if (change === 'trust') f.state.trusted = false;
    else f.state.socketPath = '/test/different-server.sock';
    discovery.resolve({ integrations: f.state.integrations });
    await assert.rejects(pending, change === 'trust' ? /Trust this workspace/ : /connection changed/);
    assert.deepEqual(f.calls.map((call) => call.method), ['integration.list']);
  });
});

test('install and uninstall success requires a fresh server state after the real native API action', async () => {
  const f = fixture();
  const installed = await f.service.runIntegration('workspace', 'claude', 'install');
  assert.deepEqual(f.calls.map((call) => call.method), ['integration.list', 'integration.install', 'integration.list']);
  assert.deepEqual(f.calls[1].params, { target: 'claude' });
  assert.equal(installed.snapshot.integrations[0].status, 'current');
  assert.equal(installed.output, 'integration.install: claude');
  const removed = await f.service.runIntegration('workspace', 'claude', 'uninstall');
  assert.equal(removed.snapshot.integrations[0].installed, false);
  assert.equal(removed.snapshot.integrations[0].status, 'not_installed');
  assert.equal(removed.output, 'integration.uninstall: claude');
});

test('successful command acknowledgement alone is insufficient when resulting state cannot be verified', async (t) => {
  for (const outcome of ['unchanged', 'outdated', 'discovery failure'] as const) await t.test(outcome, async () => {
    const f = fixture();
    f.hooks.mutate = async (_method, target) => {
      if (outcome === 'outdated') f.state.integrations[0].state = 'outdated';
      if (outcome === 'discovery failure') f.hooks.list = async () => { throw new Error('server went away'); };
      return { target, details: { messages: ['installed hook file'] } };
    };
    await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /could not be verified/);
    assert.equal(f.calls.filter((call) => call.method === 'integration.install').length, 1);
  });
});

test('switching servers during installation or its verification cannot report success for a different server', async (t) => {
  for (const phase of ['mutation', 'verification'] as const) await t.test(phase, async () => {
    const f = fixture();
    let listings = 0;
    f.hooks.list = async () => {
      if (++listings > 1 && phase === 'verification') f.state.socketPath = '/test/different-server.sock';
      return { integrations: structuredClone(f.state.integrations) };
    };
    f.hooks.mutate = async (_method, target) => {
      if (phase === 'mutation') f.state.socketPath = '/test/different-server.sock';
      f.state.integrations[0].state = 'current';
      return { target, details: { messages: ['operation finished on original server'] } };
    };
    await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /connection changed|could not be verified/);
  });
});

test('API failures and malformed acknowledgements are not reported as success, and retries remain possible', async () => {
  const f = fixture();
  f.hooks.mutate = async () => { throw new Error('integration_install_failed: CLI config missing'); };
  await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /CLI config missing/);
  for (const response of [
    { target: 'codex', details: { messages: ['wrong target'] } },
    { target: 'claude', details: { messages: [123] } },
    { target: 'claude', messages: ['wrong shape'] },
  ]) {
    f.hooks.mutate = async () => response;
    await assert.rejects(f.service.runIntegration('user', 'claude', 'install'), /unexpected result/);
  }
  f.hooks.mutate = undefined;
  const retry = await f.service.runIntegration('user', 'claude', 'install');
  assert.equal(retry.snapshot.integrations[0].status, 'current');
});

test('only one integration mutation can be active at a time', async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  f.hooks.mutate = async (_method, target) => {
    started.resolve();
    await release.promise;
    f.state.integrations[0].state = 'current';
    return { target, details: { messages: ['done'] } };
  };
  const pending = f.service.runIntegration('user', 'claude', 'install');
  await started.promise;
  await assert.rejects(f.service.runIntegration('user', 'claude', 'uninstall'), /operation is in progress/);
  assert.equal(f.calls.filter((call) => call.method !== 'integration.list').length, 1);
  release.resolve();
  await pending;
});

test('documentation opening resolves host-known IDs instead of accepting arbitrary URLs', () => {
  const f = fixture();
  assert.equal(f.service.docsUrl('claude'), 'https://code.claude.com/docs/en/setup');
  assert.equal(f.service.docsUrl('herdr-skill'), 'https://herdr.dev/tui/docs/agent-skill/');
  for (const id of ['https://example.com/collect', 'javascript:alert(1)', 'file:///etc/passwd', '__proto__']) {
    assert.throws(() => f.service.docsUrl(id), /could not be found/);
  }
  assert.deepEqual(f.calls, []);
});

test('skill opening requires a discovered ID and rejects a file redirected by a symlink after discovery', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-settings-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  const skillFile = path.join(root, 'SKILL.md');
  const otherFile = path.join(root, 'other.md');
  await fs.writeFile(skillFile, '# Existing skill');
  await fs.writeFile(otherFile, '# Different file');
  const f = fixture();
  f.state.skills = [{ id: 'discovered-skill', name: 'herdr', description: 'Pane control', path: skillFile,
    agent: 'claude', scope: 'project', invocation: '/herdr' }];
  await assert.rejects(f.service.skillPath('discovered-skill'), /Refresh the Skills list/);
  await f.service.load('workspace');
  assert.equal(await f.service.skillPath('discovered-skill'), skillFile);
  for (const arbitraryId of [skillFile, otherFile, '/etc/passwd', '../SKILL.md']) {
    await assert.rejects(f.service.skillPath(arbitraryId), /Refresh the Skills list/);
  }
  await fs.rename(skillFile, path.join(root, 'saved-SKILL.md'));
  await fs.symlink(otherFile, skillFile);
  await assert.rejects(f.service.skillPath('discovered-skill'), /file moved/);
});

test('VS Code Proxy configuration values can be loaded without structuredClone errors', async () => {
  const f = fixture();
  const proxiedPreset = new Proxy(preset('claude'), {});
  const proxiedDefaults = new Proxy({ claude: { model: 'sonnet' } }, {});
  const host: SettingsHost = {
    read(scope) {
      return {
        scope,
        workspaceKey: 'workspace:/repo/a',
        workspaceRoot: '/repo/a',
        workspaceAvailable: true,
        workspaceLabel: '/repo/a',
        inherited: false,
        presets: new Proxy([proxiedPreset], {}),
        projectDefaults: proxiedDefaults,
        revisionData: new Proxy({ globalValue: [proxiedPreset] }, {}),
        diagnostics: {
          connected: true,
          socketPath: '/test/herdr.sock',
          nodePath: 'node',
          claudeMemUrl: '',
          trusted: true,
        },
        async write() {},
      };
    },
    request: f.service['host'].request,
    scanSkills: f.service['host'].scanSkills,
  };
  const service = new SettingsService(host);
  const snapshot = await service.load('user');
  assert.equal(snapshot.presets[0].id, 'claude');
  assert.deepEqual(snapshot.projectDefaults, { claude: { model: 'sonnet' } });
});
