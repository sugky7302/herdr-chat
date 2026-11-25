import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeProjectDirName, parseClaude, parseCodex } from '../src/transcript/parse.ts';

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n');

test('Claude：保留使用者文字、助理文字與工具摘要，略過系統內容', () => {
  const text = lines(
    { type: 'user', message: { role: 'user', content: '幫我看 README' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'tool_use', name: 'Bash', input: { command: 'cat README.md' } },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '第一段' }] } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '第二段' }] } },
    '{"broken',
  );
  const parsed = parseClaude(text + '\n{"type":"user"');
  assert.equal(parsed.model, 'claude-opus-5-5');
  assert.deepEqual(parsed.messages, [
    { role: 'user', text: '幫我看 README' },
    { role: 'notice', text: '/model opus' },
    { role: 'tool', tool: 'Bash', text: 'cat README.md' },
    { role: 'assistant', text: '第一段\n\n第二段' },
  ]);
});

test('Claude：從 /effort 指令記住 effort', () => {
  const parsed = parseClaude(lines({ type: 'user', message: { content: '<command-name>/effort</command-name><command-args>max</command-args>' } }));
  assert.equal(parsed.effort, 'max');
});

test('Codex：讀取模型、effort、訊息與工具呼叫，略過 AGENTS.md 指示', () => {
  const text = lines(
    { type: 'session_meta', payload: { cwd: '/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo' }] } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '為什麼要 bun' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls","-la"]}' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '因為…' }] } },
  );
  const parsed = parseCodex(text);
  assert.equal(parsed.model, 'gpt-6.1-sol');
  assert.equal(parsed.effort, 'xhigh');
  assert.deepEqual(parsed.messages, [
    { role: 'user', text: '為什麼要 bun' },
    { role: 'tool', tool: 'shell', text: 'ls -la' },
    { role: 'assistant', text: '因為…' },
  ]);
});

test('Claude 專案資料夾名稱把非英數字元換成 -', () => {
  assert.equal(
    claudeProjectDirName('/Users/user/Documents/1-Project/2209-iCloud-UMC/main'),
    '-Users-user-Documents-1-Project-2209-iCloud-UMC-main',
  );
});
