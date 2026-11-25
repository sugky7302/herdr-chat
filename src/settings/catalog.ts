import manifest from '../../package.json' with { type: 'json' };
import type { AgentPreset } from '../presets';
import type { CatalogAgent } from './types';

const HERDR_AGENT_DOCS = 'https://herdr.dev/tui/docs/agents/';

// These are extension defaults, not an account-specific provider model catalog.
// Reuse them when adding a familiar agent, without changing existing user presets.
const defaultPresets = manifest.contributes.configuration.properties['herdr.agentPresets'].default as AgentPreset[];

type CatalogDefinition = Omit<CatalogAgent, 'preset'>;

// Canonical kinds and launch executables verified against Herdr v0.9.5:
// https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs
// Integration targets are the socket API names, which differ from CLI labels:
// https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/integrations.rs
const definitions: CatalogDefinition[] = [
  {
    id: 'claude', label: 'Claude Code', kind: 'claude', command: 'claude',
    integrationTarget: 'claude', docsUrl: 'https://code.claude.com/docs/en/setup',
  },
  {
    id: 'codex', label: 'Codex', kind: 'codex', command: 'codex',
    integrationTarget: 'codex', docsUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini', label: 'Gemini CLI', kind: 'gemini', command: 'gemini',
    docsUrl: 'https://geminicli.com/docs/get-started/installation/',
  },
  {
    id: 'cursor', label: 'Cursor Agent CLI', kind: 'cursor',
    command: process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent',
    integrationTarget: 'cursor', docsUrl: 'https://cursor.com/docs/cli/installation',
  },
  {
    id: 'antigravity', label: 'Antigravity CLI', kind: 'agy', command: 'agy',
    integrationTarget: 'antigravity_cli', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'copilot', label: 'GitHub Copilot CLI', kind: 'copilot', command: 'copilot',
    integrationTarget: 'copilot',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  },
  {
    id: 'opencode', label: 'OpenCode', kind: 'opencode', command: 'opencode',
    integrationTarget: 'opencode', docsUrl: 'https://opencode.ai/docs/',
  },
  {
    id: 'pi', label: 'Pi', kind: 'pi', command: 'pi',
    integrationTarget: 'pi', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'omp', label: 'OMP', kind: 'omp', command: 'omp',
    integrationTarget: 'omp', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'devin', label: 'Devin CLI', kind: 'devin', command: 'devin',
    integrationTarget: 'devin', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'cline', label: 'Cline', kind: 'cline', command: 'cline',
    docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'mastracode', label: 'MastraCode', kind: 'mastracode', command: 'mastracode',
    integrationTarget: 'mastracode', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'kimi', label: 'Kimi Code CLI', kind: 'kimi', command: 'kimi',
    integrationTarget: 'kimi', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'kiro', label: 'Kiro CLI', kind: 'kiro', command: 'kiro-cli',
    docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'droid', label: 'Droid', kind: 'droid', command: 'droid',
    integrationTarget: 'droid', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'amp', label: 'Amp', kind: 'amp', command: 'amp',
    docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'grok', label: 'Grok CLI', kind: 'grok', command: 'grok',
    integrationTarget: 'grok', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'hermes', label: 'Hermes Agent', kind: 'hermes', command: 'hermes',
    integrationTarget: 'hermes', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'kilo', label: 'Kilo Code CLI', kind: 'kilo', command: 'kilo',
    integrationTarget: 'kilo', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'qodercli', label: 'Qoder CLI', kind: 'qodercli', command: 'qodercli',
    integrationTarget: 'qodercli', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'qwen', label: 'Qwen Code', kind: 'qwen', command: 'qwen',
    integrationTarget: 'qwen', docsUrl: HERDR_AGENT_DOCS,
  },
  {
    // Letta hooks are experimental and CLI-only in v0.9.5. Never send "letta"
    // as a socket integration target; the frozen enum has only 17 targets.
    id: 'letta', label: 'Letta Code', kind: 'letta', command: 'letta',
    docsUrl: 'https://herdr.dev/tui/docs/integrations/',
  },
  {
    id: 'maki', label: 'Maki', kind: 'maki', command: 'maki',
    docsUrl: HERDR_AGENT_DOCS,
  },
  {
    id: 'muse', label: 'Muse Code', kind: 'muse', command: 'muse',
    docsUrl: HERDR_AGENT_DOCS,
  },
];

export const AGENT_CATALOG: CatalogAgent[] = definitions.map((definition) => {
  const existingDefault = defaultPresets.find((preset) => preset.kind === definition.kind);
  return {
    ...definition,
    preset: existingDefault ? structuredClone(existingDefault) : {
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      models: [],
      efforts: [],
    },
  };
});

/** Human-readable labels for the 17 native socket integration targets. */
export const INTEGRATION_LABELS: Record<string, string> = Object.fromEntries(
  definitions.flatMap((agent) => agent.integrationTarget ? [[agent.integrationTarget, agent.label]] : []),
);

/** API allowlist; excludes experimental CLI-only targets such as Letta. */
export const INTEGRATION_TARGETS: ReadonlySet<string> = new Set(Object.keys(INTEGRATION_LABELS));
