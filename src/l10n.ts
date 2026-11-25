import { hostMessages } from './l10n/host.ts';
import { serviceMessages } from './l10n/services.ts';
import { webviewMessages } from './l10n/webview.ts';

/** The English source message is also the fallback when a translation is unavailable. */
export type SupportedLocale = 'en' | 'zh-tw';
export type InterpolationValue = string | number | boolean | null | undefined;
export interface LocalizedMessage {
  message: string;
  args?: readonly InterpolationValue[];
}

export const messageCatalogs = { host: hostMessages, services: serviceMessages, webview: webviewMessages };
const traditionalChinese: Readonly<Record<string, string>> = {
  ...hostMessages, ...serviceMessages, ...webviewMessages,
};
let locale: SupportedLocale = 'en';

/** VS Code uses zh-tw; accept equivalent script/region tags without treating zh-cn as Traditional Chinese. */
export function resolveLocale(language: string | undefined): SupportedLocale {
  const parts = (language ?? '').trim().toLowerCase().replace(/_/g, '-').split('-');
  if (parts[0] !== 'zh' || parts.includes('hans')) return 'en';
  return parts.includes('hant') || parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-tw' : 'en';
}

/** Called from the extension's activation and from the webview's host-provided HTML lang. */
export function setLocale(language: string | undefined): void { locale = resolveLocale(language); }
export function getLocale(): SupportedLocale { return locale; }
export function getIntlLocale(): 'en' | 'zh-TW' { return locale === 'zh-tw' ? 'zh-TW' : 'en'; }

/** Substitution is one pass: argument text is never interpreted as another template or translation key. */
export function formatMessage(message: string, ...args: readonly InterpolationValue[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const position = Number(index);
    return position < args.length ? String(args[position] ?? '') : placeholder;
  });
}

export function t(message: string, ...args: readonly InterpolationValue[]): string {
  const translated = locale === 'zh-tw' && Object.hasOwn(traditionalChinese, message)
    ? traditionalChinese[message] : undefined;
  return formatMessage(translated || message, ...args);
}

/** Only extension-owned messages carry this descriptor; user/agent text is always the unchanged fallback. */
export function formatLocalized(fallback: string, descriptor?: LocalizedMessage): string {
  if (!descriptor || typeof descriptor.message !== 'string' || !descriptor.message
      || (descriptor.args !== undefined && !Array.isArray(descriptor.args))) return fallback;
  return t(descriptor.message, ...(descriptor.args ?? []));
}
