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

const OPTION_LINE = /^[\s│|]*(›|>|❯)?\s*(\d+)\.\s+(.+?)(?:\s{2,}(.*?))?[\s│|]*$/;

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
  /** 選項下方縮排的說明。 */
  description?: string;
}

export interface DialogPrompt {
  /** 標題，例如「☐ 資料庫」。多個問題時會有多個標籤。 */
  title?: string;
  /** 問題本文。 */
  question?: string;
  options: DialogOption[];
}

const SEPARATOR = /^[\s│|]*[─━—\-=]{3,}[\s│|]*$/;
const PAGED_OPTION_FOOTER = /^[\s│|]*option\s+(\d+)\/(\d+)\s*\|\s*enter to submit\s*\|\s*esc to cancel[\s│|]*$/i;

/**
 * 從 agent 的確認或提問畫面取出選項，例如「❯ 1. Yes」「2. No」。
 * 只取畫面最後一組帶游標的連續編號選項，避免誤抓對話內容中的編號清單。
 */
export function parseDialog(screen: string): DialogOption[] {
  return parsePrompt(screen).options;
}

export function parsePrompt(screen: string): DialogPrompt {
  const lines = screen.split('\n');
  const groups: { start: number; options: DialogOption[]; paged?: boolean }[] = [];
  let current: (typeof groups)[number] | null = null;
  const close = () => {
    if (current) groups.push(current);
    current = null;
  };
  lines.forEach((line, index) => {
    const match = OPTION_LINE.exec(line);
    if (match) {
      const number = Number(match[2]);
      const last = current?.options[current.options.length - 1];
      if (current && last && number !== last.number + 1) close();
      current ??= { start: index, options: [] };
      const description = match[4]?.trim();
      current.options.push({ number, text: match[3].trim(), highlighted: Boolean(match[1]), ...(description ? { description } : {}) });
      return;
    }
    if (!current) return;
    const footer = PAGED_OPTION_FOOTER.exec(line);
    if (footer) {
      const position = Number(footer[1]);
      const total = Number(footer[2]);
      const option = current.options[0];
      // 分頁式選單一次只顯示一個選項，必須同時有相符的游標與分頁提示。
      current.paged = current.options.length === 1 && option.highlighted && option.number === position
        && Number.isSafeInteger(position) && Number.isSafeInteger(total) && position >= 1 && total >= position;
      close();
      return;
    }
    // 空行與分隔線不會中斷選項清單（Claude 把「Chat about this」放在分隔線後面）。
    if (!line.trim() || SEPARATOR.test(line)) return;
    const continuation = /^[\s│|]{4,}(\S.*?)[\s│|]*$/.exec(line);
    if (continuation) {
      const option = current.options[current.options.length - 1];
      option.description = option.description ? `${option.description} ${continuation[1]}` : continuation[1];
      return;
    }
    close();
  });
  close();
  const chosen = [...groups].reverse().find((group) => group.options.some((option) => option.highlighted));
  if (!chosen || (chosen.options.length < 2 && !chosen.paged)) {
    return { options: parseUnnumbered(lines) };
  }
  return { ...promptAbove(lines, chosen.start, chosen.paged), options: chosen.options };
}

/** 選項上方的問題與標題：往上讀到分隔線或輸入提示為止，最多 4 行。 */
function promptAbove(lines: string[], start: number, paged = false): { title?: string; question?: string } {
  const collected: string[] = [];
  for (let i = start - 1; i >= 0 && collected.length < 4; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (paged && /^[\s│|]*Field\s+\d+\/\d+[\s│|]*$/i.test(line)) break;
    if (SEPARATOR.test(line) || /^\s*(❯|>)\s/.test(line) || /^\s*[╭╰]/.test(line)) break;
    collected.unshift(line.replace(/^[\s│|]+|[\s│|]+$/g, ''));
  }
  const titleIndex = collected.findIndex((line) => /^[☐☒✔✓□■]/.test(line) || (paged && /^Server:/i.test(line)));
  const title = titleIndex >= 0 ? collected.splice(titleIndex, 1)[0] : undefined;
  const question = collected.join(' ').trim() || undefined;
  return { ...(title ? { title } : {}), ...(question ? { question } : {}) };
}

/**
 * 沒有編號的選項，例如 Claude 的信任畫面：
 *   ❯ No, exit
 *     Yes, I trust this folder
 * 以游標所在行為準，往上下收集縮排相同的相鄰行。
 *
 * 注意：Claude Code 的使用者訊息也是以 `❯ ` 開頭並自動換行縮排 2 格，
 * 所以無編號選單必須同時看到確認操作提示（例如 `Enter to confirm`、`Enter to select`）或位於最後一個 `❯` 區段且符合選單特徵。
 */
const UNNUMBERED_MENU_HINT = /(?:Enter to (?:confirm|select|continue)|↑\/↓|Use arrow keys|Esc to cancel)/i;

function parseUnnumbered(lines: string[]): DialogOption[] {
  if (!UNNUMBERED_MENU_HINT.test(lines.slice(-15).join('\n'))) return [];
  const strip = (line: string) => line.replace(/^[\s│|]*/, '').replace(/[\s│|]*$/, '');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^([\s│|]*)(❯|›)\s+(\S.*?)[\s│|]*$/.exec(lines[i]);
    if (!match || /^\d+\./.test(match[3])) continue;
    const textColumn = lines[i].indexOf(match[3]);
    const sameColumn = (line: string) => {
      const text = strip(line);
      return text !== '' && !SEPARATOR.test(line) && line.indexOf(text) === textColumn && !/^(❯|›)/.test(text);
    };
    let start = i;
    while (start > 0 && sameColumn(lines[start - 1])) start--;
    let end = i;
    while (end < lines.length - 1 && sameColumn(lines[end + 1])) end++;
    if (end === start) continue;
    const options: DialogOption[] = [];
    for (let k = start; k <= end; k++) {
      options.push({ number: options.length + 1, text: k === i ? match[3].trim() : strip(lines[k]), highlighted: k === i });
    }
    return options;
  }
  return [];
}
