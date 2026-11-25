import type { LocalizedMessage } from './types.ts';
import { formatMessage } from '../l10n.ts';

/** Only extension-owned templates use this helper. User text and model reports stay as raw strings. */
export function systemMessage(message: string, ...args: (string | number | boolean | null | undefined)[]): LocalizedMessage {
  return { message, ...(args.length ? { args: args.map((value) => value ?? '') } : {}) };
}

/** Canonical, readable fallback for persisted records and agent-facing checkpoint JSON. */
export function englishMessage(descriptor: LocalizedMessage): string {
  return formatMessage(descriptor.message, ...(descriptor.args ?? []));
}

export function setError(record: { error?: string; errorLocalization?: LocalizedMessage }, error: string | LocalizedMessage | undefined): void {
  record.error = typeof error === 'object' ? englishMessage(error) : error;
  if (typeof error === 'object') record.errorLocalization = error;
  else delete record.errorLocalization;
}
