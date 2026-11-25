import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { formatLocalized, formatMessage, getIntlLocale, getLocale, messageCatalogs, resolveLocale, setLocale, t } from '../src/l10n.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();

test('VS Code display locales select Traditional Chinese or the English fallback', () => {
  for (const language of ['zh-tw', 'zh-TW', 'zh_HK', 'zh-Hant', 'zh-Hant-TW', 'zh-Hant-HK', 'zh-MO']) {
    assert.equal(resolveLocale(language), 'zh-tw', language);
  }
  for (const language of ['en', 'en-US', 'en-gb', 'de', 'ja', 'zh-cn', 'zh-Hans', 'zh-Hans-TW', '', undefined]) {
    assert.equal(resolveLocale(language), 'en', String(language));
  }
  setLocale('zh-Hant'); assert.equal(getLocale(), 'zh-tw'); assert.equal(getIntlLocale(), 'zh-TW');
  setLocale('en-GB'); assert.equal(getLocale(), 'en'); assert.equal(getIntlLocale(), 'en');
});

test('English and Traditional Chinese use the same message keys, with safe interpolation and fallback', () => {
  const entry = Object.entries(messageCatalogs.host).find(([key]) => /\{0\}/.test(key));
  assert.ok(entry, 'at least one host message carries dynamic data');
  const [source, translated] = entry;
  const value = '使用者原文 $& {1} <tag> /repo/name';
  setLocale('en'); assert.equal(t(source, value), formatMessage(source, value));
  setLocale('zh-tw'); assert.equal(t(source, value), formatMessage(translated, value));
  assert.equal(t('A missing translation: {0}', value), `A missing translation: ${value}`);
  assert.equal(formatMessage('{0}/{1}/{2}/{3}', 0, false, '$& {0}'), '0/false/$& {0}/{3}');
  assert.equal(t('toString'), 'toString', 'prototype properties are never translations');
  setLocale('en');
});

test('persisted system descriptors render in the current locale while plain user text stays untouched', () => {
  const [source, translated] = Object.entries(messageCatalogs.services).find(([key]) => !/\{\d+\}/.test(key))!;
  const descriptor = { message: source };
  setLocale('en'); assert.equal(formatLocalized('old stored text', descriptor), source);
  setLocale('zh-tw'); assert.equal(formatLocalized('old stored text', descriptor), translated);
  assert.equal(formatLocalized(source), source, 'a user message matching a key is not translated');
  assert.equal(formatLocalized('先保留這段記憶。'), '先保留這段記憶。');
  setLocale('en');
});

test('catalogs have nonempty translations, consistent shared keys and matching placeholders', () => {
  const seen = new Map<string, { value: string; catalog: string }>();
  for (const [catalog, messages] of Object.entries(messageCatalogs)) for (const [key, value] of Object.entries(messages)) {
    assert.ok(key.trim() && value.trim(), `${catalog}: empty key/translation`);
    assert.doesNotMatch(key, /\p{Script=Han}/u, `${catalog}: source keys must be English`);
    assert.deepEqual(placeholders(value), placeholders(key), `${catalog}: placeholder mismatch for ${key}`);
    const previous = seen.get(key);
    if (previous) assert.equal(value, previous.value, `${catalog} and ${previous.catalog} conflict on ${key}`);
    seen.set(key, { value, catalog });
  }
});

test('manifest localization covers commands and settings without changing command IDs or model templates', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const english = JSON.parse(await fs.readFile(path.join(root, 'package.nls.json'), 'utf8'));
  const traditional = JSON.parse(await fs.readFile(path.join(root, 'package.nls.zh-tw.json'), 'utf8'));
  assert.deepEqual(Object.keys(english).sort(), Object.keys(traditional).sort());
  const references = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      const match = /^%([^%]+)%$/.exec(value);
      if (match) { references.add(match[1]); assert.ok(english[match[1]] && traditional[match[1]], match[1]); }
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);
  assert.deepEqual([...references].sort(), Object.keys(english).sort(), 'no stale or missing manifest entries');
  assert.equal(manifest.contributes.commands[0].command, 'herdr.refresh');
  assert.match(manifest.contributes.commands[0].title, /^%/);
  const presets = manifest.contributes.configuration.properties['herdr.agentPresets'];
  assert.equal(presets.default[0].switchModel, '/model {model}');
  assert.match(english['herdr.agentPresets.modelArgs.description'], /\{model\}/);
  assert.match(traditional['herdr.agentPresets.modelArgs.description'], /\{model\}/);
  assert.doesNotMatch(JSON.stringify(manifest), /\p{Script=Han}/u, 'manifest prose must come from package.nls');
});

test('literal runtime translation calls and persisted system messages have a Traditional Chinese catalog entry', async () => {
  const known = new Set(Object.values(messageCatalogs).flatMap((catalog) => Object.keys(catalog)));
  const missing: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'l10n') await walk(file); continue; }
      if (!file.endsWith('.ts') || entry.name === 'l10n.ts') continue;
      const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'systemMessage'].includes(node.expression.text)) {
          const argument = node.arguments[0];
          if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && !known.has(argument.text)) {
            missing.push(`${path.relative(root, file)}: ${argument.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  await walk(path.join(root, 'src')); await walk(path.join(root, 'webview'));
  assert.deepEqual(missing, []);
});

test('chat interface text uses English message keys instead of hard-coded Chinese literals', async () => {
  const file = path.join(root, 'webview/chat.ts');
  const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const hardcoded: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && /\p{Script=Han}/u.test(node.getText(source))) {
      hardcoded.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(hardcoded, []);
});
