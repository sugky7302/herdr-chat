import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from '../l10n.ts';
import type { SkillInfo, SkillRoot } from '../settings/types.ts';

type SkillDirectory = Omit<SkillRoot, 'exists'>;

export interface SkillScanOptions {
  homeDir?: string;
  env?: { CODEX_HOME?: string; CLAUDE_CONFIG_DIR?: string };
  /** Limit discovery to these native agent kinds, e.g. when completing commands. */
  agents?: readonly string[];
  /** Override standard directories for callers with explicit sources and filesystem tests. */
  roots?: readonly SkillDirectory[];
  maxDirectories?: number;
  maxSkills?: number;
  maxFileBytes?: number;
}

export interface SkillInventory {
  skills: SkillInfo[];
  skillRoots: SkillRoot[];
  skillError?: string;
}

interface SkillMetadata {
  name: string;
  description: string;
  invocationName?: string;
  userInvocable: boolean;
  incomplete: boolean;
}

const DEFAULT_LIMITS = { directories: 1000, skills: 500, fileBytes: 64 * 1024 };
const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/**
 * Local inventory only: the selected worktree is the agent's start directory.
 * Native runtimes also have plugins, managed settings, extra directories and
 * enablement rules; discovering a file here does not establish that it is loaded.
 */
export function skillDirectories(workspaceRoot?: string, options: SkillScanOptions = {}): SkillDirectory[] {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const roots: SkillDirectory[] = options.roots ? [...options.roots] : [
    ...(workspaceRoot ? [
      { path: path.join(workspaceRoot, '.claude', 'skills'), agent: 'claude', scope: 'project' as const },
      { path: path.join(workspaceRoot, '.agents', 'skills'), agent: 'codex', scope: 'project' as const },
      { path: path.join(workspaceRoot, '.agents', 'skills'), agent: 'agy', scope: 'project' as const },
      { path: path.join(workspaceRoot, '.agent', 'skills'), agent: 'agy', scope: 'project' as const },
    ] : []),
    { path: path.join(claudeHome, 'skills'), agent: 'claude', scope: 'user' },
    { path: path.join(home, '.agents', 'skills'), agent: 'codex', scope: 'user' },
    // Still accepted by Codex for backward compatibility, including CODEX_HOME overrides.
    { path: path.join(codexHome, 'skills'), agent: 'codex', scope: 'user' },
    { path: '/etc/codex/skills', agent: 'codex', scope: 'system' },
    { path: path.join(home, '.gemini', 'config', 'skills'), agent: 'agy', scope: 'user' },
    { path: path.join(home, '.gemini', 'antigravity-cli', 'skills'), agent: 'agy', scope: 'user' },
    { path: path.join(home, '.gemini', 'skills'), agent: 'agy', scope: 'user' },
  ];
  const seen = new Set<string>();
  return roots.map((root) => ({ ...root, path: path.resolve(root.path) })).filter((root) => {
    if (options.agents && !options.agents.includes(root.agent)) return false;
    const key = `${root.agent}\0${root.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Read metadata without executing, copying, installing or altering any skill. */
export async function scanSkills(workspaceRoot?: string, options: SkillScanOptions = {}): Promise<SkillInventory> {
  const maxDirectories = limit(options.maxDirectories, DEFAULT_LIMITS.directories);
  const maxSkills = limit(options.maxSkills, DEFAULT_LIMITS.skills);
  const maxFileBytes = limit(options.maxFileBytes, DEFAULT_LIMITS.fileBytes);
  let unreadable = 0;
  const roots = await Promise.all(skillDirectories(workspaceRoot, options).map(async (root): Promise<SkillRoot> => {
    try { return { ...root, exists: (await fs.stat(root.path)).isDirectory() }; }
    catch (error) {
      if (!isMissing(error)) unreadable++;
      return { ...root, exists: false };
    }
  }));
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let limited = false;
  let metadataLimited = false;

  for (const root of roots) {
    if (!root.exists) continue;
    if (skills.length >= maxSkills || visited >= maxDirectories) { limited = true; break; }
    let directories: string[];
    try {
      directories = [];
      // Stream entries so an unexpectedly large directory cannot allocate an unbounded list.
      for await (const entry of await fs.opendir(root.path)) {
        if (visited >= maxDirectories) { limited = true; break; }
        visited++;
        if (entry.isDirectory() || entry.isSymbolicLink()) directories.push(entry.name);
      }
    } catch (error) {
      if (!isMissing(error)) unreadable++;
      continue;
    }

    for (const directory of directories.sort()) {
      if (skills.length >= maxSkills) { limited = true; break; }
      const file = path.join(root.path, directory, 'SKILL.md');
      try {
        const canonical = await fs.realpath(file);
        const key = `${root.agent}\0${canonical}`;
        if (seen.has(key)) continue;
        // Reject directories and special files before opening; skills are regular text files.
        if (!(await fs.stat(canonical)).isFile()) continue;
        const handle = await fs.open(canonical, 'r');
        let text: string;
        try {
          const buffer = Buffer.alloc(maxFileBytes);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
        const metadata = parseSkillMetadata(text, directory);
        metadataLimited ||= metadata.incomplete;
        seen.add(key);
        const invocable = metadata.invocationName && !metadata.incomplete
          && (root.agent !== 'claude' || metadata.userInvocable);
        skills.push({
          id: createHash('sha256').update(key).digest('hex').slice(0, 32),
          name: metadata.name,
          description: metadata.description,
          // Keep the canonical file so reopening a result is not redirected by retargeting its alias.
          path: canonical,
          agent: root.agent,
          scope: root.scope,
          invocation: invocable ? `${root.agent === 'codex' ? '$' : '/'}${metadata.invocationName}` : '',
          // This describes manual invocation only; the runtime may still choose it automatically.
          ...(root.agent === 'claude' && !metadata.userInvocable ? { disabled: true } : {}),
        });
      } catch (error) {
        if (!isMissing(error)) unreadable++;
      }
    }
  }

  const errors: string[] = [];
  if (limited) errors.push(t('Skill discovery reached its limit. The list may be incomplete.'));
  if (metadataLimited) errors.push(t('Some skill metadata is incomplete or exceeds the read limit.'));
  if (unreadable) errors.push(t('Some skill folders or files could not be read ({0}).', unreadable));
  return {
    skills: skills.sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    skillRoots: roots,
    ...(errors.length ? { skillError: errors.join(' ') } : {}),
  };
}

/**
 * Read the small, top-level scalar subset used by skill metadata. This is not a
 * general YAML loader: tags, aliases, collections and executable content are never evaluated.
 * Supports CRLF/BOM, quoted strings, plain continuations, and | / > block scalars.
 */
export function parseSkillMetadata(text: string, fallbackName: string): SkillMetadata {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fields = new Map<string, string>();
  const opening = /^---[\t ]*\n/.exec(normalized);
  let incomplete = false;
  if (opening) {
    const body = normalized.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[\t ]*$/m.exec(body);
    if (!closing) incomplete = true;
    else {
      const lines = body.slice(0, closing.index).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const field = /^(name|description|user-invocable):(?:[\t ]+(.*)|[\t ]*)$/.exec(lines[i]);
        if (!field || fields.has(field[1])) continue;
        const value = (field[2] ?? '').trim();
        const continuation: string[] = [];
        while (i + 1 < lines.length && (/^[\t ]+/.test(lines[i + 1]) || !lines[i + 1].trim())) {
          continuation.push(lines[++i]);
        }
        const block = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[\t ]+#.*)?$/.test(value);
        const quotedValue = /^["']/.test(value) && continuation.length
          ? [value, ...continuation.map((line) => line.trim())].join(' ') : value;
        const scalar = block ? continuation.map((line) => line.trim()).join('\n') : readScalar(quotedValue);
        if (scalar !== undefined) {
          const plainContinuation = !block && !/^["']/.test(value)
            ? continuation.filter((line) => !line.trim().startsWith('#')).map((line) => line.trim()).join(' ')
            : '';
          fields.set(field[1], [scalar, plainContinuation].filter(Boolean).join(' '));
        }
      }
    }
  }
  const name = singleLine(fields.get('name') || fallbackName);
  return {
    name: name.slice(0, 128),
    description: singleLine(fields.get('description') ?? '').slice(0, 500),
    invocationName: SKILL_NAME.test(name) ? name : undefined,
    userInvocable: fields.get('user-invocable')?.toLowerCase() !== 'false',
    incomplete,
  };
}

function readScalar(value: string): string | undefined {
  if (value.startsWith("'")) {
    let result = '';
    for (let i = 1; i < value.length; i++) {
      if (value[i] !== "'") result += value[i];
      else if (value[i + 1] === "'") { result += "'"; i++; }
      else return /^[\t ]*(?:#.*)?$/.test(value.slice(i + 1)) ? result : undefined;
    }
    return undefined;
  }
  if (value.startsWith('"')) {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(value);
    if (!match || !/^[\t ]*(?:#.*)?$/.test(value.slice(match[0].length))) return undefined;
    try { return JSON.parse(match[0]) as string; } catch { return undefined; }
  }
  // Avoid treating YAML collections, aliases or tagged values as command names.
  if (/^[!&*[{|>]/.test(value)) return undefined;
  return value.replace(/[\t ]+#.*$/, '').trim();
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

function limit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(fallback, Math.floor(value))) : fallback;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
