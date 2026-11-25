// 讀取 Codex TUI 的 /model 選單畫面。只做文字解析，方便測試。
//
// 已確認的 Codex 行為（v0.171）：
// - /model 開啟「Select Model and Effort」，Enter 選擇模型。
// - 接著開啟「Select Reasoning Level for <模型>」。
//   數字鍵與 Enter 會把選擇存成 ~/.codex/config.toml 的全域預設值。
//   s 只套用到目前 session。所以擴充功能只用方向鍵移動，再按 s。
// - Max 與 Ultra 在「More reasoning…」子選單（Advanced Reasoning）內。

export interface MenuOption {
  number: number;
  name: string;
  highlighted: boolean;
}

const OPTION_LINE = /^\s*(›|>)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/;

export function normalizeLabel(label: string): string {
  return label
    .replace(/\((current|default)\)/gi, '')
    .replace(/…|\.\.\./g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export function parseMenu(screen: string): MenuOption[] {
  const options: MenuOption[] = [];
  for (const line of screen.split('\n')) {
    const match = OPTION_LINE.exec(line);
    if (!match) continue;
    options.push({ number: Number(match[2]), name: normalizeLabel(match[3]), highlighted: Boolean(match[1]) });
  }
  return options;
}

const EFFORT_LABELS: Record<string, string> = {
  xhigh: 'extra-high',
  'extra-high': 'extra-high',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort.toLowerCase()] ?? effort.toLowerCase();
}

export type MenuKind = 'model' | 'effort' | 'advanced' | 'none';

export function menuKind(screen: string): MenuKind {
  if (/Select Model and Effort/i.test(screen)) return 'model';
  if (/Select Reasoning Level/i.test(screen)) return 'effort';
  if (/Advanced Reasoning/i.test(screen)) return 'advanced';
  return 'none';
}

/**
 * 決定下一個按鍵。
 * 回傳 'found' 表示目前反白的就是目標；回傳 null 表示畫面上沒有選項可以移動。
 */
export function nextKey(options: MenuOption[], target: string): 'up' | 'down' | 'found' | null {
  const current = options.find((option) => option.highlighted);
  if (!current) return null;
  if (current.name === target) return 'found';
  const wanted = options.find((option) => option.name === target);
  if (!wanted) return 'down';
  return wanted.number > current.number ? 'down' : 'up';
}
