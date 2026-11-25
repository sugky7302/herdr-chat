import * as vscode from 'vscode';
import type { Controller } from '../controller';
import type { AgentPreset } from '../presets';
import { scanSkills } from '../skills/discovery';
import type { SettingsHost } from './service';
import type { SettingsScope } from './types';

/** Capture the exact configuration object and target so an async save cannot follow a changed worktree. */
export function createSettingsHost(controller: Controller): SettingsHost {
  return {
    read(scope: SettingsScope) {
      const { resource, root } = controller.settingsWorkspace();
      const settings = vscode.workspace.getConfiguration('herdr', resource);
      const inspected = settings.inspect<AgentPreset[]>('agentPresets');
      const folderTarget = Boolean(resource && (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      const target = scope === 'user' ? vscode.ConfigurationTarget.Global
        : folderTarget ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
      const ownValue = scope === 'user' ? inspected?.globalValue
        : folderTarget ? inspected?.workspaceFolderValue : inspected?.workspaceValue;
      const presets = scope === 'user' ? inspected?.globalValue ?? inspected?.defaultValue
        : (folderTarget ? inspected?.workspaceFolderValue : undefined) ?? inspected?.workspaceValue ?? inspected?.globalValue ?? inspected?.defaultValue;
      const plain = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
      return {
        scope, workspaceKey: JSON.stringify([vscode.workspace.workspaceFile?.toString(), resource?.toString(), root]),
        workspaceRoot: root, workspaceAvailable: Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length),
        workspaceLabel: resource ? vscode.workspace.getWorkspaceFolder(resource)?.name : vscode.workspace.name,
        presets: plain(presets), inherited: ownValue === undefined,
        projectDefaults: plain(settings.get<Record<string, { model?: string; effort?: string }>>('agentDefaults') ?? {}),
        revisionData: plain(inspected),
        diagnostics: {
          connected: Boolean(controller.currentState()?.connected), socketPath: controller.client.socketPath,
          nodePath: settings.get<string>('collaborationNodePath') || 'node',
          claudeMemUrl: settings.get<string>('claudeMemUrl') || '', trusted: vscode.workspace.isTrusted,
        },
        async write(value: AgentPreset[] | undefined) { await settings.update('agentPresets', value, target); },
      };
    },
    request: (method, params, timeout) => controller.client.request(method, params, timeout),
    scanSkills: (root) => { controller.clearCommandCache(); return scanSkills(root); },
  };
}
