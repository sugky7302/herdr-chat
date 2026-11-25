import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { t } from '../l10n.ts';
import { normalizePresets, type AgentPreset } from '../presets.ts';
import { AGENT_CATALOG, INTEGRATION_TARGETS } from './catalog.ts';
import type { IntegrationInfo, SettingsScope, SettingsSnapshot, SkillInfo, SkillRoot } from './types.ts';

export interface SettingsConfiguration {
  scope: SettingsScope;
  /** Includes both the VS Code configuration resource and the selected checkout. */
  workspaceKey: string;
  workspaceRoot?: string;
  workspaceAvailable: boolean;
  workspaceLabel?: string;
  presets: unknown;
  inherited: boolean;
  projectDefaults: SettingsSnapshot['projectDefaults'];
  /** Raw configuration at every scope; changes outside this editor invalidate its revision. */
  revisionData: unknown;
  diagnostics: SettingsSnapshot['diagnostics'];
  write(presets: AgentPreset[] | undefined): Promise<void>;
}

export interface SettingsHost {
  read(scope: SettingsScope): SettingsConfiguration;
  request(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
  scanSkills(root?: string): Promise<{ skills: SkillInfo[]; skillRoots: SkillRoot[]; skillError?: string }>;
}

const arrayFields = ['args', 'models', 'efforts', 'modelArgs', 'effortArgs', 'slashCommands'] as const;
const textFields = ['kind', 'command', 'defaultModel', 'defaultEffort', 'switchModel', 'switchEffort'] as const;

/** Validate before replacing a whole settings array; preserve extension-specific extra fields. */
export function validatePresets(raw: unknown): AgentPreset[] {
  if (!Array.isArray(raw) || raw.length > 100 || JSON.stringify(raw).length > 512_000) {
    throw new Error(t('Agent settings must be an array of at most 100 presets.'));
  }
  const ids = new Set<string>();
  for (const [index, value] of raw.entries()) {
    const fail = (reason: string): never => { throw new Error(t('Agent preset {0}: {1}', index + 1, reason)); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(t('Expected an object.'));
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || item.id === '__shell__') {
      fail(t('Use a unique ID containing letters, numbers, underscores, or hyphens.'));
    }
    if (ids.has(item.id as string)) fail(t('The ID {0} is duplicated.', item.id as string));
    ids.add(item.id as string);
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200) fail(t('A label of at most 200 characters is required.'));
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') fail(t('Enabled must be true or false.'));
    for (const field of textFields) {
      if (item[field] !== undefined && (typeof item[field] !== 'string' || (item[field] as string).length > 8_192 || (item[field] as string).includes('\0'))) {
        fail(t('{0} must be text without null characters.', field));
      }
    }
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (Boolean(kind) === Boolean(command)) fail(t('Choose either a Herdr agent kind or a custom command.'));
    if (kind && !/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) fail(t('The Herdr agent kind is invalid.'));
    for (const field of arrayFields) {
      if (item[field] !== undefined && (!Array.isArray(item[field]) || (item[field] as unknown[]).length > 300
          || !(item[field] as unknown[]).every((part) => typeof part === 'string' && part.length <= 8_192 && !part.includes('\0')))) {
        fail(t('{0} must be an array of strings.', field));
      }
    }
    for (const [field, options] of [['defaultModel', 'models'], ['defaultEffort', 'efforts']] as const) {
      if (item[field] && !(item[options] as string[] | undefined)?.includes(item[field] as string)) {
        fail(t('{0} must be included in {1}.', field, options));
      }
    }
    if (item.switchStyle !== undefined && !['command', 'codex-menu'].includes(item.switchStyle as string)) fail(t('The model switching style is invalid.'));
  }
  return structuredClone(raw) as AgentPreset[];
}

function revision(config: SettingsConfiguration): string {
  return createHash('sha256').update(JSON.stringify({ scope: config.scope, key: config.workspaceKey,
    values: config.revisionData, defaults: config.projectDefaults })).digest('hex');
}

function scopeValue(scope: SettingsScope): SettingsScope {
  if (scope !== 'user' && scope !== 'workspace') throw new Error(t('Unknown settings scope.'));
  return scope;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** The native API reports recommendations, not proof that a CLI executable can run. */
export function parseIntegrations(raw: unknown): IntegrationInfo[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).integrations)) throw new Error(t('Herdr returned an invalid integration list.'));
  const seen = new Set<string>();
  const result: IntegrationInfo[] = [];
  for (const item of (raw as any).integrations) {
    if (!item || typeof item.target !== 'string' || !INTEGRATION_TARGETS.has(item.target) || seen.has(item.target)) continue;
    seen.add(item.target);
    const known = ['not_installed', 'current', 'outdated'].includes(item.state);
    result.push({ target: item.target, installed: item.state === 'current' || item.state === 'outdated',
      supported: known, status: known ? item.state : 'unknown',
      detail: item.available === false ? t('Herdr did not recommend this integration. Check the agent installation and its configuration directory.') : undefined });
  }
  return result;
}

export class SettingsService {
  private writing = false;
  private integrating = false;
  private skillPaths = new Map<string, string>();

  constructor(private readonly host: SettingsHost) {}

  async load(scope: SettingsScope): Promise<SettingsSnapshot> {
    const config = this.host.read(scopeValue(scope));
    const [integrations, skills] = await Promise.allSettled([
      this.host.request('integration.list', {}, 5_000).then(parseIntegrations),
      this.host.scanSkills(config.workspaceRoot),
    ]);
    // Open-file messages only resolve IDs from host-discovered files, never arbitrary webview paths.
    if (skills.status === 'fulfilled') for (const skill of skills.value.skills) this.skillPaths.set(skill.id, skill.path);
    // Bound the cache across repeated worktree changes without evicting a visible inventory on a small refresh.
    if (this.skillPaths.size > 10_000) this.skillPaths = new Map(skills.status === 'fulfilled' ? skills.value.skills.map((skill) => [skill.id, skill.path]) : []);
    return {
      scope, revision: revision(config), workspaceAvailable: config.workspaceAvailable, workspaceLabel: config.workspaceLabel,
      inherited: config.inherited, presets: structuredClone(normalizePresets(config.presets)), projectDefaults: structuredClone(config.projectDefaults),
      catalog: structuredClone(AGENT_CATALOG), diagnostics: config.diagnostics,
      integrations: integrations.status === 'fulfilled' ? integrations.value : [],
      integrationError: integrations.status === 'rejected' ? errorMessage(integrations.reason) : undefined,
      skills: skills.status === 'fulfilled' ? skills.value.skills : [],
      skillRoots: skills.status === 'fulfilled' ? skills.value.skillRoots : [],
      skillError: skills.status === 'fulfilled' ? skills.value.skillError : errorMessage(skills.reason),
    };
  }

  async save(scope: SettingsScope, expectedRevision: string, raw: unknown): Promise<SettingsSnapshot> {
    return this.write(scope, expectedRevision, validatePresets(raw));
  }

  async reset(scope: SettingsScope, expectedRevision: string): Promise<SettingsSnapshot> {
    return this.write(scope, expectedRevision, undefined);
  }

  private async write(scope: SettingsScope, expectedRevision: string, presets: AgentPreset[] | undefined): Promise<SettingsSnapshot> {
    scopeValue(scope);
    if (this.writing) throw new Error(t('Another settings save is in progress.'));
    this.writing = true;
    try {
      const config = this.host.read(scope);
      if (scope === 'workspace' && !config.workspaceAvailable) throw new Error(t('Open a workspace before saving workspace settings.'));
      if (revision(config) !== expectedRevision) throw new Error(t('Settings or the selected workspace changed. Your draft is preserved. Refresh before saving again.'));
      await config.write(presets);
    } finally { this.writing = false; }
    return this.load(scope);
  }

  async runIntegration(scope: SettingsScope, target: string, action: 'install' | 'uninstall'): Promise<{ snapshot: SettingsSnapshot; output: string }> {
    scopeValue(scope);
    if (!INTEGRATION_TARGETS.has(target) || !['install', 'uninstall'].includes(action)) throw new Error(t('Unsupported Herdr integration action.'));
    const connection = this.host.read(scope).diagnostics;
    if (!connection.trusted) throw new Error(t('Trust this workspace before changing Herdr integrations.'));
    if (this.integrating) throw new Error(t('Another Herdr integration operation is in progress.'));
    this.integrating = true;
    try {
      // Verify support against the installed server before sending any mutation; no optimistic/fake states.
      const available = parseIntegrations(await this.host.request('integration.list', {}, 5_000));
      if (!available.some((item) => item.target === target && item.supported)) throw new Error(t('The running Herdr version does not expose this integration.'));
      const currentConnection = this.host.read(scope).diagnostics;
      if (!currentConnection.trusted) throw new Error(t('Trust this workspace before changing Herdr integrations.'));
      if (currentConnection.socketPath !== connection.socketPath) throw new Error(t('The Herdr connection changed. Refresh Settings before trying again.'));
      const response = await this.host.request(`integration.${action}`, { target }, 60_000) as any;
      if (!response || response.target !== target || !Array.isArray(response.details?.messages)
          || !response.details.messages.every((value: unknown) => typeof value === 'string')) {
        throw new Error(t('Herdr returned an unexpected result. Refresh the integration list to check its current state.'));
      }
      if (this.host.read(scope).diagnostics.socketPath !== connection.socketPath) throw new Error(t('The Herdr connection changed. Refresh Settings before trying again.'));
      const snapshot = await this.load(scope);
      if (snapshot.diagnostics.socketPath !== connection.socketPath || this.host.read(scope).diagnostics.socketPath !== connection.socketPath) {
        throw new Error(t('The Herdr connection changed. Refresh Settings before trying again.'));
      }
      const current = snapshot.integrations.find((item) => item.target === target);
      if (snapshot.integrationError || !current || (action === 'install' ? current.status !== 'current' : current.status !== 'not_installed')) {
        throw new Error(t('Herdr finished the operation, but its resulting state could not be verified. Refresh the integration list.'));
      }
      return { snapshot, output: response.details.messages.join('\n').slice(0, 32_000) };
    } finally { this.integrating = false; }
  }

  docsUrl(id: string): string {
    if (id === 'herdr-skill') return 'https://herdr.dev/tui/docs/agent-skill/';
    const entry = AGENT_CATALOG.find((item) => item.id === id);
    if (!entry) throw new Error(t('This documentation entry could not be found.'));
    return entry.docsUrl;
  }

  async skillPath(id: string): Promise<string> {
    const file = this.skillPaths.get(id);
    if (!file) throw new Error(t('Refresh the Skills list before opening this file.'));
    if (await realpath(file) !== file) throw new Error(t('The skill file moved. Refresh the Skills list.'));
    return file;
  }
}
