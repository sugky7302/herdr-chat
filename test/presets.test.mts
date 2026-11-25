import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentName, buildShellCommand, buildStartArgs, normalizePresets, presetForKind, switchCommand } from '../src/presets.ts';

test('啟動參數依序放入固定參數、模型與 effort', () => {
  const preset = { id: 'codex', label: 'Codex', kind: 'codex', args: ['--search'], modelArgs: ['-m', '{model}'], effortArgs: ['-c', 'model_reasoning_effort="{effort}"'] };
  assert.deepEqual(buildStartArgs(preset, 'gpt-6.1-sol', 'high'), ['--search', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(buildStartArgs(preset), ['--search']);
});

test('自訂指令會正確加上 shell 引號', () => {
  const preset = { id: 'deepseek', label: 'DeepSeek', command: "'/Applications/DeepSeek Harness.app/bin/dsh'", modelArgs: ['--model', '{model}'] };
  assert.equal(buildShellCommand(preset, "it's"), `'/Applications/DeepSeek Harness.app/bin/dsh' --model 'it'\\''s'`);
});

test('agent 名稱符合 herdr 規則且不重複', () => {
  assert.equal(agentName('claude', ['claude-1']), 'claude-2');
  assert.equal(agentName('1st Agent', []), 'st-agent-1');
  assert.match(agentName('', []), /^[a-z][a-z0-9_-]{0,31}$/);
});

test('切換指令與選項檢查', () => {
  assert.equal(switchCommand('/model {model}', 'model', 'opus'), '/model opus');
  assert.equal(switchCommand(undefined, 'model', 'opus'), null);
  assert.deepEqual(
    normalizePresets([{ id: 'a', label: 'A', kind: 'claude' }, { id: 'a', label: 'dup', kind: 'codex' }, { id: 'b', label: 'B' }, null]).map((p) => p.label),
    ['A'],
  );
});

import { shortModel } from '../src/modelName.ts';

test('模型短名稱', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5.5');
  assert.equal(shortModel('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModel('opus'), 'opus');
  assert.equal(shortModel('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(shortModel('gemini-4-argon-medium'), 'gemini-4-argon');
  assert.equal(shortModel('deepseek-official/deepseek-flash'), 'deepseek-flash');
});

test('DeepSeek 預設選項自動遷移舊指令並對應 dsh-tui kind', () => {
  const presets = normalizePresets([
    {
      id: 'deepseek',
      label: 'DeepSeek',
      command: "'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'",
      models: [],
      efforts: [],
    },
  ]);
  assert.equal(presets[0].command, 'dsh-tui');
  assert.deepEqual(presets[0].models, ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
  assert.deepEqual(presets[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(presets[0].switchModel, '/model deepseek-official/{model}');
  assert.equal(presets[0].switchEffort, '/effort {effort}');
  assert.equal(presetForKind(presets, 'dsh-tui')?.id, 'deepseek');
  assert.equal(presetForKind(presets, 'dsh')?.id, 'deepseek');
});
