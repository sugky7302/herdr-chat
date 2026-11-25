import { t } from './l10n.ts';
// Claude 的方案用量（5 小時、7 天）。
//
// Claude Code 只把用量交給 statusline 指令（stdin 的 JSON 中 rate_limits 欄位），不寫進對話紀錄。
// 所以擴充功能把 statusLine 換成一個小腳本：先把 JSON 存成檔案，再原樣交給原本的 statusline 指令。
// 終端機中的狀態列不變，也不需要登入憑證。

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'herdr-vscode');
const SCRIPT = path.join(CONFIG_DIR, 'claude-statusline.sh');
const ORIGINAL = path.join(CONFIG_DIR, 'claude-statusline.original.json');
export const STATUS_DIR = path.join(os.homedir(), '.cache', 'herdr-vscode', 'claude-status');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export interface PlanWindow {
  usedPercent: number;
  /** 重設時間（Unix 秒）。 */
  resetsAt?: number;
}

export interface ClaudeStatus {
  fiveHour?: PlanWindow;
  sevenDay?: PlanWindow;
  contextUsedPercent?: number;
  contextWindow?: number;
  /** 檔案更新時間（毫秒）。 */
  updatedAt: number;
}

function scriptBody(): string {
  return `#!/bin/sh
# herdr-vscode: save Claude Code usage, then forward it to the original statusline command.
# Restore the original settings with the herdr.disableClaudeUsage command in VS Code.
input=$(cat)
dir="${STATUS_DIR}"
mkdir -p "$dir" 2>/dev/null
sid=$(printf '%s' "$input" | /usr/bin/sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | /usr/bin/head -n 1)
if [ -n "$sid" ]; then printf '%s' "$input" > "$dir/$sid.json.tmp" && mv "$dir/$sid.json.tmp" "$dir/$sid.json"; fi
original=$(/usr/bin/sed -n 's/^command=//p' "${ORIGINAL}.cmd" 2>/dev/null)
if [ -n "$original" ]; then printf '%s' "$input" | /bin/sh -c "$original"; fi
`;
}

async function readSettings(): Promise<Record<string, any>> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS, 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(t("Could not read {0}: {1}", SETTINGS, error.message));
  }
}

export async function isInstalled(): Promise<boolean> {
  const settings = await readSettings().catch(() => ({}) as Record<string, any>);
  return settings.statusLine?.command === SCRIPT;
}

/** 安裝腳本並把 statusLine 指向它。原本的設定存起來，停用時還原。 */
export async function install(): Promise<void> {
  const settings = await readSettings();
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const current = settings.statusLine;
  if (current?.command !== SCRIPT) {
    await fs.writeFile(ORIGINAL, JSON.stringify(current ?? null, null, 2));
    await fs.writeFile(`${ORIGINAL}.cmd`, `command=${current?.type === 'command' ? current.command ?? '' : ''}\n`);
    await fs.copyFile(SETTINGS, `${SETTINGS}.herdr-vscode.bak`).catch(() => undefined);
  }
  await fs.writeFile(SCRIPT, scriptBody(), { mode: 0o755 });
  await fs.chmod(SCRIPT, 0o755);
  settings.statusLine = { ...(current ?? {}), type: 'command', command: SCRIPT };
  await fs.writeFile(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

/** 還原原本的 statusLine 設定。 */
export async function uninstall(): Promise<void> {
  const settings = await readSettings();
  if (settings.statusLine?.command !== SCRIPT) return;
  const original = JSON.parse(await fs.readFile(ORIGINAL, 'utf8').catch(() => 'null'));
  if (original) settings.statusLine = original;
  else delete settings.statusLine;
  await fs.writeFile(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function window(value: any): PlanWindow | undefined {
  const used = value?.used_percentage ?? value?.utilization;
  if (typeof used !== 'number') return undefined;
  return { usedPercent: used, resetsAt: typeof value.resets_at === 'number' ? value.resets_at : undefined };
}

/** 解析 statusline 的 JSON。純函式，方便測試。 */
export function parseStatus(text: string, updatedAt: number): ClaudeStatus | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const limits = data?.rate_limits ?? {};
  const context = data?.context_window ?? {};
  return {
    fiveHour: window(limits.five_hour),
    sevenDay: window(limits.seven_day),
    contextUsedPercent: typeof context.used_percentage === 'number' ? context.used_percentage : undefined,
    contextWindow: typeof context.context_window_size === 'number' ? context.context_window_size : undefined,
    updatedAt,
  };
}

export async function readStatus(sessionId: string): Promise<ClaudeStatus | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const file = path.join(STATUS_DIR, `${sessionId}.json`);
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return parseStatus(text, stat.mtimeMs);
  } catch {
    return null;
  }
}
