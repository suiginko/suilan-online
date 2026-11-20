import { createRoom } from '../src/engine';
import { exportRoomImage } from '../src/ui/exportImage';
import { BoardCell } from '../src/types';
import { COLS, ROWS } from '../src/hex';

/**
 * 导出图的排版探针：构造一局含长答案的局面，走真实的 exportRoomImage，
 * 把生成的 PNG 贴到页面上，供无头浏览器截图核对。仅开发验证用。
 */

const LONG: { row: number; col: number; owner: 'RED' | 'GREEN'; word: string }[] = [
  { row: 0, col: 1, owner: 'RED', word: '一二三四五六七八九十' },
  { row: 1, col: 1, owner: 'GREEN', word: '刻舟求剑的故事' },
  { row: 2, col: 1, owner: 'RED', word: '不到长城非好汉兮' },
  { row: 3, col: 1, owner: 'GREEN', word: '一二三四五六七八九十一二' },
  { row: 2, col: 2, owner: 'RED', word: '司母戊鼎' },
];

const board: BoardCell[] = [];
const map = new Map(LONG.map((w) => [`${w.row}-${w.col}`, w]));
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const hit = map.get(`${row}-${col}`);
    board.push({
      id: `cell-${row}-${col}`,
      row,
      col,
      code: `${String.fromCharCode(65 + row)}${col + 1}`,
      firstLetter: '',
      charCount: 2,
      owner: hit?.owner ?? null,
      revealedWord: hit?.word,
    });
  }
}

async function run() {
  // 无头环境不要真的触发下载
  HTMLAnchorElement.prototype.click = function noop() {};

  const state = createRoom('016');
  state.phase = 'result';
  state.round = 2;
  state.players = {
    RED_DESC: '测试者',
    RED_GUESS: '测试乙',
    GREEN_DESC: '测试丙',
    GREEN_GUESS: '路人甲',
  };
  // 故意把 ready 设成 true：对局中已不该再显示「已准备」
  state.ready = { RED_DESC: true, RED_GUESS: true, GREEN_DESC: true, GREEN_GUESS: true };
  state.board = board;
  state.currentCellId = null;
  // 含一次抢答的历史行：正确顺序应为 描述 → 抢答 → 答案✓（验证导出图与界面同源）
  state.history = [
    {
      cellId: 'cell-0-0',
      code: 'A1',
      owner: 'RED',
      word: '司母戊鼎',
      attempts: [
        {
          team: 'RED',
          describer: '测试者',
          description: '甲乙',
          guesser: '测试乙',
          guess: '司母戊鼎',
          outcome: 'correct',
          descAt: 100,
          guessAt: 300,
        },
        {
          team: 'GREEN',
          describer: '测试丙',
          description: null,
          guesser: '路人甲',
          guess: '不是这个',
          outcome: 'wrong',
          stolen: true,
          guessAt: 200,
        },
      ],
    },
  ];

  const out = await exportRoomImage(state);
  const url = URL.createObjectURL(out.blob);
  const img = document.createElement('img');
  img.src = url;
  img.style.width = '1080px';
  img.style.display = 'block';
  img.onload = () => {
    document.title = 'EXPORT-READY';
  };
  document.getElementById('out')!.appendChild(img);
  const note = document.getElementById('note')!;
  note.textContent = `导出方式：${out.method} · ${out.blob.size} 字节 · ${out.name}`;
}

run().catch((e) => {
  document.getElementById('note')!.textContent = `失败：${(e as Error).message}`;
});
