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

const OPTION_LINE = /^[\s│|]*(›|>|❯)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?[\s│|]*$/;

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

export interface DialogOption {
  number: number;
  /** 畫面上的原始文字。 */
  text: string;
  highlighted: boolean;
}

/**
 * 從 agent 的確認畫面取出選項，例如「❯ 1. Yes」「2. No」。
 * 只取畫面最後一組連續編號的選項，避免誤抓對話內容中的編號清單。
 */
export function parseDialog(screen: string): DialogOption[] {
  const lines = screen.split('\n');
  const groups: DialogOption[][] = [];
  let current: DialogOption[] = [];
  for (const line of lines) {
    const match = OPTION_LINE.exec(line);
    if (match) {
      const number = Number(match[2]);
      if (current.length && number !== current[current.length - 1].number + 1) {
        groups.push(current);
        current = [];
      }
      current.push({ number, text: match[3].trim(), highlighted: Boolean(match[1]) });
    } else if (current.length && !line.trim()) {
      continue;
    } else if (current.length && /^\s{4,}\S/.test(line)) {
      // 選項說明的換行，屬於同一組。
      continue;
    } else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  const withCursor = groups.filter((group) => group.some((option) => option.highlighted));
  const last = withCursor[withCursor.length - 1];
  if (last && last.length >= 2) return last;
  return parseUnnumbered(lines);
}

/**
 * 沒有編號的選項，例如 Claude 的信任畫面：
 *   ❯ No, exit
 *     Yes, I trust this folder
 * 以游標所在行為準，往上下收集縮排相同的相鄰行。
 */
function parseUnnumbered(lines: string[]): DialogOption[] {
  const strip = (line: string) => line.replace(/^[\s│|]*/, '').replace(/[\s│|]*$/, '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^([\s│|]*)(❯|›)\s+(\S.*?)[\s│|]*$/.exec(lines[i]);
    if (!match || /^\d+\./.test(match[3])) continue;
    const column = match[1].length;
    const textColumn = lines[i].indexOf(match[3]);
    const sameColumn = (line: string) => {
      const text = strip(line);
      return text !== '' && line.indexOf(text) === textColumn && !/^(❯|›)/.test(text);
    };
    let start = i;
    while (start > 0 && sameColumn(lines[start - 1])) start--;
    let end = i;
    while (end < lines.length - 1 && sameColumn(lines[end + 1])) end++;
    if (end === start) return [];
    const options: DialogOption[] = [];
    for (let k = start; k <= end; k++) {
      options.push({ number: options.length + 1, text: k === i ? match[3].trim() : strip(lines[k]), highlighted: k === i });
    }
    void column;
    return options;
  }
  return [];
}
