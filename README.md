# herdr Agents（VS Code 擴充功能）

在 VS Code 右側邊欄顯示 herdr 在目前專案的狀態，並可以直接與 agent 對話。

## 對應方式

- 一個 git 專案對應一個 herdr workspace。上方選單可以切換 worktree（分支），也可以新增 worktree。
- 一個 tab 是一個對話。進入 tab 後顯示其中的 agent，點選 agent 後顯示對話頁。
- 右上角「歷史紀錄」列出所有 tab；「＋」新增 agent。

## 對話頁

- Claude 與 Codex 讀取各自的原生對話紀錄（`~/.claude/projects`、`~/.codex/sessions`），顯示成對話泡泡。
- 其他 agent 顯示終端機文字。
- agent 等待回應（例如權限確認）時，會顯示終端機畫面與按鍵按鈕。
- 模型與 effort 選單在下一則訊息送出前生效：
  - Claude：送出 `/model <模型>` 與 `/effort <effort>`。
  - Codex：操作 `/model` 選單，最後按 `s`，只套用到目前 session，不會改 `~/.codex/config.toml`。

## 設定

- `herdr.agentPresets`：新增 agent 的選項。可以新增自己的選項（`kind` 用 herdr 支援的種類，或用 `command` 執行任意指令）。
- `herdr.agentDefaults`：每個專案的預設模型與 effort。寫在專案的 `.vscode/settings.json`：

  ```json
  { "herdr.agentDefaults": { "claude": { "model": "opus", "effort": "high" }, "codex": { "model": "gpt-6.1-sol", "effort": "xhigh" } } }
  ```

- `herdr.socketPath`：herdr socket 路徑，預設自動偵測。

## 開發

```sh
npm install
npm run build      # 產生 dist/
npm test           # 單元測試
npm run package    # 產生 .vsix
```
