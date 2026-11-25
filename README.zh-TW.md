# Herdr Chat

[English](README.md) | 繁體中文

在 VS Code 的次要側邊欄，與執行於 [Herdr](https://herdr.dev/tui/docs/) 的程式開發 agent 對話。瀏覽專案的 worktree、切換 agent pane、閱讀對話與終端機輸出，並管理 agent 的啟動設定。

Herdr 負責管理終端機程序、工作區、tab 與 pane。Herdr Chat 提供這些資源的 VS Code 操作介面，另外加入任務協作，以及將選取訊息儲存至既有 Claude-mem worker 的功能。

## 功能

- **Agent 對話：**有可讀紀錄時，顯示 Claude Code、Codex 與 Antigravity CLI 的原生對話；其他 agent 或無法取得紀錄時，改用終端機輸出。
- **Pane 操作：**切換 agent、檢視終端機輸出、在 Herdr 聚焦 pane，以及重新命名或關閉 tab 與 pane。
- **訊息輸入：**附加檔案、拖放檔案、貼上圖片，使用 `@` 檔案補全，以及瀏覽 `/` 指令與本機技能。
- **訊息佇列：**在 agent 工作時排入訊息，並可編輯、移除或立即送出。
- **Agent 設定：**在使用者或工作區範圍自訂啟動選項、模型 ID、effort 與啟動參數。
- **Herdr 整合：**透過 Herdr 原生 API 檢視、安裝、更新或移除整合。
- **本機技能：**瀏覽支援的本機技能目錄，並開啟原始 `SKILL.md` 檔案。
- **顯示語言：**自動跟隨 VS Code 的英文或繁體中文顯示語言。

[任務協作](#任務協作)與[儲存記憶](#使用-claude-mem-儲存記憶)是額外的工作流程。只有要為 tab 啟用協作時，才需要選擇規劃者。

## 執行需求

| 元件 | 需求 |
| --- | --- |
| VS Code | 1.105 或更新版本，且位於擴充功能支援的 VS Code 引擎版本範圍內。 |
| Herdr | 已安裝並執行，且 VS Code extension host 能存取它的 API socket。 |
| 專案 | 主要的 worktree、工作區與對話畫面需要開啟 Git 儲存庫；沒有儲存庫時仍可開啟設定。 |
| Agent CLI | 請另外安裝要使用的 agent，並完成它們的登入或認證。 |
| 協作 CLI | 使用擴充功能的協作流程時，agent 所在環境需要能執行 Node.js 20+。 |
| Claude-mem | 使用儲存記憶功能時，需要既有且可連線的 worker。 |

開發與測試請使用 **Node.js 24**，本儲存庫以此版本驗證。測試指令使用 `--experimental-strip-types`；Node.js 20 足以執行隨套件提供的協作 CLI，但無法執行這套測試。

## 安裝

從本儲存庫建置 VSIX：

```sh
git clone https://github.com/sugky7302/herdr-chat.git
cd herdr-chat
npm ci
npm run build
npm run package
```

在 VS Code 執行 **Extensions: Install from VSIX…**，選取產生的 `herdr-vscode-*.vsix` 檔案。套件檔名沿用擴充功能既有的 `herdr-vscode` 識別碼。

接著：

1. 安裝並啟動 [Herdr](https://herdr.dev/tui/docs/)。
2. 在 VS Code 開啟 Git 儲存庫。
3. 在次要側邊欄開啟 **herdr** 檢視。
4. 選取 worktree 及其 Herdr 工作區。尚無對應工作區時，使用畫面中的建立工作區操作。
5. 選取現有的 agent pane，或新增 agent。在 agent 的終端機完成認證與初次啟動提示。

如果未自動找到 socket，請設定 `herdr.socketPath`。解析順序為此設定、`HERDR_SOCKET_PATH`，最後是 `~/.config/herdr/herdr.sock`。

## 使用 Herdr

底層仍沿用 Herdr 的[原生概念](https://herdr.dev/tui/docs/concepts/)：工作區包含 tab，tab 包含終端機 pane。Pane 可以執行 agent、shell 或其他程序。

Herdr Chat 將選取的 Git worktree 對應到 Herdr 工作區。**對話**、**協作**與**記憶**頁共用目前選取的 tab；切換目前的 agent，會切換正在檢視的對話。擴充功能的任務紀錄依 tab 整理協作資料與記憶引用。

### 對話操作

| 動作 | 操作方式 |
| --- | --- |
| 送出訊息 | Enter。Agent 工作中時，訊息會排入佇列。 |
| 立即送出 | Windows／Linux 使用 Ctrl+Enter，macOS 使用 Cmd+Enter，或按立即送出按鈕。 |
| 中斷工作中的 agent | 補全選單關閉時按 Esc，或使用中斷操作。 |
| 尋找專案檔案 | 輸入 `@`。 |
| 尋找 agent 指令或本機技能 | 輸入 `/`。選取 Codex 技能時，會插入原生的 `$skill-name` 呼叫方式。 |
| 附加內容 | 使用附件按鈕、拖放檔案或貼上圖片。從 VS Code 檔案總管拖曳時請按住 Shift。 |

模型與 effort 的切換能力取決於設定的啟動選項及 agent CLI。啟動選項可以使用斜線指令範本，或 Codex 的互動式模型選單。變更會在下一則訊息傳送前套用。

當 agent 提供擴充功能可讀取的資料時，介面會顯示上下文與用量資訊。若要啟用額外的 Claude 用量顯示，請執行 **herdr: 啟用 Claude 用量顯示**。此操作會明確安裝 Claude 既有 `statusLine` 的包裝腳本，並建立備份；對應的 **herdr: 停用 Claude 用量顯示** 指令可還原設定。目前的包裝腳本需要 POSIX shell。

DeepSeek 對話會用圓形進度條顯示剩餘額度。所有幣別先換成同一種額度再加總。

換算用官方價目表隱含的比率。人民幣價是美元價的 6.67 倍，所以不需要外部匯率。百分比是**可用總額 ÷（可用總額 + 估算已用）**。

估算已用是本機 DSH 紀錄的 token 數乘官方單價。滑過圓圈可看各幣別餘額與換算後的金額。

金鑰來源依序為環境變數 `DEEPSEEK_API_KEY`、`~/.zshrc` 等 shell 啟動檔。

DeepSeek 沒有用量 API。估算花費只供參考，可能與實際扣款不同。

## 設定

按檢視標題列的**齒輪按鈕**，或執行 **herdr: 設定**。Herdr 未連線時，仍可使用設定頁。

### Agent 與模型

設定建立 agent 時要顯示哪些啟動選項。每個選項使用 Herdr 原生 `kind` 或自訂 shell `command`，兩者擇一。

可以編輯：

- 選項代號、顯示名稱，以及是否列入建立選單。
- 模型 ID、effort 值及其預設值。
- 啟動參數，以及模型與 effort 的參數範本。
- 對話中的切換指令與額外斜線指令。

停用選項會將它從新增 agent 與自動建立協作者的選單中移除，既有 pane 仍可使用。設定支援使用者與工作區範圍；多資料夾工作區的專案設定會使用目前專案的資料夾範圍。`herdr.agentDefaults` 優先於啟動選項內的預設值。

**請依作業系統、CLI 版本與帳號檢查內建選項。** 其中包含範例模型清單，以及 macOS 專用的 DeepSeek 指令。模型 ID、effort 與自訂指令都可調整；出現在選單中，不代表目前環境一定可用。

Catalog 列出**依 Herdr v0.9.5 核對的 24 種原生 agent**。這是有版本依據的參考清單，不是本機已安裝或已登入的 CLI 清單。加入啟動選項只會變更選單；請依連結中的設定說明另外安裝 agent 軟體。

### Herdr 整合

整合操作使用 Herdr 原生的 `integration.list`、`integration.install` 與 `integration.uninstall` API。變更後，擴充功能會再次查詢狀態，確認結果後才回報成功。

這些操作管理 Herdr 的 hooks 或 plugins，用於 session 與狀態整合。**它們不會安裝或解除安裝 agent CLI 軟體，也不會下載或刪除模型權重。**

可用操作依目前連線的 Herdr 版本而定。各整合的行為請參閱 [Herdr 整合文件](https://herdr.dev/tui/docs/integrations/)。

### 本機技能

Skills 頁顯示在支援的本機目錄中找到的技能檔案，包含中繼資料、agent、範圍、路徑與呼叫方式。可以搜尋、篩選、重新整理及開啟 `SKILL.md` 檔案。

| Agent | 專案目錄 | 使用者目錄 |
| --- | --- | --- |
| Claude Code | `.claude/skills` | `$CLAUDE_CONFIG_DIR/skills`，預設為 `~/.claude/skills`。 |
| Codex | `.agents/skills` | `~/.agents/skills`，以及保留相容的 `$CODEX_HOME/skills` 位置，預設為 `~/.codex/skills`。 |
| Antigravity CLI | `.agents/skills` 與舊版 `.agent/skills` 位置 | `~/.gemini/config/skills`、`~/.gemini/antigravity-cli/skills` 與 `~/.gemini/skills`。 |

另外也會掃描 Codex 的 `/etc/codex/skills` 目錄。專案探索使用目前選取的 checkout 根目錄。Plugins、受管理的設定、帳號同步技能及額外目錄可能提供其他技能。

這是一份本機檔案清單。實際載入與使用哪些技能，由各 agent 的 runtime 決定；擴充功能不會安裝、移除技能，也沒有對所有 agent 通用的技能啟用操作。

Herdr 自己的[操作技能](https://herdr.dev/tui/docs/agent-skill/)會教 agent 使用 Herdr CLI。若要閱讀目前安裝的 Herdr 執行檔隨附版本：

```sh
herdr --skill
```

### 連線

檢視 Herdr 連線、socket 路徑、協作 Node.js 指令、設定的 Claude-mem URL，以及工作區信任狀態。使用**開啟 VS Code 設定**進入完整的設定編輯器。

## 額外工作流程

### 任務協作

Herdr Chat 在 Herdr 之上提供自己的任務追蹤流程。選取 agent，再使用規劃者操作，即可為目前 tab 啟用協作。選取的 agent 會收到該 tab 專用的協作入口，也可以從協作頁複製入口。

擴充功能會記錄派工目標、提示內容、request ID、回報、問題與事件。選取相關 pane 即可查看進度。

協作入口使用隨套件提供的 `dist/herdr-collab.cjs` CLI：

| 指令 | 用途 |
| --- | --- |
| `status` | 檢視目前任務、request 與參與的 pane。 |
| `spawn PRESET_ID` | 使用已啟用的原生 kind 選項，在同一任務 tab 建立 agent。 |
| `delegate PANE_ID "task" --wait --timeout 180000` | 送出工作並等待明確回報。 |
| `wait REQUEST_ID --timeout 180000` | 繼續等待既有 request。 |
| `report REQUEST_ID --revision N --status completed --text "result"` | 回報完成、失敗或需要輸入。 |
| `answer REQUEST_ID "reply" --wait` | 回覆釐清要求，並繼續同一份工作。 |
| `accept HANDOFF_ID` | 由指定的接手者確認接受規劃者交接。 |

請使用**從介面複製的完整入口**，包含 connection、task 與 generation 參數。表格列的是接在入口後的指令，不是獨立可執行的 shell 指令。`--timeout` 單位為毫秒，範圍為 1 至 180000。

這套協定屬於 Herdr Chat；原生 `herdr agent prompt` 仍是另一個 Herdr 指令。原生 `idle` 或 `done` 狀態不會直接完成擴充功能的 request：worker 必須回報 `completed`、`needs_input` 或 `failed`。等待逾時或傳送結果不明時，不會自動重送工作。

自動建立 agent 需要已啟用的原生 `kind` 選項。自訂 shell agent 可以手動啟動；要參與可追蹤的協作，Herdr 必須能辨識該 agent，並提供可核對的原生 session。

完整指令與生命週期規則請參閱[協作 CLI](src/collaboration/cli.ts) 與 [service](src/collaboration/service.ts)。

### 手動交接規劃者

交接會從已儲存的目標、訊息、request、回報、記憶引用、可讀的對話片段與 Git 狀態組成 checkpoint，不需要目前的規劃者再產生一份摘要。

原規劃者會暫停，既有 worker 繼續處理原 request；指定的接手者必須明確執行 `accept`，才會成為現任規劃者。交接期間收到的回報會保留給接手者。

交接由使用者發起。目前沒有自動依額度切換的功能，也不會轉換不同 agent 的原生 session。

### 使用 Claude-mem 儲存記憶

設定既有的 Claude-mem worker 後，可以在使用者或助理訊息上選擇**保存成記憶**。若只想儲存片段，先選取訊息的一部分，再編輯標題與內容。

Herdr Chat 將文字與來源中繼資料送至 worker，不會請 agent 重新摘要。只有收到有效的記憶 ID 後，才會記錄記憶引用。儲存失敗時保留草稿；若傳送逾時，請先檢查 worker 再決定是否重試。

記憶頁列出目前任務透過本擴充功能儲存的引用，不會瀏覽整個 Claude-mem 資料庫。一般對話與任務協作都不需要 Claude-mem。

### 歷史紀錄與執行範圍

- 關閉任務 tab 後，已儲存的協作紀錄與記憶引用會保留為唯讀歷史，不會變成可恢復的原生 pane。
- 同一時間由一個 extension host 持有工作區的協作資料。
- 協作 bridge 使用本機 loopback。Agent 必須能存取其連線檔案與端點；目前沒有跨機器的協作服務。
- 原生對話檔案必須能由 extension host 存取。無法讀取時，畫面改用終端機輸出。
- 重新啟動擴充功能會保留已記錄的 request 與事件，但不會恢復舊的等待連線或重送結果不明的工作。

## 設定參考

| 設定 | 預設值 | 用途 |
| --- | --- | --- |
| `herdr.socketPath` | 空字串 | 指定 Herdr API socket 路徑。 |
| `herdr.transcriptLines` | `400` | 無法取得原生對話時，使用的終端機行數。 |
| `herdr.agentPresets` | 內建選項 | 完整的啟動選項清單，以及模型與 effort 選項。 |
| `herdr.agentDefaults` | `{}` | 依選項代號設定的專案預設值，優先於選項內的模型與 effort 預設值。 |
| `herdr.collaborationNodePath` | `node` | Agent 執行協作 CLI 使用的 Node.js 20+ 執行檔。變更後請重新載入視窗。 |
| `herdr.claudeMemUrl` | 空字串 | 指定 Claude-mem worker URL。 |
| `herdr.claudeMemSettingsPath` | 空字串 | 指定 Claude-mem 設定檔，預設為 `~/.claude-mem/settings.json`。 |

Claude-mem 連線探索沿用既有 worker 的設定與環境變數，包含 `CLAUDE_MEM_WORKER_URL`、`CLAUDE_MEM_WORKER_HOST` 與 `CLAUDE_MEM_WORKER_PORT`。擴充功能中明確設定的 URL 優先使用。遠端 worker 需要 HTTPS，或透過本機連接埠轉送存取。連線與認證處理請參閱 [Claude-mem client](src/memory/claudeMem.ts)。

## 顯示語言

擴充功能啟動時，介面會讀取 `vscode.env.language`：

| VS Code 顯示語言 | Herdr Chat 介面 |
| --- | --- |
| 英文 | 英文 |
| 繁體中文（`zh-tw`） | 繁體中文 |
| 尚未提供翻譯的其他語言 | 回退到英文 |

在 VS Code 使用 **Configure Display Language**，並依提示重新啟動，即可變更介面語言。使用者訊息、agent 輸出、自訂名稱與已儲存的記憶內容會保留原文。

## 開發

使用 Node.js 24，並以 `npm ci` 安裝相依套件。

```sh
npm run typecheck
npm run build
npm test
npm run package
```

打包前請先建置；package 指令不會自動建置。使用 `npm run watch` 持續建置，或執行 `node dist/herdr-collab.cjs --help` 查看協作 CLI 參考。

自動化檢查涵蓋設定範圍、整合 API 契約、技能探索、協作與交接狀態、本機 transport、記憶保存回應，以及 webview 的草稿、佇列、輸入法與捲動行為。測試使用 fixture 與模擬服務，並不代表已完成每種 Herdr、agent 或 VS Code 安裝環境的端到端相容性驗證。

執行階段翻譯位於 [src/l10n.ts](src/l10n.ts) 與 [src/l10n/](src/l10n/)。靜態命令與設定文字使用 [package.nls.json](package.nls.json) 及 [package.nls.zh-tw.json](package.nls.zh-tw.json)。新增介面文字時，請一併補上翻譯與對應測試。

## 延伸閱讀

- [English README](README.md)
- [版本紀錄](CHANGELOG.md)
- [Herdr 文件](https://herdr.dev/tui/docs/)
- [Herdr agent 自動化](https://herdr.dev/tui/docs/agent-automation/)
- [授權檔案](LICENSE)
