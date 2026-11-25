#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RpcInput } from './types.ts';

const usage = {
  entry: 'node <extension>/dist/herdr-collab.cjs --connection <file> --task <id> --generation <n> <command>',
  commands: {
    status: 'status',
    spawn: 'spawn <preset-id> [--model <model>] [--effort <effort>]',
    delegate: 'delegate <target-pane-id> <text> [--wait] [--timeout 180000] [--request-id <id>]',
    wait: 'wait <request-id> [--timeout 180000]',
    report: 'report <request-id> --revision <n> --status completed|needs_input|failed --text <text> [--report-id <id>]',
    answer: 'answer <request-id> <text> [--wait] [--timeout 180000]',
    accept: 'accept <handoff-id>',
  },
  caller: 'HERDR_PANE_ID is read from the calling agent environment and checked against the live native session.',
};

export interface ParsedCli { connection: string; input: RpcInput; timeoutMs: number }

export function parseCli(argv: string[], environment: NodeJS.ProcessEnv = process.env): ParsedCli {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  const booleanFlags = new Set(['wait']);
  const valueFlags = new Set(['connection', 'task', 'generation', 'session', 'model', 'effort', 'timeout', 'revision', 'status', 'text', 'report-id', 'request-id']);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const name = value.slice(2);
    if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
    if (booleanFlags.has(name)) { flags.set(name, true); continue; }
    if (!valueFlags.has(name)) throw new Error(`Unknown option: --${name}`);
    const next = argv[++index];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for --${name}`);
    flags.set(name, next);
  }
  const required = (name: string) => {
    const value = flags.get(name);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing --${name}`);
    return value;
  };
  const integer = (name: string, fallback?: number) => {
    const raw = flags.get(name);
    if (raw === undefined && fallback !== undefined) return fallback;
    const number = Number(raw);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(number)) throw new Error(`--${name} must be an integer`);
    return number;
  };
  const command = positional.shift() as RpcInput['command'];
  if (!Object.hasOwn(usage.commands, command)) throw new Error('Unknown command; use --help for JSON usage.');
  const counts: Record<RpcInput['command'], number> = { status: 0, spawn: 1, delegate: 2, wait: 1, report: 1, answer: 2, accept: 1 };
  if (positional.length !== counts[command]) throw new Error(`Usage: ${usage.commands[command]}`);
  const paneId = environment.HERDR_PANE_ID;
  if (!paneId) throw new Error('HERDR_PANE_ID is missing; run this command inside the calling Herdr agent pane.');
  const timeoutMs = integer('timeout', 180000);
  if (timeoutMs < 1 || timeoutMs > 180000) throw new Error('--timeout must be between 1 and 180000 ms.');
  const args: Record<string, unknown> = {};
  if (command === 'spawn') Object.assign(args, { presetId: positional[0], model: flags.get('model'), effort: flags.get('effort') });
  if (command === 'delegate') Object.assign(args, { targetPaneId: positional[0], text: positional[1], requestId: flags.get('request-id') ?? randomUUID(), wait: flags.get('wait') === true, timeoutMs });
  if (command === 'wait') Object.assign(args, { requestId: positional[0], timeoutMs });
  if (command === 'answer') Object.assign(args, { requestId: positional[0], text: positional[1], wait: flags.get('wait') === true, timeoutMs });
  if (command === 'report') Object.assign(args, { requestId: positional[0], revision: integer('revision'), status: required('status'), text: required('text'), reportId: flags.get('report-id') ?? randomUUID() });
  if (command === 'accept') args.handoffId = positional[0];
  return {
    connection: required('connection'), timeoutMs,
    input: { command, taskId: required('task'), caller: { paneId, generation: integer('generation'), sessionValue: flags.get('session') as string | undefined }, args },
  };
}

export async function callBridge(parsed: ParsedCli): Promise<unknown> {
  const descriptor = JSON.parse(await fs.readFile(parsed.connection, 'utf8'));
  const url = new URL(descriptor.url);
  if (descriptor.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc' || url.username || url.password || url.search || url.hash || !url.port || typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)) {
    throw new Error('Invalid local collaboration connection descriptor.');
  }
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', headers: { 'Authorization': `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.input), signal: AbortSignal.timeout(parsed.timeoutMs + 15000),
  });
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok || !payload.ok) throw Object.assign(new Error(payload.error?.message ?? `HTTP ${response.status}`), { code: payload.error?.code ?? 'http_error' });
  return payload.result;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedCli | undefined;
  try {
    if (argv.includes('--help')) { process.stdout.write(`${JSON.stringify(usage)}\n`); return; }
    parsed = parseCli(argv);
    process.stdout.write(`${JSON.stringify({ ok: true, result: await callBridge(parsed) })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: (error as { code?: string }).code ?? 'cli_error', message: error instanceof Error ? error.message : String(error) }, requestId: parsed?.input.args.requestId, note: parsed?.input.command === 'delegate' || parsed?.input.command === 'answer' ? 'Delivery may be uncertain. Inspect status before retrying; do not repeat the work automatically.' : undefined })}\n`);
    process.exitCode = 1;
  }
}

// The bundled entry has a stable name. Importing parser/transport in tests has no process side effects.
if (path.basename(process.argv[1] ?? '') === 'herdr-collab.cjs') void runCli();
