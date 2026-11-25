import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CNY_PER_USD, costOfLog, estimateCost, isPeakHour, modelClass, parseShellAssignment, remainingPercent, toUsd, totalUsdOf } from '../src/deepseekUsage.ts';

// 2026-11-23 是週一。所有時間都用 UTC 表示。
const MONDAY_02 = Date.UTC(2026, 10, 23, 2, 0);
const MONDAY_12 = Date.UTC(2026, 10, 23, 12, 0);
const SATURDAY_02 = Date.UTC(2026, 10, 28, 2, 0);

test('高峰時段是 UTC 週一至週五的 01:00–04:00 與 06:00–10:00', () => {
  assert.equal(isPeakHour(MONDAY_02), true);
  assert.equal(isPeakHour(Date.UTC(2026, 10, 23, 9, 59)), true);
  assert.equal(isPeakHour(Date.UTC(2026, 10, 23, 10, 0)), false);
  assert.equal(isPeakHour(Date.UTC(2026, 10, 23, 5, 0)), false);
  assert.equal(isPeakHour(Date.UTC(2026, 10, 23, 0, 59)), false);
  assert.equal(isPeakHour(SATURDAY_02), false, '週末全時段都是離峰');
  assert.equal(isPeakHour(Number.NaN), false);
});

test('模型名稱對應價目表，舊名沿用 Flash 價格', () => {
  assert.equal(modelClass('deepseek-flash'), 'flash');
  assert.equal(modelClass('deepseek-v4-flash'), 'flash');
  assert.equal(modelClass('deepseek-v4-flash-vision-exp'), 'flash');
  assert.equal(modelClass('deepseek-v4-pro'), 'pro');
  assert.equal(modelClass(undefined), 'flash');
});

test('Flash 單價：離峰與高峰分別計價', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  assert.ok(Math.abs(estimateCost(usage, 'deepseek-flash', MONDAY_12) - (0.15 + 0.6 + 0.003)) < 1e-9);
  assert.ok(Math.abs(estimateCost(usage, 'deepseek-flash', MONDAY_02) - (0.3 + 1.2 + 0.006)) < 1e-9);
});

test('Pro 單價與快取寫入不計價', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
  assert.ok(Math.abs(estimateCost(usage, 'deepseek-v4-pro', MONDAY_12) - (0.66 + 1.98)) < 1e-9);
  assert.equal(estimateCost({}, 'deepseek-flash', MONDAY_12), 0);
});

test('紀錄檔逐筆加總，壞行跳過', () => {
  const lines = [
    JSON.stringify({ type: 'assistant/message', time: MONDAY_12, data: { usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: { source: { model: 'deepseek-flash' } } } }),
    '{壞行',
    JSON.stringify({ type: 'assistant/message', time: MONDAY_02, data: { usage: { inputTokens: 0, outputTokens: 1_000_000 }, message: { source: { model: 'deepseek-flash' } } } }),
    JSON.stringify({ type: 'user/message', data: { content: [] } }),
  ].join('\n');
  assert.ok(Math.abs(costOfLog(lines) - (0.15 + 1.2)) < 1e-9);
});

test('從 shell 啟動檔取出金鑰', () => {
  assert.equal(parseShellAssignment('export DEEPSEEK_API_KEY="sk-abc"'), 'sk-abc');
  assert.equal(parseShellAssignment("DEEPSEEK_API_KEY='sk-def'"), 'sk-def');
  assert.equal(parseShellAssignment('  export DEEPSEEK_API_KEY=sk-ghi  # 註解'), 'sk-ghi');
  assert.equal(parseShellAssignment('OTHER=1\nexport DEEPSEEK_API_KEY=sk-jkl'), 'sk-jkl');
  assert.equal(parseShellAssignment('export OPENAI_API_KEY=sk-x'), undefined);
  assert.equal(parseShellAssignment(''), undefined);
});

test('人民幣餘額依官方價目表換算成美元，不需要外部匯率', () => {
  assert.equal(toUsd('USD', 10), 10);
  assert.ok(Math.abs(CNY_PER_USD - 20 / 3) < 1e-9, '人民幣價是美元價的 6.67 倍');
  assert.ok(Math.abs(toUsd('CNY', 20 / 3) - 1) < 1e-9);
  assert.equal(toUsd('JPY', 5), 5, '未知幣別沿用原值');
});

test('跨幣別總額與剩餘比例', () => {
  const balances = [
    { currency: 'USD', total: 98.11, granted: 0, toppedUp: 98.11 },
    { currency: 'CNY', total: 2.49, granted: 2.49, toppedUp: 0 },
  ];
  const total = totalUsdOf(balances);
  assert.ok(Math.abs(total - (98.11 + 2.49 / CNY_PER_USD)) < 1e-9);
  // 你的例子：US$98 餘額，用掉 US$3 與 ¥2。
  const percent = remainingPercent(98 + 2 / CNY_PER_USD, 3 + 2 / CNY_PER_USD);
  assert.ok(Math.abs(percent - (98.3 / 101.6) * 100) < 1e-6);
});

test('剩餘比例夾在 0 到 100 之間', () => {
  assert.equal(remainingPercent(50, 50), 50);
  assert.equal(remainingPercent(0, 10), 0);
  assert.equal(remainingPercent(10, 0), 100);
  assert.equal(remainingPercent(-5, 10), 0);
  assert.equal(remainingPercent(0, 0), 0);
});
