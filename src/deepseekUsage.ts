// DeepSeek 額度：餘額查詢與花費估算。
//
// DeepSeek 只有餘額 API，沒有用量或帳單 API。
// 所以「已用金額」由本機 DSH 對話紀錄的 token 數乘官方單價估算。
// 估算值只用來計算剩餘比例，不代表平台帳單。

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** 單一幣別的餘額。欄位意義沿用 API：總額、贈金、儲值。 */
export interface BalanceInfo {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

/** 餘額加上換算後的美元等值，供 webview 直接顯示。 */
export interface BalanceView extends BalanceInfo {
  usd: number;
}

/** 輸入框要顯示的 DeepSeek 額度。 */
export interface DeepseekStatus {
  balances: BalanceView[];
  /** 所有幣別換算成美元後的可用總額。 */
  totalUsd: number;
  /** 依官方單價估算的本機累計花費（美元），只供提示參考。 */
  estimatedSpend: number;
  /** totalUsd ÷（totalUsd + estimatedSpend）。範圍 0–100。 */
  percentLeft: number;
  /** 查詢時間（Unix 毫秒）。 */
  updatedAt: number;
}

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';

/** 每百萬 token 的美元單價，順序為 `[離峰, 高峰]`。 */
interface PriceRow {
  hit: readonly [number, number];
  miss: readonly [number, number];
  output: readonly [number, number];
}

const MODEL_PRICES: Readonly<Record<'flash' | 'pro', PriceRow>> = {
  flash: { hit: [0.003, 0.006], miss: [0.15, 0.3], output: [0.6, 1.2] },
  pro: { hit: [0.022, 0.044], miss: [0.66, 1.32], output: [1.98, 3.96] },
};

/** 同一張價目表的人民幣價格。人民幣價 ÷ 美元價固定為 6.67。 */
const MODEL_PRICES_CNY: Readonly<Record<'flash' | 'pro', PriceRow>> = {
  flash: { hit: [0.02, 0.04], miss: [1, 2], output: [4, 8] },
  pro: { hit: [0.15, 0.3], miss: [4.5, 9], output: [13.5, 27] },
};

/** 官方價目表隱含的人民幣兌美元比率。兩地價格同表，所以不需要外部匯率。 */
export const CNY_PER_USD = MODEL_PRICES_CNY.flash.output[0] / MODEL_PRICES.flash.output[0];

/** 把各幣別金額換成美元。價格表只提供 USD 與 CNY，其他幣別視為美元。 */
export function toUsd(currency: string, amount: number): number {
  return currency === 'CNY' ? amount / CNY_PER_USD : amount;
}

/** 所有幣別餘額換算成美元的總和。 */
export function totalUsdOf(balances: BalanceInfo[]): number {
  return balances.reduce((sum, item) => sum + toUsd(item.currency, Math.max(0, item.total)), 0);
}

/** 剩餘比例：可用總額 ÷（可用總額 + 估算已用）。 */
export function remainingPercent(totalUsd: number, spendUsd: number): number {
  const total = Math.max(0, totalUsd) + Math.max(0, spendUsd);
  return total > 0 ? Math.min(100, Math.max(0, (Math.max(0, totalUsd) / total) * 100)) : 0;
}

/** 對話紀錄中的 token 用量。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * 高峰時段為 UTC 週一至週五 01:00–04:00 與 06:00–10:00。
 * 中國法定節假日未計入，這些日期會以高峰價估算。
 */
export function isPeakHour(timeMs: number): boolean {
  const at = new Date(timeMs);
  if (!Number.isFinite(at.getTime())) return false;
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** 模型名稱對應價目表。`deepseek-v4-pro` 用 Pro 價格，其餘用 Flash 價格。 */
export function modelClass(model: string | undefined): 'flash' | 'pro' {
  return /(?:^|[^a-z])v4-pro(?:[^a-z]|$)/i.test(model ?? '') ? 'pro' : 'flash';
}

/**
 * 單次請求的估算費用（美元）。
 * 快取命中的輸入用 hit 單價，未命中的輸入用 miss 單價。
 * DeepSeek 不另收快取寫入費，`cacheWriteTokens` 不計價。
 */
export function estimateCost(usage: TokenUsage, model: string | undefined, timeMs: number): number {
  const price = MODEL_PRICES[modelClass(model)];
  const tier = isPeakHour(timeMs) ? 1 : 0;
  const miss = usage.inputTokens ?? 0;
  const hit = usage.cacheReadTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (miss * price.miss[tier] + hit * price.hit[tier] + output * price.output[tier]) / 1_000_000;
}

const KEY_FILES = ['.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.profile'];

/** 從 shell 啟動檔文字取出金鑰。支援 `export`、引號與行尾註解。 */
export function parseShellAssignment(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * 依序找金鑰：環境變數 → shell 啟動檔。
 * 從 Finder 啟動的 VS Code 拿不到 `~/.zshrc` 匯出的值，所以需要後備來源。
 */
export async function findApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  for (const name of KEY_FILES) {
    const text = await fs.readFile(path.join(os.homedir(), name), 'utf8').catch(() => '');
    const key = parseShellAssignment(text);
    if (key) return key;
  }
  return undefined;
}

/** 讀取餘額。失敗時丟出錯誤，由呼叫端保留上一次結果。 */
export async function fetchBalances(key: string, fetchImpl: typeof fetch = fetch): Promise<BalanceInfo[]> {
  const response = await fetchImpl(BALANCE_ENDPOINT, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`DeepSeek balance request failed: HTTP ${response.status}`);
  const body = (await response.json()) as { balance_infos?: unknown };
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  return infos
    .map((info: any) => ({
      currency: String(info?.currency ?? 'USD'),
      total: Number(info?.total_balance),
      granted: Number(info?.granted_balance ?? 0),
      toppedUp: Number(info?.topped_up_balance ?? 0),
    }))
    .filter((info) => Number.isFinite(info.total));
}

interface FileCost {
  mtimeMs: number;
  size: number;
  cost: number;
}

function sessionRoots(): string[] {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  return [...new Set([path.join(dshHome, 'sessions'), path.join(os.homedir(), '.dsh-tui', 'sessions')])];
}

/** 列出所有對話紀錄檔：`<root>/<workspace>/<session>/session*.jsonl[.zstd]`。 */
async function listSessionLogs(): Promise<string[]> {
  const files: string[] = [];
  for (const root of sessionRoots()) {
    for (const workspace of await fs.readdir(root).catch(() => [] as string[])) {
      const workspaceDir = path.join(root, workspace);
      for (const session of await fs.readdir(workspaceDir).catch(() => [] as string[])) {
        const sessionDir = path.join(workspaceDir, session);
        for (const name of await fs.readdir(sessionDir).catch(() => [] as string[])) {
          if (/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(name)) files.push(path.join(sessionDir, name));
        }
      }
    }
  }
  return files;
}

async function readLog(file: string): Promise<string> {
  const raw = await fs.readFile(file);
  return file.endsWith('.zstd') ? zstdDecode(raw) : raw.toString('utf8');
}

function zstdDecode(raw: Buffer): string {
  try {
    return zstdDecompressSync(raw).toString('utf8');
  } catch {
    return '';
  }
}

/** 加總單一紀錄檔的估算花費。 */
export function costOfLog(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant/message') continue;
    const usage = entry.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const model = entry.data?.message?.source?.model;
    const time = typeof entry.time === 'number' ? entry.time : Date.now();
    total += estimateCost(usage, model, time);
  }
  return total;
}

/** 估算本機所有 DSH 紀錄的累計花費（美元）。只重算有變動的檔案。 */
export class DeepseekUsageTracker {
  private status?: DeepseekStatus;
  private loadedAt = 0;
  private loading?: Promise<DeepseekStatus | undefined>;
  private readonly fileCosts = new Map<string, FileCost>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  /** 取得目前狀態。快取有效期內直接回傳，併發呼叫共用同一次載入。 */
  async read(now = Date.now()): Promise<DeepseekStatus | undefined> {
    if (this.status && now - this.loadedAt < this.ttlMs) return this.status;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** 目前快取的估算花費，測試與診斷用。 */
  get spend(): number {
    return [...this.fileCosts.values()].reduce((sum, entry) => sum + entry.cost, 0);
  }

  private async load(): Promise<DeepseekStatus | undefined> {
    const key = await findApiKey();
    if (!key) return this.status;
    try {
      const balances: BalanceView[] = (await fetchBalances(key)).map((item) => ({
        ...item,
        usd: toUsd(item.currency, Math.max(0, item.total)),
      }));
      if (!balances.length) return this.status;
      const estimatedSpend = await this.estimatedSpend();
      const totalUsd = balances.reduce((sum, item) => sum + item.usd, 0);
      this.status = {
        balances,
        totalUsd,
        estimatedSpend,
        percentLeft: remainingPercent(totalUsd, estimatedSpend),
        updatedAt: Date.now(),
      };
      this.loadedAt = Date.now();
    } catch {
      // 查詢失敗時保留上一次結果，避免輸入框閃爍。
    }
    return this.status;
  }

  private async estimatedSpend(): Promise<number> {
    let total = 0;
    for (const file of await listSessionLogs()) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const cached = this.fileCosts.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        total += cached.cost;
        continue;
      }
      const cost = costOfLog(await readLog(file).catch(() => ''));
      this.fileCosts.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, cost });
      total += cost;
    }
    return total;
  }
}
