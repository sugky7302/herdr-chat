import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseSkillMetadata, scanSkills, skillDirectories } from '../src/skills/discovery.ts';

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-skills-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const write = async (relative: string, text = '---\ndescription: A local skill\n---\nInstructions.') => {
    const file = path.join(base, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  return { base, write };
}

test('skill metadata supports BOM, CRLF, quoted names and scalar comments', () => {
  const metadata = parseSkillMetadata('\uFEFF---\r\nname: "release-check" # human note\r\ndescription: \'Check the team\'\'s "release" #1\'\r\n---\r\nDo not read this body as metadata.', 'folder');
  assert.equal(metadata.name, 'release-check');
  assert.equal(metadata.invocationName, 'release-check');
  assert.equal(metadata.description, 'Check the team\'s "release" #1');
  assert.equal(metadata.incomplete, false);
});

test('skill descriptions support block scalars and multiline quoted or plain strings', () => {
  for (const description of [
    '>\n  Review changes\n  and run tests.',
    '|-\n  Review changes\n  and run tests.',
    '"Review changes\n  and run tests."',
    'Review changes\n  and run tests.',
  ]) {
    assert.equal(parseSkillMetadata(`---\nname: review\ndescription: ${description}\n---\n`, 'folder').description, 'Review changes and run tests.');
  }
  const metadata = parseSkillMetadata('---\nname: deploy\ndescription: "Check \\"production\\" safely"\nuser-invocable: false\n---\n', 'folder');
  assert.equal(metadata.description, 'Check "production" safely');
  assert.equal(metadata.userInvocable, false);
});

test('metadata parsing never evaluates tags or aliases and caps display strings', () => {
  const metadata = parseSkillMetadata(`---\nname: !command exec\ndescription: ${'a'.repeat(700)}\n---\nname: from-body\n`, 'fallback');
  assert.equal(metadata.name, 'fallback');
  assert.equal(metadata.description.length, 500);
  assert.equal(parseSkillMetadata('---\nname: "unsafe /command"\n---', 'fallback').invocationName, undefined);
  assert.equal(parseSkillMetadata(`---\nname: ${'a'.repeat(129)}\n---`, 'fallback').invocationName, undefined);
  assert.equal(parseSkillMetadata('---\nname: unfinished', 'fallback').incomplete, true);
  assert.equal(parseSkillMetadata('Instructions only\nname: not-metadata', 'fallback').name, 'fallback');
});

test('standard roots honor config directory overrides and verified Antigravity locations without scanning ancestors', () => {
  const home = path.resolve('/users/tester');
  const root = path.resolve('/repos/app/worktree');
  const codexHome = path.join(home, 'codex-config');
  const claudeHome = path.join(home, 'claude-config');
  const roots = skillDirectories(root, { homeDir: home, env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } });
  assert.ok(roots.some((entry) => entry.agent === 'claude' && entry.scope === 'project' && entry.path === path.join(root, '.claude', 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'codex' && entry.path === path.join(codexHome, 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'claude' && entry.scope === 'user' && entry.path === path.join(claudeHome, 'skills')));
  assert.ok(!roots.some((entry) => entry.agent === 'claude' && entry.scope === 'user' && entry.path === path.join(home, '.claude', 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'codex' && entry.path === path.join(home, '.agents', 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'codex' && entry.scope === 'system' && entry.path === path.resolve('/etc/codex/skills')));
  assert.ok(roots.some((entry) => entry.agent === 'agy' && entry.path === path.join(home, '.gemini', 'config', 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'agy' && entry.path === path.join(home, '.gemini', 'antigravity-cli', 'skills')));
  assert.ok(roots.some((entry) => entry.agent === 'agy' && entry.path === path.join(home, '.gemini', 'skills')));
  assert.ok(!roots.some((entry) => entry.agent === 'agy' && entry.path === path.join(home, '.agents', 'skills')));
  assert.ok(!roots.some((entry) => entry.path === path.join(path.dirname(root), '.agents', 'skills')));
  assert.ok(skillDirectories(undefined, { homeDir: home, env: {} }).every((entry) => entry.scope !== 'project'));
});

test('discovery reports root existence, correct native invocation and canonical identities', async (t) => {
  const f = await fixture(t);
  const project = path.join(f.base, 'project');
  const claudeFile = await f.write('project/.claude/skills/folder/SKILL.md', '---\nname: custom-review\ndescription: Review this project\n---\n');
  const sharedFile = await f.write('project/.agents/skills/shared/SKILL.md', '---\nname: shared-check\ndescription: Shared standard skill\n---\n');
  await fs.mkdir(path.join(f.base, 'user-skills'), { recursive: true });
  await fs.symlink(path.dirname(sharedFile), path.join(f.base, 'user-skills', 'shared-alias'), 'dir');
  await fs.symlink(path.dirname(sharedFile), path.join(project, '.agents', 'skills', 'second-alias'), 'dir');
  await fs.symlink(path.join(f.base, 'missing-target'), path.join(f.base, 'user-skills', 'broken'), 'dir');
  await f.write('project/.agents/skills/nested/deeper/SKILL.md');
  await fs.mkdir(path.join(project, '.agents', 'skills', 'not-a-file', 'SKILL.md'), { recursive: true });
  const roots = [
    { path: path.join(project, '.claude', 'skills'), agent: 'claude', scope: 'project' as const },
    { path: path.join(project, '.agents', 'skills'), agent: 'codex', scope: 'project' as const },
    { path: path.join(project, '.agents', 'skills'), agent: 'agy', scope: 'project' as const },
    { path: path.join(f.base, 'user-skills'), agent: 'codex', scope: 'user' as const },
    { path: path.join(f.base, 'absent'), agent: 'claude', scope: 'user' as const },
  ];
  const result = await scanSkills(project, { roots });
  assert.equal(result.skillError, undefined);
  assert.equal(result.skills.length, 3, 'canonical aliases collapse per agent, not across runtimes');
  assert.equal(result.skills.find((skill) => skill.agent === 'claude')?.invocation, '/custom-review');
  assert.equal(result.skills.find((skill) => skill.agent === 'claude')?.path, await fs.realpath(claudeFile));
  assert.equal(result.skills.find((skill) => skill.agent === 'codex')?.invocation, '$shared-check');
  assert.equal(result.skills.find((skill) => skill.agent === 'codex')?.scope, 'project');
  assert.equal(result.skills.find((skill) => skill.agent === 'agy')?.invocation, '/shared-check');
  assert.deepEqual(result.skillRoots.map((entry) => entry.exists), [true, true, true, true, false]);
  assert.deepEqual((await scanSkills(project, { roots })).skills, result.skills, 'IDs remain stable across refreshes');
  assert.ok(roots.every((entry) => !Object.hasOwn(entry, 'exists')), 'caller sources are not mutated');
});

test('bounded metadata reads keep long instruction bodies out of inventory and reject incomplete headers for invocation', async (t) => {
  const f = await fixture(t);
  await f.write('skills/short-header/SKILL.md', `---\nname: concise\ndescription: Small metadata\n---\n${'body '.repeat(10000)}`);
  await f.write('skills/large-header/SKILL.md', `---\nname: enormous\ndescription: ${'a'.repeat(2000)}\n---\n`);
  const result = await scanSkills(undefined, {
    roots: [{ path: path.join(f.base, 'skills'), agent: 'claude', scope: 'user' }], maxFileBytes: 256,
  });
  assert.equal(result.skills.find((skill) => skill.name === 'concise')?.description, 'Small metadata');
  assert.equal(result.skills.find((skill) => skill.name === 'concise')?.invocation, '/concise');
  assert.equal(result.skills.find((skill) => skill.name === 'large-header')?.invocation, '');
  assert.match(result.skillError ?? '', /metadata.*limit/);
  assert.ok(!JSON.stringify(result).includes('body body'));
});

test('directory and result budgets report an incomplete inventory instead of scanning without bounds', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.write(`skills/skill-${i}/SKILL.md`);
  const roots = [{ path: path.join(f.base, 'skills'), agent: 'codex', scope: 'user' as const }];
  const directories = await scanSkills(undefined, { roots, maxDirectories: 2 });
  assert.equal(directories.skills.length, 2);
  assert.match(directories.skillError ?? '', /limit/);
  const skills = await scanSkills(undefined, { roots, maxSkills: 1 });
  assert.equal(skills.skills.length, 1);
  assert.match(skills.skillError ?? '', /limit/);
});

test('automatic-only Claude skills remain inspectable without a manual invocation', async (t) => {
  const f = await fixture(t);
  await f.write('skills/automatic/SKILL.md', '---\nname: automatic\nuser-invocable: false\ndescription: Runs when relevant\n---\n');
  await f.write('skills/manual/SKILL.md', '---\nname: manual\ndisable-model-invocation: true\ndescription: Runs on request\n---\n');
  const result = await scanSkills(undefined, { roots: [{ path: path.join(f.base, 'skills'), agent: 'claude', scope: 'user' }] });
  assert.equal(result.skills.find((skill) => skill.name === 'automatic')?.invocation, '');
  assert.equal(result.skills.find((skill) => skill.name === 'manual')?.invocation, '/manual');
  assert.equal(result.skills.find((skill) => skill.name === 'automatic')?.disabled, true);
  assert.equal(result.skills.find((skill) => skill.name === 'manual')?.disabled, undefined);
});

// Bundle the JSON-backed command catalog just as the extension does, without loading VS Code.
const commandBundle = await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['src/commands.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
});
const { Commands } = await import(`data:text/javascript;base64,${Buffer.from(commandBundle.outputFiles[0].text).toString('base64')}`);

test('command completion inserts native Codex skills and retains legacy prompts and extra slash commands', async (t) => {
  const f = await fixture(t);
  await f.write('project/.agents/skills/review/SKILL.md', '---\nname: local-review\ndescription: Review local changes\n---\n');
  await f.write('home/codex/prompts/team/release.md', '---\ndescription: Prepare a release\n---\n');
  const root = path.join(f.base, 'project');
  const commands = new Commands({ get: (_key: string, fallback: unknown) => fallback }, {
    homeDir: path.join(f.base, 'home'), env: { CODEX_HOME: path.join(f.base, 'home', 'codex') },
    roots: [{ path: path.join(root, '.agents', 'skills'), agent: 'codex', scope: 'project' }],
  });
  assert.deepEqual(await commands.list('codex', root, [], 'local-review'), [{
    label: '$local-review', description: 'Review local changes', insert: '$local-review ', kind: 'command',
  }]);
  assert.equal((await commands.list('codex', root, [], 'prompts:team:release'))[0]?.insert, '/prompts:team:release ');
  assert.equal((await commands.list('codex', root, ['custom-helper'], 'custom-helper'))[0]?.insert, '/custom-helper ');
  await f.write('project/.agents/skills/new/SKILL.md', '---\nname: new-skill\ndescription: Newly installed\n---\n');
  assert.equal((await commands.list('codex', root, [], 'new-skill')).length, 0);
  commands.clearDiskCache();
  assert.equal((await commands.list('codex', root, [], 'new-skill'))[0]?.insert, '$new-skill ');
});

test('Claude completion respects frontmatter names and hides automatic-only skills while retaining markdown commands', async (t) => {
  const f = await fixture(t);
  await f.write('project/.claude/skills/folder/SKILL.md', '---\nname: real-skill\ndescription: Selected by its declared name\n---\n');
  await f.write('project/.claude/skills/automatic/SKILL.md', '---\nname: automatic-only\nuser-invocable: false\n---\n');
  await f.write('project/.claude/commands/team/release.md', '---\r\ndescription: "Release the project"\r\n---\r\n');
  await f.write('home/claude-custom/commands/global-review.md', '---\ndescription: User command in an alternate config directory\n---\n');
  const root = path.join(f.base, 'project');
  const commands = new Commands({ get: (_key: string, fallback: unknown) => fallback }, {
    homeDir: path.join(f.base, 'home'), env: { CLAUDE_CONFIG_DIR: path.join(f.base, 'home', 'claude-custom') },
    roots: [{ path: path.join(root, '.claude', 'skills'), agent: 'claude', scope: 'project' }],
  });
  assert.equal((await commands.list('claude', root, [], 'real-skill'))[0]?.insert, '/real-skill ');
  assert.equal((await commands.list('claude', root, [], 'automatic-only')).length, 0);
  assert.equal((await commands.list('claude', root, [], 'team:release'))[0]?.description, 'Release the project');
  assert.equal((await commands.list('claude', root, [], 'global-review'))[0]?.insert, '/global-review ');
});

test('DeepSeek completion uses the shared scanner for its project and user skill directories', async (t) => {
  const f = await fixture(t);
  await f.write('project/.github/skills/review/SKILL.md', '---\nname: project-review\ndescription: GitHub project skill\n---\n');
  await f.write('project/.agents/skills/check/SKILL.md', '---\nname: project-check\ndescription: Agents project skill\n---\n');
  await f.write('home/.agents/skills/shared/SKILL.md', '---\nname: user-check\ndescription: User skill\n---\n');
  for (const kind of ['dsh', 'dsh-tui']) {
    const commands = new Commands({ get: (_key: string, fallback: unknown) => fallback }, { homeDir: path.join(f.base, 'home'), env: {} });
    for (const name of ['project-review', 'project-check', 'user-check']) {
      assert.equal((await commands.list(kind, path.join(f.base, 'project'), [], name))[0]?.insert, `/${name} `);
    }
  }
});
