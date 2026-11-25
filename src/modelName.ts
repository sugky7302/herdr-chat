/** 模型短名稱：claude-opus-5-5 → opus-5.5；去掉日期後綴。 */
export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2');
}
