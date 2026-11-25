# Herdr Chat

English | [繁體中文](README.zh-TW.md)

Chat with coding agents running in [Herdr](https://herdr.dev/tui/docs/) from the VS Code secondary sidebar. Browse your project's worktrees, switch between agent panes, read conversations and terminal output, and manage agent launch settings.

Herdr manages the terminal processes, workspaces, tabs, and panes. Herdr Chat provides a VS Code interface to those resources, with additional features for task collaboration and saving selected messages to an existing Claude-mem worker.

## Features

- **Agent conversations:** read native transcripts for Claude Code, Codex, and Antigravity CLI when available, with terminal-output fallback for other agents or unavailable transcripts.
- **Pane controls:** switch agents, inspect terminal output, focus a pane in Herdr, and rename or close tabs and panes.
- **Message composition:** attach files, drop files, paste images, use `@` file completion, and browse `/` commands and local skills.
- **Message queues:** queue messages while an agent is working, then edit, remove, or send them immediately.
- **Agent settings:** customize launch presets, model IDs, effort values, and startup arguments at user or workspace scope.
- **Herdr integrations:** inspect, install, update, or remove integrations through Herdr's native API.
- **Local skills:** browse supported local skill directories and open the original `SKILL.md` files.
- **Display language:** automatically follow VS Code's English or Traditional Chinese display language.

[Task collaboration](#task-collaboration) and [memory saving](#saving-memories-with-claude-mem) are additional workflows. Choosing a planner is only needed when enabling collaboration for a tab.

## Requirements

| Component | Requirement |
| --- | --- |
| VS Code | Version 1.105 or later within the supported VS Code engine range. |
| Herdr | Installed and running, with its API socket accessible from the VS Code extension host. |
| Project | An open Git repository for the main worktree, workspace, and chat views. Settings can also open without a repository. |
| Agent CLIs | Install and authenticate the agents you want to use separately. |
| Collaboration CLI | Node.js 20+ available in the agent's environment when using the extension's collaboration workflow. |
| Claude-mem | An existing, reachable worker when using memory saving. |

For development and tests, use **Node.js 24**, the version used to validate this repository. The test command uses `--experimental-strip-types`; Node.js 20 is sufficient for the bundled collaboration CLI, but not for the test suite.

## Installation

Build a VSIX from this repository:

```sh
git clone https://github.com/sugky7302/herdr-chat.git
cd herdr-chat
npm ci
npm run build
npm run package
```

In VS Code, run **Extensions: Install from VSIX…** and select the generated `herdr-vscode-*.vsix` file. The package filename retains the extension's existing `herdr-vscode` identifier.

Then:

1. Install and start [Herdr](https://herdr.dev/tui/docs/).
2. Open your Git repository in VS Code.
3. Open the **herdr** view in the secondary sidebar.
4. Select a worktree and its Herdr workspace. If no matching workspace exists, use the view's create-workspace action.
5. Select an existing agent pane or add an agent. Complete the agent's own authentication and initial prompts in its terminal.

If the socket is not discovered automatically, set `herdr.socketPath`. Resolution checks that setting, then `HERDR_SOCKET_PATH`, then `~/.config/herdr/herdr.sock`.

## Working with Herdr

Herdr's [native concepts](https://herdr.dev/tui/docs/concepts/) remain the underlying structure: a workspace contains tabs, and a tab contains terminal panes. A pane can run an agent, a shell, or another process.

Herdr Chat associates the selected Git worktree with a Herdr workspace. Its **Chat**, **Collaboration**, and **Memory** views share the currently selected tab; changing the active agent changes the conversation being viewed. The extension's task records group collaboration and memory references by tab.

### Chat controls

| Action | Control |
| --- | --- |
| Send a message | Enter. While the agent is working, the message is queued. |
| Send immediately | Ctrl+Enter on Windows/Linux, Cmd+Enter on macOS, or the immediate-send button. |
| Interrupt a working agent | Esc when the completion menu is closed, or the interrupt control. |
| Find a project file | Type `@`. |
| Find an agent command or local skill | Type `/`. Codex skill selections insert their native `$skill-name` invocation. |
| Attach content | Use the attachment button, drop files, or paste an image. Hold Shift when dragging from the VS Code Explorer. |

Model and effort switching depends on the configured preset and the agent CLI. Presets can use slash-command templates or Codex's interactive model menu. Changes apply before the next message is delivered.

Context and usage information appears when the agent exposes data the extension can read. To enable the additional Claude usage display, run **herdr: Enable Claude Usage Display**. This explicitly installs a wrapper around Claude's existing `statusLine`, with a backup and a corresponding **herdr: Disable Claude Usage Display** restore command. The current wrapper requires a POSIX shell.

## Settings

Open the **gear button** in the view title or run **herdr: Settings**. The settings page remains available when Herdr is disconnected.

### Agents and models

Configure which presets appear when creating agents. Each preset uses either a native Herdr `kind` or a custom shell `command`.

You can edit:

- The preset ID, display name, and whether it is included in creation menus.
- Model IDs, effort values, and their defaults.
- Startup arguments and model/effort argument templates.
- Conversation-time switching commands and additional slash commands.

Disabling a preset removes it from new-agent and automatic-collaborator choices. Existing panes remain available. User and workspace settings are supported; in a multi-folder workspace, project settings use the current project's folder scope. `herdr.agentDefaults` takes precedence over the defaults within a preset.

**Review bundled presets for your operating system, CLI version, and account.** They include example model lists and a macOS-specific DeepSeek command. Model IDs, effort levels, and custom commands are configurable, and their presence in a menu does not guarantee availability.

The catalog lists **24 native agent kinds checked against Herdr v0.9.5**. It is a versioned reference, not a list of CLIs installed or authenticated on your machine. Adding a preset changes the menu; install the agent software separately using the linked setup instructions.

### Herdr integrations

Integration actions use Herdr's native `integration.list`, `integration.install`, and `integration.uninstall` APIs. After a change, the extension queries the state again before reporting verified success.

These actions manage Herdr hooks or plugins for session and state integration. **They do not install or uninstall agent CLI software, and they do not download or delete model weights.**

Available actions depend on the connected Herdr version. See the [Herdr integration documentation](https://herdr.dev/tui/docs/integrations/) for each integration's behavior.

### Local skills

The Skills page shows metadata, agent, scope, path, and invocation for skill files found in supported local directories. You can search, filter, refresh, and open a `SKILL.md` file.

| Agent | Project directories | User directories |
| --- | --- | --- |
| Claude Code | `.claude/skills` | `$CLAUDE_CONFIG_DIR/skills`, defaulting to `~/.claude/skills`. |
| Codex | `.agents/skills` | `~/.agents/skills` and the compatible `$CODEX_HOME/skills` location, defaulting to `~/.codex/skills`. |
| Antigravity CLI | `.agents/skills` and the legacy `.agent/skills` location | `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, and `~/.gemini/skills`. |

Codex's `/etc/codex/skills` directory is also scanned. Project discovery uses the selected checkout's root. Plugins, managed configuration, account-synced skills, and extra directories may supply additional skills.

This is a local file inventory. Each agent's runtime decides which skills it loads and uses; the extension does not install, remove, or universally enable skills.

Herdr's own [operating skill](https://herdr.dev/tui/docs/agent-skill/) teaches agents to use the Herdr CLI. To read the version bundled with your installed Herdr binary:

```sh
herdr --skill
```

### Connection

Inspect the Herdr connection, socket path, collaboration Node.js command, configured Claude-mem URL, and workspace trust state. Use **Open VS Code settings** for the complete configuration editor.

## Additional workflows

### Task collaboration

Herdr Chat includes its own task-tracking workflow on top of Herdr. Enable it for a tab by selecting an agent and choosing the planner action. The selected agent receives the tab-specific collaboration entry; you can also copy that entry from the Collaboration view.

The extension records delegation targets, prompts, request IDs, reports, questions, and events. Select a related pane to inspect its progress.

The entry uses the bundled `dist/herdr-collab.cjs` CLI:

| Command | Purpose |
| --- | --- |
| `status` | Inspect the current task, requests, and participating panes. |
| `spawn PRESET_ID` | Create an agent in the same task tab using an enabled native-kind preset. |
| `delegate PANE_ID "task" --wait --timeout 180000` | Send work and wait for its explicit report. |
| `wait REQUEST_ID --timeout 180000` | Continue waiting for an existing request. |
| `report REQUEST_ID --revision N --status completed --text "result"` | Report completion, a failure, or a need for input. |
| `answer REQUEST_ID "reply" --wait` | Answer a clarification request and continue the same work. |
| `accept HANDOFF_ID` | Confirm that the designated successor accepts a planner handoff. |

Use the **complete entry copied from the UI**, including its connection, task, and generation arguments. The table shows command suffixes, not standalone shell commands. `--timeout` is in milliseconds, from 1 to 180000.

This protocol belongs to Herdr Chat. Native `herdr agent prompt` remains a separate Herdr command. A native `idle` or `done` state does not complete an extension request: the worker must report `completed`, `needs_input`, or `failed`. A timeout or uncertain delivery does not automatically resend work.

Automatic creation requires an enabled native `kind` preset. Custom shell agents can be started manually; participation in tracked collaboration requires Herdr to recognize the agent and a verifiable native session.

See the [collaboration CLI](src/collaboration/cli.ts) and [service](src/collaboration/service.ts) for the full command and lifecycle rules.

### Manual planner handoff

A handoff captures a checkpoint from the saved goal, messages, requests, reports, memory references, readable conversation excerpts, and Git state. It does not require the current planner to produce another summary.

The previous planner is paused, existing workers continue their requests, and the designated successor must explicitly `accept` before it becomes the active planner. Reports arriving during the handoff are retained for the successor.

Handoff is user-initiated. Automatic quota-triggered failover and conversion between different agents' native sessions are not implemented.

### Saving memories with Claude-mem

With an existing Claude-mem worker configured, choose **Save as memory** on a user or assistant message. Select part of the message first to save an excerpt, then edit the title and content.

Herdr Chat sends the text and source metadata to the worker without asking an agent to summarize it. It records a memory reference only after receiving a valid memory ID. Failed saves retain the draft; if delivery times out, check the worker before retrying.

The Memory view lists references saved through this extension for the current task. It does not browse the entire Claude-mem database. Ordinary chat and task collaboration do not require Claude-mem.

### History and execution scope

- Closed task tabs retain their stored collaboration records and memory references as read-only history. They do not become resumable native panes.
- One extension host owns a workspace's collaboration data at a time.
- The collaboration bridge uses local loopback. Agents must be able to access its connection file and endpoint; there is no cross-machine collaboration service.
- Native transcript files must be accessible to the extension host. If they cannot be read, the view falls back to terminal output.
- Restarting the extension preserves recorded requests and events, but does not restore old wait connections or replay uncertain work.

## Configuration reference

| Setting | Default | Purpose |
| --- | --- | --- |
| `herdr.socketPath` | Empty | Override the Herdr API socket path. |
| `herdr.transcriptLines` | `400` | Number of terminal lines used when a native transcript is unavailable. |
| `herdr.agentPresets` | Bundled presets | Complete list of launch presets and model/effort options. |
| `herdr.agentDefaults` | `{}` | Project defaults keyed by preset ID, overriding preset model/effort defaults. |
| `herdr.collaborationNodePath` | `node` | Node.js 20+ executable used by agents for the collaboration CLI. Reload the window after changing it. |
| `herdr.claudeMemUrl` | Empty | Override the Claude-mem worker URL. |
| `herdr.claudeMemSettingsPath` | Empty | Override the Claude-mem settings file; defaults to `~/.claude-mem/settings.json`. |

Claude-mem connection discovery reuses the existing worker's settings and environment variables, including `CLAUDE_MEM_WORKER_URL`, `CLAUDE_MEM_WORKER_HOST`, and `CLAUDE_MEM_WORKER_PORT`. The explicit extension URL takes priority. Remote workers require HTTPS, or access through local port forwarding. See the [Claude-mem client](src/memory/claudeMem.ts) for connection and authentication handling.

## Display language

The interface reads `vscode.env.language` when the extension starts:

| VS Code display language | Herdr Chat interface |
| --- | --- |
| English | English |
| Traditional Chinese (`zh-tw`) | Traditional Chinese |
| Other languages without a translation | English fallback |

Use **Configure Display Language** in VS Code and follow its restart instructions to change the interface language. User messages, agent output, custom names, and saved memory content retain their original text.

## Development

Use Node.js 24 and install dependencies with `npm ci`.

```sh
npm run typecheck
npm run build
npm test
npm run package
```

Run the build before packaging; the package script does not build automatically. Use `npm run watch` for continuous builds and `node dist/herdr-collab.cjs --help` for the collaboration CLI reference.

Automated checks cover configuration scopes, integration contracts, skill discovery, collaboration and handoff state, local transports, memory receipts, and webview behavior including drafts, queues, IME input, and scrolling. Tests use fixtures and mock services; they do not establish end-to-end compatibility with every Herdr, agent, or VS Code installation.

Runtime translations live in [src/l10n.ts](src/l10n.ts) and [src/l10n/](src/l10n/). Static command and configuration text uses [package.nls.json](package.nls.json) and [package.nls.zh-tw.json](package.nls.zh-tw.json). Add translations and matching tests when introducing interface text.

## Further reading

- [繁體中文 README](README.zh-TW.md)
- [Changelog](CHANGELOG.md)
- [Herdr documentation](https://herdr.dev/tui/docs/)
- [Herdr agent automation](https://herdr.dev/tui/docs/agent-automation/)
- [License file](LICENSE)
