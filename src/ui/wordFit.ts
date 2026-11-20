/**
 * 棋盘格子里答案的排版规则（界面 SVG 与导出图共用，保证两边长得一样）。
 *
 * 六边形格子中心处净宽约 90px（2 × 0.866 × R）。6 个字按 12px 排刚好 72px，
 * 第 7 个字起再挤就要么压到斜边、要么退化成省略号，所以 7 字开始折成两行。
 */

/** 从这个字数开始换行 */
export const CELL_WORD_BREAK = 7;

/** 两行合计的硬上限，超过才退回省略号（中文词条极少有这么长的） */
export const CELL_WORD_MAX = 14;

/** 按一行里最多的字数选字号，保证放得下 */
export function sizeForChars(len: number): number {
  if (len <= 2) return 18;
  if (len === 3) return 16.5;
  if (len === 4) return 15;
  if (len === 5) return 13.5;
  return 12;
}

export interface CellWordLayout {
  /** 一到两行，两行时第一行不会比第二行短 */
  lines: string[];
  /** 基准字号（导出图自行乘缩放） */
  font: number;
}

/**
 * 把答案拆成格子里的行：短词一行，≥7 字对半折成两行（仍居中）。
 *
 * 例：7 → 4+3，8 → 4+4，9 → 5+4，12 → 6+6。
 * 超过 14 字才截断，且省略号算在 14 字里。
 */
export function layoutCellWord(word: string): CellWordLayout {
  if (word.length < CELL_WORD_BREAK) {
    return { lines: [word], font: sizeForChars(word.length) };
  }
  const body = word.length > CELL_WORD_MAX ? `${word.slice(0, CELL_WORD_MAX - 1)}…` : word;
  const per = Math.ceil(body.length / 2);
  const lines = [body.slice(0, per), body.slice(per)];
  return { lines, font: sizeForChars(Math.max(lines[0].length, lines[1].length)) };
}

/** 两行之间的行距，随字号缩放，避免小字时行距过松 */
export function lineGap(font: number): number {
  return Math.round(font * 1.2);
}
