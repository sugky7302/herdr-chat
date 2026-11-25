import type { PresetView } from './shared';

export interface AgentPreset {
  id: string;
  label: string;
  kind?: string;
  command?: string;
  args?: string[];
  models?: string[];
  efforts?: string[];
  defaultModel?: string;
  defaultEffort?: string;
  modelArgs?: string[];
  effortArgs?: string[];
  switchModel?: string;
  switchEffort?: string;
  /** codex-menu：用 Codex 的 /model 選單切換模型與 effort。 */
  switchStyle?: 'command' | 'codex-menu';
  /** 額外的 / 指令，用於內建清單沒有的 agent。 */
  slashCommands?: string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** 移除格式不正確的選項，避免整個選單失效。 */
export function normalizePresets(raw: unknown): AgentPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const presets: AgentPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const preset = item as AgentPreset;
    if (typeof preset.id !== 'string' || typeof preset.label !== 'string') continue;
    if (!preset.kind && !preset.command) continue;
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

export function toPresetView(preset: AgentPreset): PresetView {
  return {
    id: preset.id,
    label: preset.label,
    models: preset.models ?? [],
    efforts: preset.efforts ?? [],
    defaultModel: preset.defaultModel,
    defaultEffort: preset.defaultEffort,
    canSwitchModel: Boolean(preset.switchModel) || preset.switchStyle === 'codex-menu',
    canSwitchEffort: Boolean(preset.switchEffort) || preset.switchStyle === 'codex-menu',
  };
}

function fill(template: string[] | undefined, key: string, value: string | undefined): string[] {
  if (!template || !value) return [];
  return template.map((part) => part.split(`{${key}}`).join(value));
}

/** 組出啟動 agent 的參數：固定參數、模型參數、effort 參數。 */
export function buildStartArgs(preset: AgentPreset, model?: string, effort?: string): string[] {
  return [
    ...(preset.args ?? []),
    ...fill(preset.modelArgs, 'model', model),
    ...fill(preset.effortArgs, 'effort', effort),
  ];
}

/** 把參數轉成可以直接貼進 shell 的字串。 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(preset: AgentPreset, model?: string, effort?: string): string {
  const args = buildStartArgs(preset, model, effort).map(shellQuote);
  return [preset.command ?? '', ...args].join(' ').trim();
}

export function switchCommand(template: string | undefined, key: 'model' | 'effort', value: string): string | null {
  if (!template) return null;
  return template.split(`{${key}}`).join(value);
}

/** 產生 herdr 接受的唯一 agent 名稱，例如 claude-2。 */
export function agentName(presetId: string, taken: Iterable<string>): string {
  let base = presetId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '');
  if (!base) base = 'agent';
  base = base.slice(0, 28);
  const used = new Set(taken);
  for (let n = 1; n < 1000; n++) {
    const name = `${base}-${n}`;
    if (!used.has(name) && NAME_PATTERN.test(name)) return name;
  }
  return `${base}-${Date.now() % 1000}`;
}

/** herdr 回報的 agent 種類對應到選項。DeepSeek 等自訂指令的 agent 由記錄的對應找回。 */
export function presetForKind(presets: AgentPreset[], kind: string | null | undefined): AgentPreset | undefined {
  if (!kind) return undefined;
  return presets.find((preset) => preset.kind === kind);
}
