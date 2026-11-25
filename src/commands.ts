import { t } from './l10n.ts';
import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompletionItem } from './shared';
import claudeCatalog from './catalog/claude.json';
import codexCatalog from './catalog/codex.json';

interface CommandEntry {
  name: string;
  description: string;
}

const HARVEST_KEY = 'herdr.harvestedCommands';
const BUILT_IN: Record<string, CommandEntry[]> = {
  claude: claudeCatalog as CommandEntry[],
  codex: codexCatalog as CommandEntry[],
};

/**
 * 各 agent 的 / 指令清單。
 * 來源依優先順序：從 agent 讀取的清單 > 內建清單；再加上磁碟上的自訂指令與 skill。
 */
export class Commands {
  private diskCache = new Map<string, { at: number; entries: CommandEntry[] }>();

  constructor(private readonly memento: vscode.Memento) {}

  async list(kind: string | null, root: string, extra: string[], query: string): Promise<CompletionItem[]> {
    const harvested = this.memento.get<Record<string, CommandEntry[]>>(HARVEST_KEY, {});
    const entries = new Map<string, CommandEntry>();
    const add = (entry: CommandEntry) => {
      if (!entries.has(entry.name)) entries.set(entry.name, entry);
    };
    (kind ? harvested[kind] ?? BUILT_IN[kind] ?? [] : []).forEach(add);
    (kind ? await this.disk(kind, root) : []).forEach(add);
    extra.forEach((name) => add({ name: name.startsWith('/') ? name : `/${name}`, description: '' }));

    const needle = query.toLowerCase();
    return [...entries.values()]
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))
      .sort((a, b) => rank(a, needle) - rank(b, needle) || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map((entry) => ({ label: entry.name, description: entry.description, insert: `${entry.name} `, kind: 'command' as const }));
  }

  /**
   * 在 agent 的輸入框打 /，用方向鍵捲動選單並記錄所有指令，最後清除輸入。
   * 回傳讀到的指令數量。
   */
  async harvest(
    kind: string,
    io: { type(text: string): Promise<unknown>; keys(keys: string[]): Promise<unknown>; read(): Promise<string> },
  ): Promise<number> {
    const found = new Map<string, string>();
    await io.type('/');
    await sleep(800);
    let stale = 0;
    for (let step = 0; step < 400 && stale < 25; step++) {
      let added = 0;
      for (const line of (await io.read()).split('\n')) {
        const match = /^\s*[❯›>]?\s*(\/[\w:.-]+)\s{2,}(.*)$/.exec(line);
        if (match && match[1] !== '/' && !found.has(match[1])) {
          found.set(match[1], match[2].trim().replace(/…$/, ''));
          added++;
        }
      }
      stale = added ? 0 : stale + 1;
      await io.keys(['down']);
      await sleep(60);
    }
    await io.keys(['esc']);
    await sleep(150);
    await io.keys(['backspace']);
    if (found.size < 5) throw new Error(t("No command list was found. Make sure the agent is at its input prompt."));
    const all = { ...this.memento.get<Record<string, CommandEntry[]>>(HARVEST_KEY, {}) };
    all[kind] = [...found].map(([name, description]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
    await this.memento.update(HARVEST_KEY, all);
    return found.size;
  }

  /** 讀取磁碟上的自訂指令與 skill。結果快取 30 秒。 */
  private async disk(kind: string, root: string): Promise<CommandEntry[]> {
    const key = `${kind}:${root}`;
    const cached = this.diskCache.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.entries;
    const home = os.homedir();
    let entries: CommandEntry[] = [];
    if (kind === 'claude') {
      entries = [
        ...(await markdownCommands(path.join(root, '.claude', 'commands'), '')),
        ...(await skills(path.join(root, '.claude', 'skills'))),
        ...(await markdownCommands(path.join(home, '.claude', 'commands'), '')),
        ...(await skills(path.join(home, '.claude', 'skills'))),
      ];
    } else if (kind === 'codex') {
      entries = await markdownCommands(path.join(home, '.codex', 'prompts'), 'prompts:');
    } else if (kind === 'agy') {
      entries = [
        ...(await skills(path.join(root, '.github', 'skills'))),
        ...(await skills(path.join(root, '.agents', 'skills'))),
        ...(await skills(path.join(home, '.agents', 'skills'))),
        ...(await skills(path.join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'))),
      ];
    }
    this.diskCache.set(key, { at: Date.now(), entries });
    return entries;
  }
}

function rank(entry: CommandEntry, needle: string): number {
  if (!needle) return entry.name.includes(':') ? 1 : 0;
  const name = entry.name.slice(1).toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  return 2;
}

async function markdownCommands(dir: string, prefix: string): Promise<CommandEntry[]> {
  const entries: CommandEntry[] = [];
  const walk = async (current: string, namespace: string[]) => {
    for (const item of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) await walk(full, [...namespace, item.name]);
      else if (item.name.endsWith('.md')) {
        const name = [...namespace, item.name.slice(0, -3)].join(':');
        entries.push({ name: `/${prefix}${name}`, description: await frontmatterDescription(full) });
      }
    }
  };
  await walk(dir, []);
  return entries;
}

async function skills(dir: string): Promise<CommandEntry[]> {
  const entries: CommandEntry[] = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const file = path.join(dir, item.name, 'SKILL.md');
    const description = await frontmatterDescription(file).catch(() => null);
    if (description !== null) entries.push({ name: `/${item.name}`, description });
  }
  return entries;
}

async function frontmatterDescription(file: string): Promise<string> {
  const text = (await fs.readFile(file, 'utf8')).slice(0, 4000);
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const line = match?.[1].split('\n').find((row) => row.startsWith('description:'));
  return line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '').slice(0, 200) : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
