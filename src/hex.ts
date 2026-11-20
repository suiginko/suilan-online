import { BoardCell, Team } from './types';

export const ROWS = 5;
export const COLS = 5;
export const RADIUS = 52;
export const DX = Math.sqrt(3) * RADIUS;
export const DY = 1.5 * RADIUS;
export const ORIGIN_X = 64;
export const ORIGIN_Y = 62;

export function hexPoints(cx: number, cy: number, radius = RADIUS): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** 行 0 在最右上、行 4 在最左下，与工作台棋盘一致 */
export function hexCenter(row: number, col: number): { cx: number; cy: number } {
  return {
    cx: ORIGIN_X + col * DX + (ROWS - 1 - row) * (DX / 2),
    cy: ORIGIN_Y + row * DY,
  };
}

/**
 * 六个邻居的**位置**（不是 id）。
 *
 * 这里刻意不返回 `cell-${r}-${c}` 这样的 id：裁判「交换两格位置」只改 row/col，
 * 格子的 id 会留在原处，于是 id 不再编码坐标。判胜以前按 id 走邻居，
 * 结果把物理上不相邻的两格连成一条线（现场表现：裁判换格之后，
 * 某一方刚答对就被判「对方连通成线」）。几何一律以 row/col 为准。
 */
export function neighborPositions(row: number, col: number): Array<{ row: number; col: number }> {
  const list = [
    { row, col: col - 1 },
    { row, col: col + 1 },
    { row: row - 1, col: col - 1 },
    { row: row - 1, col },
    { row: row + 1, col },
    { row: row + 1, col: col + 1 },
  ];
  return list.filter((n) => n.row >= 0 && n.row < ROWS && n.col >= 0 && n.col < COLS);
}

const posKey = (row: number, col: number) => `${row},${col}`;

/**
 * 红方纵向（行 0 → 行 4）连通获胜；绿方横向（列 0 → 列 4）连通获胜。
 * 与工作台的 checkWinCondition 判定邻居关系一致。
 *
 * 遍历的是「位置」，不是格子 id：id 在裁判换格之后不再对应坐标，
 * 用它当邻接键会凭空连出线路。返回的 path 仍是格子 id（给界面高亮用）。
 */
export function findWinner(board: BoardCell[]): { winner: Team | null; path: string[] } {
  const at = new Map<string, BoardCell>();
  for (const c of board) at.set(posKey(c.row, c.col), c);

  const bfs = (team: Team, startTest: (c: BoardCell) => boolean, goalTest: (c: BoardCell) => boolean) => {
    for (const start of board.filter((c) => c.owner === team && startTest(c))) {
      const startKey = posKey(start.row, start.col);
      const queue: { key: string; path: string[] }[] = [{ key: startKey, path: [start.id] }];
      const seen = new Set([startKey]);
      while (queue.length) {
        const { key, path } = queue.shift()!;
        const cell = at.get(key);
        if (!cell) continue;
        if (goalTest(cell)) return { winner: team, path };
        for (const n of neighborPositions(cell.row, cell.col)) {
          const nk = posKey(n.row, n.col);
          const next = at.get(nk);
          if (!next || next.owner !== team || seen.has(nk)) continue;
          seen.add(nk);
          queue.push({ key: nk, path: [...path, next.id] });
        }
      }
    }
    return { winner: null as Team | null, path: [] as string[] };
  };

  const red = bfs('RED', (c) => c.row === 0, (c) => c.row === ROWS - 1);
  if (red.winner) return red;

  const green = bfs('GREEN', (c) => c.col === 0, (c) => c.col === COLS - 1);
  if (green.winner) return green;

  return { winner: null, path: [] };
}
