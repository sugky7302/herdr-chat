/** 模型短名稱：claude-opus-5-5 → opus-5.5；gemini-4-argon-medium → gemini-4-argon；deepseek-official/deepseek-flash → deepseek-flash；去掉日期後綴。 */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  return base
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2')
    .replace(/^(gemini-[^-\s]+-[^-\s]+)-(?:low|medium|high|xhigh|max)$/i, '$1');
}
