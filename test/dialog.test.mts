import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDialog } from '../src/codexMenu.ts';
import { parseClaude, parseCodex } from '../src/transcript/parse.ts';

test('解析 Claude 權限確認畫面的選項', () => {
  const screen = `我會執行：
1. 先讀取設定
2. 再修改程式
╭──────────────────────────────────────╮
│ Bash command                         │
│   rm -rf dist                        │
│ Do you want to proceed?              │
│ ❯ 1. Yes                             │
│   2. Yes, and don't ask again        │
│   3. No, and tell Claude what to do  │
╰──────────────────────────────────────╯`;
  assert.deepEqual(parseDialog(screen), [
    { number: 1, text: 'Yes', highlighted: true },
    { number: 2, text: "Yes, and don't ask again", highlighted: false },
    { number: 3, text: 'No, and tell Claude what to do', highlighted: false },
  ]);
});

test('沒有游標的編號清單不算選項', () => {
  assert.deepEqual(parseDialog('1. 讀取\n2. 修改\n'), []);
});

test('Claude 用量：依訊息 id 只計算一次', () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
  const lines = [
    { type: 'assistant', message: { id: 'a', model: 'm', usage, content: [{ type: 'thinking' }] } },
    { type: 'assistant', message: { id: 'a', model: 'm', usage, content: [{ type: 'text', text: 'x' }] } },
    { type: 'assistant', message: { id: 'b', model: 'm', usage: { ...usage, output_tokens: 20 }, content: [{ type: 'text', text: 'y' }] } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const parsed = parseClaude(lines);
  assert.equal(parsed.usage?.contextTokens, 1130);
  assert.equal(parsed.usage?.totalTokens, 1115 + 1130);
  assert.equal(parsed.usage?.outputTokens, 25);
});

test('Codex 用量：讀取上下文上限與額度', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 5000, output_tokens: 300 }, last_token_usage: { total_tokens: 1200 }, model_context_window: 475000 },
      rate_limits: { primary: { used_percent: 5, window_minutes: 10080 } },
    },
  });
  assert.deepEqual(parseCodex(line).usage, {
    contextTokens: 1200,
    contextWindow: 475000,
    totalTokens: 5000,
    outputTokens: 300,
    rateLimitPercent: 5,
    rateLimitWindowMinutes: 10080,
  });
});

test('解析沒有編號的選項（Claude 信任畫面）', () => {
  const screen = ` Quick safety check: Is this a project you created or
 one you trust?
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
  assert.deepEqual(parseDialog(screen), [
    { number: 1, text: 'No, exit', highlighted: true },
    { number: 2, text: 'Yes, I trust this folder', highlighted: false },
  ]);
});

test('Claude 畫面上的多行使用者訊息不會被誤判成選項', () => {
  const screen = `❯ 我不喜歡現在的對話、協作、記憶 tab，應該改成下拉式選單
  或者其他浮動式對話框，然後放在重新對話按鈕的左邊。另外
  ，agent的呈現我比較喜歡以前的樣子，點一下agent再進入對
  話

● 已完成修改。

────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────`;
  assert.deepEqual(parseDialog(screen), []);
});

import { readFileSync } from 'node:fs';
import { parsePrompt } from '../src/codexMenu.ts';
import { parseStatus } from '../src/claudeUsage.ts';

test('解析 Claude statusline 用量 JSON（5 小時、7 天與上下文上限）', () => {
  const json = JSON.stringify({
    session_id: '6abd340a-b4aa-4fa1-b667-8c717aa962d4',
    context_window: { context_window_size: 1000000, used_percentage: 38 },
    rate_limits: {
      five_hour: { used_percentage: 100, resets_at: 1795608600 },
      seven_day: { used_percentage: 21, resets_at: 1795856400 },
    },
  });
  assert.deepEqual(parseStatus(json, 12345), {
    fiveHour: { usedPercent: 100, resetsAt: 1795608600 },
    sevenDay: { usedPercent: 21, resetsAt: 1795856400 },
    contextUsedPercent: 38,
    contextWindow: 1000000,
    updatedAt: 12345,
  });
});

test('解析 Claude 提問畫面：標題、問題、說明與分隔線後的選項', () => {
  const screen = readFileSync(new URL('./fixtures-ask-screen.txt', import.meta.url), 'utf8');
  const prompt = parsePrompt(screen);
  assert.equal(prompt.title, '☐ 資料庫');
  assert.equal(prompt.question, '請問您想用哪一種資料庫？');
  assert.deepEqual(prompt.options.map((o) => o.text), ['PostgreSQL', 'MySQL', 'MongoDB', 'Type something.', 'Chat about this']);
  assert.match(prompt.options[0].description ?? '', /^關聯式資料庫/);
  assert.equal(prompt.options[0].highlighted, true);
});
