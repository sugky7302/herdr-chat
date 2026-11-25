# herdr Agents（VS Code 擴充功能）

在 VS Code 右側邊欄與 Herdr agent 對話，查看同一個問題的分工、等待、回報與記憶。

**0.3.0：一個 tab 就是一個問題，pane 是參與這個問題的 agent。** 可以讓 Claude 擔任規劃者，建立或呼叫其他 agent；也可以在 Claude 無法繼續時，把規劃工作交接給另一個 agent。

## 安裝與準備

1. 安裝並啟動 Herdr，確認 VS Code 所在環境可以連到它的 API socket。
2. 開啟 git 專案。擴充功能會對應目前的 worktree 與 Herdr workspace；尚未建立時，依側邊欄提示建立 workspace。
3. 透過 VS Code 的「從 VSIX 安裝」安裝已建置的套件，或依下方開發步驟自行產生 `.vsix`。
4. 啟動要使用的 agent，完成它本身的登入、初次設定與權限確認。

協作 CLI 需要 agent 所在環境能執行 **Node.js 20+**。預設使用 `node`；若 agent 的 PATH 找不到 Node，可設定 `herdr.collaborationNodePath` 的絕對路徑，然後重新載入 VS Code 視窗。

「保存成記憶」使用你既有的 Claude-mem worker。它是獨立功能；一般聊天與 agent 協作不需要先設定 Claude-mem。

## 對應方式

- git 專案中的每個 worktree 對應其 Herdr workspace。上方選單可以切換 worktree（分支），也可以新增 worktree。
- 一個 tab 是一個問題；同一個 tab 內的 pane 是它的規劃者、實作者或檢查者。
- 問題內有「對話／協作／記憶」三頁。問題標題、規劃者與交接入口跨頁保留。
- agent 切換器只出現在「對話」。切換 agent 只切換對話內容，不會切換問題的協作紀錄或記憶。
- 「歷史紀錄」可以切換目前的問題，也能讀取目前 worktree 已封存問題的協作與記憶。

## 對話頁

- 保留 Copilot Chat 風格的訊息與輸入框，工具呼叫顯示成一行摘要。
- Claude 與 Codex 讀取各自的原生對話紀錄（`~/.claude/projects`、`~/.codex/sessions`）。其他 agent 顯示終端機文字。
- 往上捲動後，右下角出現「捲到最新訊息」按鈕。
- 輸入框：
  - 📎 附加檔案；也可以拖曳檔案或貼上圖片。從 VS Code 檔案總管拖曳時請按住 Shift。
  - `@` 搜尋專案檔案；`/` 列出該 agent 的指令（含 skill 與自訂指令）。清單不完整時，點「從 agent 更新清單」。
  - 模型與 effort 選單在下一則訊息送出前生效：Claude 送出 `/model`、`/effort`；Codex 操作 `/model` 選單並按 `s`，只套用到目前 session。
  - 右側顯示可取得的上下文用量。滑過可看累計 token、上下文上限與方案額度；實際欄位依 agent 提供的資料而定。
- agent 工作中：Enter 把訊息加入佇列，完成後依序送出；⌘/Ctrl+Enter 或 ⚡ 立即插入目前的回合；Esc 中斷。
- agent 跳出確認畫面時，選項顯示成按鈕，點選即可回應。
- 修改佇列訊息時會保留附件與排隊順序。背景狀態更新不應中斷中文組字、目前草稿或閱讀歷史訊息的位置。
- 對話工具列可顯示終端機畫面與操作按鍵，也可以直接在 Herdr 聚焦目前的 pane。

需要顯示 Claude 額度時，可從命令選擇區執行「herdr: 啟用 Claude 用量顯示」。此功能會先取得確認，再備份與包裝既有的 Claude `statusLine`；「herdr: 停用 Claude 用量顯示」可還原。

## 讓規劃者指揮其他 agent

1. 在「對話」選擇要擔任規劃者的 agent，等它完成啟動與目前回合，再按「以 … 規劃」。
2. Herdr 會把這個問題專用的協作入口送給規劃者。入口包含 task、generation 與本機連線資料；協作頁也提供「複製協作入口」。
3. 規劃者可以用 `spawn` 在同一問題新增 agent，再用 `delegate` 派工；也能對同一 tab 裡已就緒的 agent 派工。使用者可在協作頁的「派工給 agent」直接發起工作。
4. 切到任一 agent 的對話即可查看進度。協作頁保留原始派工者、目標、request ID、提示內容、回報與時間線，相關 pane 名稱可點選跳轉。

自動建立 agent 僅提供設定了 Herdr 原生 `kind` 的 preset。以任意 `command` 啟動的自訂 shell preset 仍可用於原有聊天；要參與自動協作，必須先讓 Herdr 識別它的 agent 與原生 session。每個 worker session 同時只能有一個尚未結束的協作 request。

### 完成要有明確回報

派工訊息會附上 worker 應執行的完整 `report` 指令。worker 必須回報以下其中一個狀態，並提供實際修改、測試、失敗或剩餘工作：

| 回報 | 用途 |
| --- | --- |
| `completed` | 已完成指定工作，附上結果與驗證證據。 |
| `needs_input` | 需要釐清條件；規劃者或使用者用 `answer` 回覆同一個 request。 |
| `failed` | 無法完成，交代原因與已完成的部分。 |

原生 agent 的 `idle` 或 `done` 只代表它的執行狀態，**不會直接把協作 request 標為完成**。原生回合結束但尚未明確回報時，協作頁顯示「等待明確回報」。原生權限或選單造成的 `blocked`，需要到該 pane 處理；這和 worker 主動提出的釐清問題不同。

`--wait` 等到完成、失敗、需要輸入、等待逾時或規劃者改變時返回。逾時與連線中斷表示結果尚未確認；查看 `status`、原 pane 或繼續 `wait`，不會自動重送原工作。CLI 的 `ok: true` 代表該次 RPC 成功，仍須閱讀回傳的 `reason` 與 request 狀態。

### 協作 CLI 與原生 Herdr 的分工

本擴充功能**沒有改寫原生 `herdr agent prompt` 指令**，也沒有替它新增 `--until done` 語意。協作使用隨擴充功能打包的 `dist/herdr-collab.cjs`，由本機 bridge 保存 request、路由與明確回報；底層仍透過 Herdr API 與 agent 溝通。

完整指令的結構如下。路徑與大寫值是佔位示意，實際使用請保留 UI 複製入口中的 connection、task 與 generation：

```sh
node /path/to/extension/dist/herdr-collab.cjs \
  --connection /path/to/connection.json \
  --task TASK_ID \
  --generation GENERATION \
  delegate TARGET_PANE_ID "Refactor the auth module and run tests" \
  --wait --timeout 180000
```

同一個入口後面可接以下命令：

| 命令 | 行為 |
| --- | --- |
| `status` | 讀取本問題與 agent 的目前狀態。 |
| `spawn PRESET_ID` | 在本問題建立 agent；可加 `--model`、`--effort`。建立後仍需核對原生 session 與就緒狀態。 |
| `delegate PANE_ID "工作內容" --wait --timeout 180000` | 派工並等待明確回報；可用 `--request-id` 指定這次要求的 ID。 |
| `wait REQUEST_ID --timeout 180000` | 繼續等待同一份工作，不重新派工。 |
| `answer REQUEST_ID "答覆" --wait` | 回覆釐清問題，沿用 request ID 並進入下一個 revision。 |
| `report REQUEST_ID --revision N --status completed --text "結果"` | worker 的明確回報；status 亦可為 `needs_input` 或 `failed`。 |
| `accept HANDOFF_ID` | 指定的新規劃者確認已讀交接資料並接手。 |

`--timeout` 單位為毫秒，範圍為 1 至 180000，預設 180000。worker 的 request ID、generation 與 `report --revision` 由每次派工或續接訊息產生，應直接使用該訊息中的指令。CLI 讀取呼叫 pane 的 `HERDR_PANE_ID`，服務會核對 task、角色、原生 session 與 generation；不要用另一個 pane 的身分執行。

命令參數以 [CLI 入口](src/collaboration/cli.ts) 為準；角色、等待與回報規則實作於 [collaboration service](src/collaboration/service.ts)。

如果「協作入口傳送結果未確認」，UI 會保留不確定狀態並提供「複製協作入口」。把入口貼回原規劃者，執行 `status` 核對後繼續；畫面不會把送達不明當成成功，也不提供自動重送。

## 保存成記憶

在 user 或 assistant 的真實訊息旁按「保存成記憶」。若已選取該訊息內的一段文字，編輯區會帶入選取內容；否則帶入整段訊息。

可以修改標題與內容。專案範圍依問題綁定的 checkout／cwd 決定；原始 pane、訊息角色、訊息位置與來源文字隨記憶保存，不會因切到另一個 agent 而改變。

保存直接呼叫 Claude-mem 的 `/api/memory/save`，不需要模型重新摘要，因此 Claude 額度用完時仍可操作。只有 worker 回傳有效的真實記憶 ID 後，UI 才顯示成功。連線、認證、來源驗證或保存失敗時保留編輯草稿；修正問題後可重試。若傳送已發出但回應逾時，先到 Claude-mem 核對是否已有紀錄，再決定是否重試。

「記憶」頁目前列出**本問題經本擴充功能保存的引用**，包含實際 Claude-mem ID、內容、專案與來源。它不是整個 Claude-mem 資料庫的瀏覽器，也不會自動把其他工具建立的記憶全部匯入。

連線解析與保存回應的驗證見 [Claude-mem client](src/memory/claudeMem.ts)。

## 手動交接規劃者

Claude 額度不足、agent 無法繼續，或你想換一個規劃者時，使用問題上方的「交接規劃者」。目前由使用者發起交接，**沒有自動偵測額度並自動切換**。

1. 查看由擴充功能組成的 checkpoint，再選擇同一問題的閒置 agent，或新建可自動協作的 preset。
2. 送出後，舊規劃者的規劃權立即暫停；擴充功能會停止可核對到的舊規劃回合，既有 worker 繼續原 request。
3. 新規劃者收到 checkpoint 與完整 `accept HANDOFF_ID` 指令。它必須先讀取資料，再從自己的 pane 執行 CLI `accept`。
4. 只有服務收到有效的 `accept`，UI 才顯示新規劃者已接手。交接期間的回報先保存在本問題，接手後一起交付；後續回報改由新規劃者收取。

checkpoint 使用已保存的目標、要求、派工、回報、記憶，以及可讀的原生對話片段與當下 Git 資訊；包含資料來源與擷取時間。它不依賴已耗盡額度的 Claude 再寫摘要，也不會把 Claude 的原生 session 轉換成 Codex session。較長的原文會截短，agent 接手後仍須核對實際檔案與測試結果。

原始「誰派給誰」的紀錄保持不變。舊規劃者 pane 保留唯讀對話與保存記憶入口；若之後透過另一次交接重新成為現任規劃者，才恢復該角色。交接失敗或尚未確認時，不會假裝新規劃者已接手，舊規劃權仍保持暫停。失敗後可重新查看快照、選擇接手者再送出交接，原 worker 工作不重送。

## tab 與 pane

- 歷史紀錄中的問題可重新命名或關閉；對話工具列可重新命名、關閉目前 pane。
- 「＋ agent」或右上角新增入口可以建立 agent，也保留新增空白終端機的功能。
- 問題關閉後，擴充功能已保存的協作事件與記憶引用會封存；歷史頁可唯讀查看。目前不會還原已關閉的原生 pane，也不會在封存問題繼續派工。

## 執行範圍與目前限制

- **單一 owner：**同一 VS Code 工作區的協作資料由一個 extension host 寫入。另一個視窗若遇到 owner 鎖，請回到原視窗操作。
- **本機協作 API：**bridge 由 extension host 啟動，只綁定 `127.0.0.1`，使用私有 connection 檔與 token；不是額外的常駐 daemon。CLI 與 agent 需要能存取同一份 connection 檔及本機端點，目前沒有跨機器的協作服務。
- **原生就緒限制：**啟用、派工與交接時，服務會核對原生 session 和 `idle`／`done`；工作中、等待權限或狀態未知的 agent 不會被視為已就緒。UI 的既有目標選單目前只列閒置 agent。
- **重啟不重播：**擴充功能重啟會保留 request、事件、交接與記憶引用，但無法恢復舊的等待連線；未確認的工作不會自動重送。重新開啟後複製目前的協作入口，先用 `status` 核對。
- **完成與驗收分開：**worker 的 `completed` 是它的明確回報；請依回報的差異、測試與證據驗收實際工作。

## 設定

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| `herdr.claudeMemUrl` | 空字串 | Claude-mem worker 位址。留空沿用既有環境變數或設定檔。 |
| `herdr.claudeMemSettingsPath` | 空字串 | 留空使用 `~/.claude-mem/settings.json`；讀取既有 worker 設定與本機 API token。 |
| `herdr.collaborationNodePath` | `node` | agent 執行協作 CLI 的 Node.js 20+ 執行檔；變更後重新載入 VS Code 視窗。 |
| `herdr.socketPath` | 空字串 | Herdr socket 路徑。留空依序採用 `HERDR_SOCKET_PATH`、`~/.config/herdr/herdr.sock`。 |
| `herdr.transcriptLines` | `400` | 沒有可讀原生對話時，讀取的終端機行數。 |
| `herdr.agentPresets` | 內建 preset | 可新增 Herdr `kind` 或任意 shell `command`；自動建立協作者只支援 `kind` preset。 |
| `herdr.agentDefaults` | `{}` | 每個專案的預設模型與 effort。 |

Claude-mem 位址優先採用 `herdr.claudeMemUrl`，接著是 `CLAUDE_MEM_WORKER_URL`、既有 `CLAUDE_MEM_WORKER_HOST`／`CLAUDE_MEM_WORKER_PORT` 設定。環境變數優先於設定檔；都未提供時使用本機 worker 的預設位址與每個使用者的預設 port。已設定的本機 token 只會傳給符合既有設定來源的 worker，不會借用模型供應商的 API key。

協作 bridge 限本機；Claude-mem 的位址另可設定為 HTTPS worker，或使用本機 port forwarding。遠端 HTTP worker 不受支援。

專案的預設模型與 effort 可寫在 `.vscode/settings.json`：

```json
{
  "herdr.agentDefaults": {
    "claude": { "model": "opus", "effort": "high" },
    "codex": { "model": "gpt-6.2-sol", "effort": "xhigh" }
  }
}
```

## 開發

協作 CLI 的執行需求為 Node.js 20+。開發測試另外需要支援 `--experimental-strip-types` 的 Node.js 版本；目前的 `npm test` 指令不能直接使用 Node.js 20 執行。

```sh
npm ci
npm run typecheck  # TypeScript 檢查
npm run build      # 產生 extension、webview 與 dist/herdr-collab.cjs
npm test           # 單元、DOM 與本機 transport 測試
npm run package    # 產生 .vsix
```

開發時可用 `npm run watch` 持續建置。查看協作 CLI 的 JSON 使用說明：

```sh
node dist/herdr-collab.cjs --help
```

自動化測試涵蓋 task 狀態、明確回報、交接、session 核對、owner 鎖、CLI 與本機 HTTP transport、Claude-mem receipt 驗證，以及 webview 的範圍、草稿、IME、佇列與捲動。Herdr host 與 Claude-mem HTTP 回應使用測試替身；這不等於已完成真實 Herdr、Claude／Codex、Claude-mem 與 VS Code 視窗的端到端驗證。

版本變更見 [CHANGELOG.md](CHANGELOG.md)。
