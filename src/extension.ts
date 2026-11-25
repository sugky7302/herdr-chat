import * as vscode from 'vscode';
import { Controller, describe } from './controller';
import type { FromWebview, ToWebview } from './shared';
import * as claudeUsage from './claudeUsage';
import { createHash } from 'node:crypto';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HerdrViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('herdr.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('herdr.refresh', () => provider.controller.refresh()),
    vscode.commands.registerCommand('herdr.history', () => provider.post({ type: 'navigate', view: 'history' })),
    vscode.commands.registerCommand('herdr.newAgent', () => provider.post({ type: 'navigate', view: 'newAgent' })),
    vscode.commands.registerCommand('herdr.enableClaudeUsage', async () => {
      const choice = await vscode.window.showInformationMessage(
        '啟用 Claude 用量顯示？',
        {
          modal: true,
          detail:
            '會修改 ~/.claude/settings.json 的 statusLine：改成先保存 Claude Code 提供的用量資料，再交給原本的 statusline 指令。終端機的狀態列不變。原本的設定會備份，可以用「herdr: 停用 Claude 用量顯示」還原。',
        },
        '啟用',
      );
      if (choice !== '啟用') return;
      await claudeUsage.install();
      void vscode.window.showInformationMessage('已啟用。Claude 下一次更新狀態列後就會顯示 5 小時用量。');
    }),
    vscode.commands.registerCommand('herdr.disableClaudeUsage', async () => {
      await claudeUsage.uninstall();
      void vscode.window.showInformationMessage('已還原原本的 Claude statusLine 設定。');
    }),
    provider,
  );
}

export function deactivate(): void {}

class HerdrViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly controller: Controller;
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const workspaceKey = createHash('sha256').update(
      context.storageUri?.toString() ?? vscode.workspace.workspaceFile?.toString()
        ?? ((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).sort().join('\n') || 'empty'),
    ).digest('hex').slice(0, 24);
    this.controller = new Controller(context.workspaceState, (message) => this.post(message), context.globalState, {
      storageDir: vscode.Uri.joinPath(context.globalStorageUri, 'collaboration', workspaceKey).fsPath,
      cliPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'herdr-collab.cjs').fsPath,
    });
  }

  dispose(): void {
    this.controller.dispose();
  }

  post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.handle(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private async handle(message: FromWebview): Promise<void> {
    const c = this.controller;
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await c.refresh();
          break;
        case 'openPane':
          c.setOpenPane(message.paneId);
          break;
        case 'openTask':
          await c.openTask(message.tabId);
          break;
        case 'saveTaskMemory':
          await this.taskOperation(message, 'memory', async () => ({ memoryId: await c.saveTaskMemory(message) }));
          break;
        case 'prepareHandoff':
          await this.taskOperation(message, 'checkpoint', async () => ({ checkpoint: await c.prepareHandoff(message.tabId) }));
          break;
        case 'requestHandoff':
          await this.taskOperation(message, 'handoff', async () => { await c.requestHandoff(message.tabId, message.target); return {}; });
          break;
        case 'delegateTask':
          await this.taskOperation(message, 'delegate', async () => { await c.delegateTask(message.tabId, message.target, message.text); return {}; });
          break;
        case 'assignPlanner':
          await this.taskOperation(message, 'planner', async () => { await c.assignPlanner(message.tabId, message.paneId); return {}; });
          break;
        case 'copyCollaborationPrompt':
          await c.copyCollaborationPrompt(message.tabId);
          break;
        case 'answerTaskRequest':
          await this.taskOperation(message, 'answer', async () => { await c.answerTaskRequest(message.tabId, message.requestId, message.text); return {}; });
          break;
        case 'focusTab':
          await c.focusTab(message.tabId);
          break;
        case 'focusPaneInHerdr':
          await c.focusPane(message.paneId);
          break;
        case 'newTab':
          await this.busy('建立新對話…', () => c.newTab());
          break;
        case 'newAgent': {
          if (message.saveAsDefault) await c.saveProjectDefault(message.presetId, message.model, message.effort);
          const paneId = await this.busy('啟動 agent…', () =>
            c.newAgent(message.presetId, message.tabId, message.model, message.effort),
          );
          this.post({ type: 'state', state: c.currentState()! });
          c.setOpenPane(paneId);
          this.post({ type: 'openedPane', paneId });
          break;
        }
        case 'send':
          await c.send(message.paneId, message.text, {
            model: message.model,
            effort: message.effort,
            attachments: message.attachments,
            mode: message.mode,
          });
          break;
        case 'updateQueued':
          await c.updateQueued(message.paneId, message.id, message.text);
          this.post({ type: 'queuedUpdated', paneId: message.paneId, id: message.id });
          break;
        case 'removeQueued':
          c.removeQueued(message.paneId, message.id);
          break;
        case 'insertQueued':
          await c.insertQueued(message.paneId, message.id);
          break;
        case 'chooseOption':
          await c.chooseOption(message.paneId, message.number);
          break;
        case 'renameTab':
          await c.renameTab(message.tabId);
          break;
        case 'closeTab':
          await c.closeTab(message.tabId);
          break;
        case 'renamePane':
          await c.renamePane(message.paneId);
          break;
        case 'closePane':
          await c.closePane(message.paneId);
          break;
        case 'complete':
          this.post({
            type: 'completions',
            requestId: message.requestId,
            items: await c.complete(message.paneId, message.trigger, message.query),
          });
          break;
        case 'pickFiles':
          this.post({ type: 'attachments', paneId: message.paneId, paths: await c.pickFiles() });
          break;
        case 'dropUris': {
          const paths = message.uris
            .map((value) => {
              try {
                return vscode.Uri.parse(value.trim()).fsPath;
              } catch {
                return '';
              }
            })
            .filter(Boolean);
          this.post({ type: 'attachments', paneId: message.paneId, paths });
          break;
        }
        case 'dropFiles':
          this.post({ type: 'attachments', paneId: message.paneId, paths: await c.saveDroppedFiles(message.files) });
          break;
        case 'refreshCommands': {
          const count = await this.busy('從 agent 讀取指令清單…', () => c.refreshCommands(message.paneId));
          void vscode.window.showInformationMessage(`已更新 ${count} 個 / 指令。`);
          break;
        }
        case 'keys':
          await c.sendKeys(message.paneId, message.keys);
          break;
        case 'showScreen':
          await c.showScreen(message.paneId, message.show);
          break;
        case 'interrupt':
          await c.interrupt(message.paneId);
          break;
        case 'switchWorktree':
          await c.switchWorktree(message.path);
          break;
        case 'createWorktree':
          await this.busy('建立 worktree…', () => c.createWorktree(message.branch));
          break;
        case 'createWorkspace':
          await this.busy('建立 workspace…', () => c.createWorkspace());
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'herdr.agentPresets');
          break;
      }
    } catch (error) {
      if (message.type === 'updateQueued') {
        this.post({ type: 'queuedUpdated', paneId: message.paneId, id: message.id, error: describe(error) });
      } else {
        this.post({ type: 'error', text: describe(error) });
      }
    }
  }

  /** Correlated replies keep an async result attached to its original problem and draft. */
  private async taskOperation(
    message: { tabId: string; operationId: string },
    kind: Extract<ToWebview, { type: 'taskOperation' }>['kind'],
    work: () => Promise<{ memoryId?: number; checkpoint?: string }>,
  ): Promise<void> {
    try {
      const result = await work();
      this.post({ type: 'taskOperation', tabId: message.tabId, operationId: message.operationId, kind, ...result });
    } catch (error) {
      this.post({ type: 'taskOperation', tabId: message.tabId, operationId: message.operationId, kind, error: describe(error) });
    }
  }

  private async busy<T>(text: string, work: () => Promise<T>): Promise<T> {
    this.post({ type: 'busy', busy: true, text });
    try {
      return await work();
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
