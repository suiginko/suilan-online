import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { Board } from '../src/ui/Board';
import { BoardCell } from '../src/types';
import { COLS, ROWS } from '../src/hex';

/**
 * 把 Board 渲染成静态 HTML，用于真实浏览器截图核对排版。
 * 只跑在开发验证阶段，不参与应用运行。
 */

const WORDS: CellRecord[] = [
  { row: 0, col: 1, owner: 'RED', word: '山' },
  { row: 1, col: 1, owner: 'RED', word: '图书馆' },
  { row: 2, col: 1, owner: 'RED', word: '一望无际' },
  { row: 3, col: 1, owner: 'GREEN', word: '刻舟求剑的故事' }, // 7 字
  { row: 4, col: 1, owner: 'GREEN', word: '不到长城非好汉兮' }, // 8 字
  { row: 2, col: 3, owner: 'RED', word: '一寸光阴一寸金寸金' }, // 10 字
  { row: 3, col: 3, owner: 'GREEN', word: '一二三四五六七八九十一二' }, // 12 字
  { row: 1, col: 3, owner: null, word: '赤橙黄绿青蓝紫' }, // 7 字，未占领应不显示
];

type CellRecord = { row: number; col: number; owner: 'RED' | 'GREEN' | null; word: string };

const board: BoardCell[] = [];
const byKey = new Map(WORDS.map((w) => [`${w.row}-${w.col}`, w]));
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const hit = byKey.get(`${row}-${col}`);
    board.push({
      id: `cell-${row}-${col}`,
      row,
      col,
      code: `${String.fromCharCode(65 + row)}${col + 1}`,
      firstLetter: '',
      charCount: 2,
      owner: hit?.owner ?? null,
      revealedWord: hit?.owner ? hit.word : undefined,
    });
  }
}

const svg = renderToStaticMarkup(
  React.createElement(Board, {
    board,
    currentCellId: null,
    canSelect: false,
    onSelect: () => {},
    allCellWords: null,
    showRefereeWords: false,
  })
);

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<link rel="stylesheet" href="../src/styles.css">
<style>
  body { margin:0; background:#f7f4ee; font-family:"Microsoft YaHei",system-ui,sans-serif; }
  .wrap { padding:16px; }
  h1 { font:600 16px/1.4 "Microsoft YaHei"; color:#1b2330; margin:8px 4px 12px; }
  .board-wrap { width:760px; }
</style>
<body><div class="wrap">
<h1>棋盘答案排版验证（7/8/10/12 字应换行且不出省略号）</h1>
${svg}
</div></body></html>`;

const out = path.resolve('shot/board-wrap.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(out);
