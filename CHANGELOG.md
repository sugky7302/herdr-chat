# 版本紀錄

## 0.3.0 — 2026-11-25

### 問題內的協作畫面

- 一個 Herdr tab 對應一個問題，提供「對話／協作／記憶」三頁。
- 問題標題、規劃者與交接入口跨頁保留；agent 切換器只出現在對話頁。
- 協作頁顯示原始派工方向、request ID、實際回報、釐清問題與事件，並可跳至相關 pane。
- 可以直接派工，或複製該問題的完整協作入口給規劃者。
- 原有中文 IME、草稿、排隊編輯、附件與捲動行為保留並納入 DOM 回歸測試。

### 規劃者與協作 CLI

- 新增隨擴充功能打包的 `dist/herdr-collab.cjs`，提供 `status`、`spawn`、`delegate`、`wait`、`report`、`answer`、`accept`。
- `delegate --wait --timeout 180000` 使用持久化的 request 與 worker 明確回報；原生 `idle`／`done` 不直接代表工作完成。
- worker 使用派工訊息中的 `report --revision` 指令，回報 `completed`、`needs_input` 或 `failed`。
- 原生 `herdr agent prompt` 指令保持原樣；協作橋接在 extension host 內執行，不新增獨立 daemon。
- 檢查角色、generation、原生 session 與 agent 就緒狀態；同一 worker session 保留一個尚未結束的 request。
- 傳送結果不明、等待逾時與重啟不會自動重送工作。規劃者入口傳送未確認時，提供複製入口與 `status` 恢復流程。

### 記憶保存

- 真實對話訊息旁新增「保存成記憶」，可帶入整段或選取文字，再編輯標題與內容。
- 直接呼叫既有 Claude-mem worker 的保存 API，使用問題綁定的 checkout／cwd 並記錄原始來源，不呼叫 LLM。
- 只有收到有效的真實記憶 ID 才顯示成功；錯誤時保留草稿。
- 問題的記憶頁列出本擴充功能為此問題保存的引用與來源，尚未提供整個 Claude-mem 資料庫的全域瀏覽。

### 規劃者交接與封存

- 使用者可手動交接給同一問題的閒置 agent，或新建可自動協作的 preset。
- checkpoint 由既有目標、對話片段、Git 狀態、request、回報與記憶組成，不依賴舊規劃者額外產生摘要。
- 交接開始即暫停舊規劃權；新 agent 必須從自己的 pane 執行 CLI `accept`，才完成角色切換。
- worker 沿用原 request，交接期間回報先保存於問題，接手後交付；原始派工來源不改寫。
- 舊規劃者對話保留唯讀與保存記憶入口。已關閉問題的協作與記憶可在歷史頁唯讀查看。
- 目前沒有自動偵測額度並切換規劃者，也不會轉換或搬移不同產品的原生 session。

### 設定與執行條件

- 新增 `herdr.claudeMemUrl`、`herdr.claudeMemSettingsPath`、`herdr.collaborationNodePath`。
- 協作 CLI 需要 Node.js 20+；開發測試另外需要支援 `--experimental-strip-types` 的 Node.js。
- 協作 API 僅使用本機 loopback 與私有 connection 檔；同一 VS Code 工作區只允許一個 extension host 擁有協作資料。
- 自動建立協作者只提供 Herdr 原生 `kind` preset；自訂 shell 指令需先被 Herdr 識別，並具備可核對的 session。

### 驗證範圍

- 新增 collaboration service、CLI／bridge、Claude-mem client 與 webview 行為測試。
- 開發流程包含 `npm run typecheck`、`npm run build`、`npm test`。
- 自動化測試採測試替身與本機 transport，未宣稱已完成真實 Herdr、agent、Claude-mem 與 VS Code 的端到端驗證。
