import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortLabel, menuKind, nextKey, parseMenu } from '../src/codexMenu.ts';

const modelScreen = `  Select Model and Effort
  1. GPT-6.2-Sol            Fast, go-to model for coding
                            and everyday work.
  2. GPT-6.2-Astra          Our most capable model for
  3. GPT-6.1 Terra          Efficient model that excels
› 4. GPT-6.1-Sol (current)  Previous generation model for
  enter select · esc back`;

test('解析 Codex 模型選單', () => {
  assert.equal(menuKind(modelScreen), 'model');
  const options = parseMenu(modelScreen);
  assert.deepEqual(options.map((o) => o.name), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol']);
  assert.equal(options.find((o) => o.highlighted)?.number, 4);
});

test('決定方向鍵', () => {
  const options = parseMenu(modelScreen);
  assert.equal(nextKey(options, 'gpt-6.1-sol'), 'found');
  assert.equal(nextKey(options, 'gpt-6.2-sol'), 'up');
  assert.equal(nextKey(options, 'gpt-7'), 'down');
});

test('effort 選單與子選單', () => {
  const screen = `  Select Reasoning Level for GPT-6.2-Sol
› 1. Low (default)    Fast responses
  4. Extra high       Extra high reasoning depth for
  5. More reasoning…  Max and Ultra consume usage limits`;
  assert.equal(menuKind(screen), 'effort');
  assert.deepEqual(parseMenu(screen).map((o) => o.name), ['low', 'extra-high', 'more-reasoning']);
  assert.equal(effortLabel('xhigh'), 'extra-high');
  assert.equal(menuKind('  Advanced Reasoning\n› 1. Max    For difficult'), 'advanced');
});
