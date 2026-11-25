# herdr Agents（VS Code 擴充功能）

在 VS Code 右側邊欄顯示 herdr 在目前專案的狀態，並可以直接與 agent 對話。

## 對應方式

- 一個 git 專案對應一個 herdr workspace。上方選單可以切換 worktree（分支），也可以新增 worktree。
- 一個 tab 是一個對話。進入 tab 後顯示其中的 agent，點選 agent 後顯示對話頁。
- 右上角「歷史紀錄」列出所有 tab；「＋」新增 agent。

## 對話頁

- 樣式模仿 Copilot Chat：每則訊息上方顯示「你」或 agent 名稱，工具呼叫顯示成一行摘要。
- Claude 與 Codex 讀取各自的原生對話紀錄（`~/.claude/projects`、`~/.codex/sessions`）。其他 agent 顯示終端機文字。
- 往上捲動後，右下角出現「捲到最新訊息」按鈕。
- 輸入框：
  - 📎 附加檔案；也可以拖曳檔案或貼上圖片。從 VS Code 檔案總管拖曳時請按住 Shift。
  - `@` 搜尋專案檔案；`/` 列出該 agent 的指令（含 skill 與自訂指令）。清單不完整時，點「從 agent 更新清單」。
  - 模型與 effort 選單在下一則訊息送出前生效：Claude 送出 `/model`、`/effort`；Codex 操作 `/model` 選單並按 `s`，只套用到目前 session。
  - 右側顯示上下文用量。滑過可看累計 token 與方案額度（Codex 才有上下文上限與額度）。
- agent 工作中：Enter 把訊息加入佇列，完成後依序送出；⌘/Ctrl+Enter 或 ⚡ 立即插入目前的回合；Esc 中斷。
- agent 跳出確認畫面時，選項顯示成按鈕，點選即可回應。

## tab 與 pane

- 歷史紀錄與 tab 頁的每一列，滑過時出現「重新命名」與「關閉」按鈕。
- 「＋ pane」可以新增 agent 或空白終端機。

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
