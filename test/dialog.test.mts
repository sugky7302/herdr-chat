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

import { readFileSync } from 'node:fs';
import { parsePrompt } from '../src/codexMenu.ts';

test('解析 Claude 提問畫面：標題、問題、說明與分隔線後的選項', () => {
  const screen = readFileSync(new URL('./fixtures-ask-screen.txt', import.meta.url), 'utf8');
  const prompt = parsePrompt(screen);
  assert.equal(prompt.title, '☐ 資料庫');
  assert.equal(prompt.question, '請問您想用哪一種資料庫？');
  assert.deepEqual(prompt.options.map((o) => o.text), ['PostgreSQL', 'MySQL', 'MongoDB', 'Type something.', 'Chat about this']);
  assert.match(prompt.options[0].description ?? '', /^關聯式資料庫/);
  assert.equal(prompt.options[0].highlighted, true);
});
