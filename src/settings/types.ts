import type { AgentPreset } from '../presets';

export type SettingsScope = 'user' | 'workspace';

export interface CatalogAgent {
  id: string;
  label: string;
  kind?: string;
  command: string;
  integrationTarget?: string;
  docsUrl: string;
  preset: AgentPreset;
}

export interface IntegrationInfo {
  target: string;
  installed: boolean;
  cliAvailable?: boolean;
  supported: boolean;
  status: string;
  detail?: string;
  version?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  agent: string;
  scope: 'project' | 'user' | 'system';
  invocation: string;
  disabled?: boolean;
}

export interface SkillRoot {
  path: string;
  agent: string;
  scope: SkillInfo['scope'];
  exists: boolean;
}

export interface SettingsSnapshot {
  scope: SettingsScope;
  /** Opaque token binds saves to this configuration and workspace, even if the UI switches. */
  revision: string;
  workspaceAvailable: boolean;
  workspaceLabel?: string;
  inherited: boolean;
  presets: AgentPreset[];
  projectDefaults: Record<string, { model?: string; effort?: string }>;
  catalog: CatalogAgent[];
  integrations: IntegrationInfo[];
  integrationError?: string;
  herdrVersion?: string;
  skills: SkillInfo[];
  skillRoots: SkillRoot[];
  skillError?: string;
  diagnostics: {
    connected: boolean;
    socketPath: string;
    nodePath: string;
    claudeMemUrl: string;
    trusted: boolean;
  };
}
