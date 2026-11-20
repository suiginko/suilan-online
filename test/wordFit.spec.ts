import { CELL_WORD_BREAK, CELL_WORD_MAX, layoutCellWord, lineGap, sizeForChars } from '../src/ui/wordFit';

/**
 * 棋盘格子里答案的排版：≤6 字一行，≥7 字折两行并保持居中。
 *
 * 这些断言盯的是「多字答案被省略号截断」的老问题：以前 6 字以上一律砍到 5 字加「…」，
 * 玩家只能看到半截词，导出图里也一样。
 */

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}（实际 ${JSON.stringify(actual)}）`
  );
}

console.log('棋盘答案排版');

// 断点：6 字仍然一行，7 字开始换行
eq(layoutCellWord('一二三四五六').lines, ['一二三四五六'], '6 字仍是一行');
eq(layoutCellWord('一二三四五六七').lines.length, 2, '7 字折成两行');
eq(CELL_WORD_BREAK, 7, '换行阈值是 7');

// 拆分方式：对半，第一行不短于第二行
eq(layoutCellWord('赤橙黄绿青蓝紫').lines, ['赤橙黄绿', '青蓝紫'], '7 字拆成 4+3');
eq(layoutCellWord('一二三四五六七八').lines, ['一二三四', '五六七八'], '8 字拆成 4+4');
eq(layoutCellWord('一二三四五六七八九').lines, ['一二三四五', '六七八九'], '9 字拆成 5+4');
eq(layoutCellWord('一二三四五六七八九十').lines, ['一二三四五', '六七八九十'], '10 字拆成 5+5');
eq(layoutCellWord('一二三四五六七八九十一二').lines, ['一二三四五六', '七八九十一二'], '12 字拆成 6+6');

// 拼回去必须和原文完全一致（没有丢字、没有重排）
const joined = (w: string) => layoutCellWord(w).lines.join('');
['一二三四五六七', '一二三四五六七八', '一二三四五六七八九十', '一二三四五六七八九十一二'].forEach((w) => {
  check(joined(w) === w, `${w.length} 字拆行后拼回与原文一致`);
});

// 极端长词才截断，且省略号算在 14 字内
const long = '一二三四五六七八九十一二三四五';
eq(layoutCellWord(long).lines.join('').length, CELL_WORD_MAX, `${long.length} 字截断到 ${CELL_WORD_MAX} 字`);
check(layoutCellWord(long).lines.join('').endsWith('…'), '超长词才出现省略号');
check(!layoutCellWord('一二三四五六七八九十一二').lines.join('').includes('…'), '14 字以内不出现省略号');

// 字号：一行里字数越多越小，但不小于 12
check(sizeForChars(2) === 18 && sizeForChars(3) === 16.5 && sizeForChars(5) === 13.5, '短词字号分级正确');
check(sizeForChars(6) === 12 && sizeForChars(7) === 12, '6 字以上一律 12px');
check(layoutCellWord('赤橙黄绿青蓝紫').font === sizeForChars(4), '7 字按最长行(4 字)取字号');
check(layoutCellWord('一二三四五六七八九十').font === sizeForChars(5), '10 字按最长行(5 字)取字号');

// 行距随字号缩放
check(lineGap(15) === 18 && lineGap(12) === 14, '行距随字号缩放');

// 空串不应崩
eq(layoutCellWord('').lines, [''], '空串返回空行而不是抛错');

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
