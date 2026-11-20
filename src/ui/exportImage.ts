import { CellRecord, GameState, SEAT_ORDER, roleName, roleOf, seatOf, teamName, teamOf } from '../types';
import { HistoryEvent, eventsOf as recordEvents } from '../records';
import { COLS, RADIUS, ROWS, hexCenter, hexPoints } from '../hex';
import { actingSeat } from './turn';
import { layoutCellWord, lineGap } from './wordFit';

/**
 * 把当前局面导出成一张 PNG：棋盘 + 四位选手昵称 + 全部历史描述与作答表格。
 *
 * 全部用 Canvas 手绘（而不是把 DOM 截图），因为：
 *   1. 不依赖 html2canvas 之类的额外依赖；
 *   2. 只有棋盘/表格两类元素，手绘能保证清晰度与排版稳定；
 *   3. 不受页面滚动位置、缩放、暗色模式影响。
 */

const FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';
const SERIF = '"Songti SC", "SimSun", Georgia, serif';

const C = {
  paper: '#f7f4ee',
  card: '#ffffff',
  ink: '#1b2330',
  muted: '#5c6878',
  faint: '#8b95a4',
  line: '#e4ded3',
  red: '#b42318',
  redSoft: '#fdecea',
  green: '#146c43',
  greenSoft: '#e8f6ec',
  gold: '#9a5b13',
  goldSoft: '#fdf3e3',
  blue: '#1f4e79',
  blueSoft: '#eef4fa',
};

const PAD = 36;
const W = 1240;
const INNER = W - PAD * 2;
const SCALE = 2;

/** 事件类型与展开规则都在 `records.ts`，与界面共用（含抢答插队的时间排序） */
type Ev = Pick<HistoryEvent, 'kind' | 'team' | 'text'>;
type Row = { code: string; owner: 'RED' | 'GREEN' | null; live: boolean; lines: Ev[][] };

const eventsOf = (record: CellRecord): Ev[] =>
  recordEvents(record).map(({ kind, team, text }) => ({ kind, team, text }));

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function fillRound(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  stroke?: string
) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

const evFont = (ev: Ev) => {
  // 与界面一致：描述/作答/答案都用正文字体，猜中不再加粗（只有颜色区分阵营）
  if (ev.kind === 'desc') return `500 17px ${FONT}`;
  if (ev.kind === 'answer') return `500 18px ${FONT}`;
  if (ev.kind === 'note') return `15px ${FONT}`;
  return `500 17px ${FONT}`;
};

const evColor = (ev: Ev) => {
  if (!ev.team) return C.faint;
  return ev.team === 'RED' ? C.red : C.green;
};

/** 事件占多宽（描述是带框的胶囊，其他是纯文字） */
function evWidth(ctx: CanvasRenderingContext2D, ev: Ev): number {
  ctx.font = evFont(ev);
  const w = ctx.measureText(ev.text).width;
  return ev.kind === 'desc' ? w + 24 : w;
}

const EV_GAP = 14;
const LINE_H = 34;

/** 把一条记录的事件按可用宽度折行 */
function wrapEvents(ctx: CanvasRenderingContext2D, events: Ev[], maxWidth: number): Ev[][] {
  const lines: Ev[][] = [];
  let cur: Ev[] = [];
  let x = 0;
  for (const ev of events) {
    const w = evWidth(ctx, ev);
    if (cur.length && x + w > maxWidth) {
      lines.push(cur);
      cur = [];
      x = 0;
    }
    cur.push(ev);
    x += w + EV_GAP;
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [[]];
}

interface Layout {
  height: number;
  boardTop: number;
  boardScale: number;
  seatsTop: number;
  recTop: number;
  recRowsTop: number;
  rows: Row[];
  rowHeights: number[];
  headerH: number;
}

function computeLayout(ctx: CanvasRenderingContext2D, state: GameState): Layout {
  const seatsTop = 108;
  const seatsH = 104;
  const boardScale = 1.42;
  const boardH = 435 * boardScale;
  const boardTop = seatsTop + seatsH + 22;
  const boardCardH = boardH + 64;
  const recTop = boardTop + boardCardH + 22;

  const rows: Row[] = [...(state.history ?? [])]
    .slice()
    .reverse()
    .map((r) => ({
      code: r.code,
      owner: r.owner,
      live: r.cellId === state.currentCellId && !r.owner,
      lines: wrapEvents(ctx, eventsOf(r), INNER - 24 - 96 - 24),
    }));

  const rowHeights = rows.map((r) => Math.max(56, r.lines.length * LINE_H + 26));
  const headerH = 96;
  const rowsH = rowHeights.reduce((a, b) => a + b, 0);
  const recCardH = headerH + (rows.length ? rowsH : 60) + 24;
  const height = recTop + recCardH + 72;

  return {
    height,
    boardTop,
    boardScale,
    seatsTop,
    recTop,
    recRowsTop: recTop + headerH,
    rows,
    rowHeights,
    headerH,
  };
}

function drawHeader(ctx: CanvasRenderingContext2D, state: GameState) {
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.ink;
  ctx.font = `600 30px ${SERIF}`;
  ctx.fillText('随蓝射覆 · 对局局面', PAD, 52);

  const phase =
    state.phase === 'lobby'
      ? '等待开局'
      : state.phase === 'finished'
        ? `${teamName(state.winner ?? 'RED')} 获胜`
        : `第 ${state.round} 回合`;

  const parts = [`房号 ${state.roomCode}`, phase, state.pausedAt ? '已暂停' : '进行中'];
  ctx.font = `14px ${FONT}`;
  const metaW = parts.reduce((a, p) => a + ctx.measureText(p).width + 26, 0);
  let mx = W - PAD - metaW;
  for (const p of parts) {
    ctx.font = `14px ${FONT}`;
    const tw = ctx.measureText(p).width;
    const pw = tw + 22;
    fillRound(ctx, mx, 30, pw, 30, 15, C.card, C.line);
    ctx.fillStyle = C.muted;
    ctx.fillText(p, mx + 11, 50);
    mx += pw + 8;
  }

  ctx.fillStyle = C.faint;
  ctx.font = `13px ${FONT}`;
  ctx.fillText(
    new Date().toLocaleString('zh-CN', { hour12: false }),
    PAD,
    78
  );
}

function drawSeats(ctx: CanvasRenderingContext2D, state: GameState, top: number) {
  const gap = 12;
  const cardW = (INNER - gap * 3) / 4;
  const active = actingSeat(state);

  SEAT_ORDER.forEach((seat, i) => {
    const x = PAD + i * (cardW + gap);
    const team = teamOf(seat);
    const mine = active === seat;
    const name = state.players[seat] ?? '空位';
    const bg = team === 'RED' ? (mine ? C.redSoft : '#fffaf9') : mine ? C.greenSoft : '#f9fdfa';
    const stroke = mine ? (team === 'RED' ? C.red : C.green) : C.line;
    fillRound(ctx, x, top, cardW, 92, 14, bg, stroke);

    ctx.fillStyle = C.faint;
    ctx.font = `12px ${FONT}`;
    ctx.fillText(`${teamName(team)} · ${roleName(roleOf(seat))}`, x + 18, top + 24);

    ctx.fillStyle = C.ink;
    ctx.font = `600 21px ${FONT}`;
    ctx.fillText(name, x + 18, top + 54);

    const ready = state.ready?.[seat];
    // 准备状态只在大厅有意义：对局中/结束后还挂着「已准备」会误导看截图的人
    const tag = mine
      ? '行动中'
      : state.phase !== 'lobby'
        ? null
        : ready
          ? '已准备'
          : state.players[seat]
            ? '待准备'
            : '虚位以待';
    if (tag) {
      ctx.font = `12px ${FONT}`;
      const tw = ctx.measureText(tag).width;
      const tColor = mine ? (team === 'RED' ? C.red : C.green) : ready ? C.green : C.faint;
      fillRound(ctx, x + 18, top + 64, tw + 18, 20, 10, mine ? '#fff' : C.card, tColor);
      ctx.fillStyle = tColor;
      ctx.fillText(tag, x + 27, top + 78);
    }
  });
}

function drawBoard(ctx: CanvasRenderingContext2D, state: GameState, top: number, scale: number) {
  fillRound(ctx, PAD, top, INNER, 435 * scale + 64, 16, C.card, C.line);

  ctx.fillStyle = C.ink;
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText('棋盘', PAD + 24, top + 34);
  ctx.fillStyle = C.faint;
  ctx.font = `12px ${FONT}`;
  ctx.fillText('红方纵向连通 · 绿方横向连通', PAD + 76, top + 34);

  const x0 = PAD + (INNER - 665 * scale) / 2;
  const y0 = top + 56;
  const radius = RADIUS * scale;

  if (!state.board.length) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const { cx, cy } = hexCenter(r, c);
        ctx.beginPath();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = '#dcd5c8';
        ctx.lineWidth = 1.2;
        ctx.fillStyle = '#fbf9f5';
        const pts = hexPoints(x0 + cx * scale, y0 + cy * scale, radius);
        const [first, ...rest] = pts.split(' ');
        const [fx, fy] = first.split(',').map(Number);
        ctx.moveTo(fx, fy);
        for (const p of rest) {
          const [px, py] = p.split(',').map(Number);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.fillStyle = C.faint;
    ctx.font = `16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('等待导入本局题库', x0 + 332 * scale, y0 + 216 * scale);
    ctx.textAlign = 'left';
    return;
  }

  for (const cell of state.board) {
    const { cx, cy } = hexCenter(cell.row, cell.col);
    const px = x0 + cx * scale;
    const py = y0 + cy * scale;
    const owner = cell.owner ?? 'none';
    const isCurrent = cell.id === state.currentCellId;
    const fill = owner === 'RED' ? '#fbe9e7' : owner === 'GREEN' ? '#e6f4ea' : '#ffffff';
    const stroke = isCurrent ? '#c98a2b' : owner === 'RED' ? '#c2605a' : owner === 'GREEN' ? '#5c9a76' : '#d5cdc0';

    ctx.beginPath();
    const pts = hexPoints(px, py, radius);
    const [first, ...rest] = pts.split(' ');
    const [fx, fy] = first.split(',').map(Number);
    ctx.moveTo(fx, fy);
    for (const p of rest) {
      const [qx, qy] = p.split(',').map(Number);
      ctx.lineTo(qx, qy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = isCurrent ? 3.6 : 1.4;
    ctx.stroke();

    ctx.textAlign = 'center';
    const word = cell.owner && cell.revealedWord ? cell.revealedWord : null;
    if (word) {
      const fit = layoutCellWord(word);
      ctx.fillStyle = owner === 'RED' ? '#a8544d' : '#3f7a5c';
      ctx.font = `500 ${Math.round(12.5 * scale)}px ${FONT}`;
      ctx.fillText(cell.code, px, py - 16 * scale);
      ctx.fillStyle = owner === 'RED' ? '#8f2b23' : '#1c6444';
      ctx.font = `600 ${Math.round(fit.font * scale)}px ${FONT}`;
      const gap = lineGap(fit.font) * scale;
      fit.lines.forEach((line, li) => {
        ctx.fillText(line, px, py + 9 * scale + (li - (fit.lines.length - 1) / 2) * gap);
      });
    } else {
      ctx.fillStyle = owner === 'RED' ? '#8f2b23' : owner === 'GREEN' ? '#1c6444' : '#1b2330';
      ctx.font = `600 ${Math.round(21 * scale)}px ${FONT}`;
      ctx.fillText(cell.code, px, py + 7 * scale);
    }
    ctx.textAlign = 'left';
  }
}

function drawRecords(ctx: CanvasRenderingContext2D, state: GameState, layout: Layout) {
  const top = layout.recTop;
  const rowsH = layout.rowHeights.reduce((a, b) => a + b, 0);
  fillRound(ctx, PAD, top, INNER, layout.headerH + (layout.rows.length ? rowsH : 60) + 24, 16, C.card, C.line);

  ctx.fillStyle = C.ink;
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText('对局历史', PAD + 24, top + 34);
  ctx.fillStyle = C.faint;
  ctx.font = `12px ${FONT}`;
  ctx.fillText(`${layout.rows.length} 格`, PAD + 100, top + 34);

  // 图例（右对齐，从左到右：红方描述 → 红方猜词 → 绿方描述 → 绿方猜词 → 答对猜中）
  const legend: { text: string; kind: Ev['kind']; team: 'RED' | 'GREEN' }[] = [
    { text: '红方描述', kind: 'desc', team: 'RED' },
    { text: '红方猜词', kind: 'guess', team: 'RED' },
    { text: '绿方描述', kind: 'desc', team: 'GREEN' },
    { text: '绿方猜词', kind: 'guess', team: 'GREEN' },
    { text: '答对猜中 ✓', kind: 'answer', team: 'RED' },
  ];
  const widths = legend.map((item) => evWidth(ctx, { kind: item.kind, team: item.team, text: item.text }));
  const total = widths.reduce((a, b) => a + b, 0) + EV_GAP * (legend.length - 1);
  let lx = PAD + INNER - 24 - total;
  legend.forEach((item, i) => {
    const ev: Ev = { kind: item.kind, team: item.team, text: item.text };
    const w = widths[i];
    if (item.kind === 'desc') {
      fillRound(ctx, lx, top + 18, w, 26, 13, item.team === 'RED' ? C.redSoft : C.greenSoft, evColor(ev));
      ctx.fillStyle = evColor(ev);
      ctx.font = evFont(ev);
      ctx.fillText(item.text, lx + 12, top + 37);
    } else {
      ctx.fillStyle = evColor(ev);
      ctx.font = evFont(ev);
      ctx.fillText(item.text, lx, top + 37);
    }
    lx += w + EV_GAP;
  });
  ctx.fillStyle = C.faint;
  ctx.font = `12px ${FONT}`;
  ctx.fillText('图例', PAD + INNER - 24 - total - 38, top + 36);

  // 表头
  const headY = top + 58;
  ctx.fillStyle = C.faint;
  ctx.font = `12px ${FONT}`;
  ctx.fillText('格子', PAD + 24, headY);
  ctx.fillText('过程记录', PAD + 120, headY);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD + 16, headY + 12);
  ctx.lineTo(PAD + INNER - 16, headY + 12);
  ctx.stroke();

  if (!layout.rows.length) {
    ctx.fillStyle = C.faint;
    ctx.font = `14px ${FONT}`;
    ctx.fillText('还没有记录', PAD + 24, headY + 48);
    return;
  }

  let y = headY + 12;
  layout.rows.forEach((row, idx) => {
    const h = layout.rowHeights[idx];
    if (row.live) {
      ctx.fillStyle = '#fdf9f0';
      ctx.fillRect(PAD + 14, y + 1, INNER - 28, h - 2);
    }

    // 格子代号
    ctx.font = `600 15px ${FONT}`;
    const codeW = Math.max(52, ctx.measureText(row.code).width + 22);
    fillRound(ctx, PAD + 24, y + 16, codeW, 26, 8, '#f3efe7', C.line);
    ctx.fillStyle = C.ink;
    ctx.fillText(row.code, PAD + 35, y + 34);

    if (row.owner) {
      ctx.beginPath();
      ctx.arc(PAD + 32 + codeW, y + 29, 4, 0, Math.PI * 2);
      ctx.fillStyle = row.owner === 'RED' ? C.red : C.green;
      ctx.fill();
    }
    if (row.live) {
      ctx.fillStyle = C.faint;
      ctx.font = `11px ${FONT}`;
      ctx.fillText('进行中', PAD + 24, y + 56);
    }

    // 事件
    const startX = PAD + 120;
    if (!row.lines[0]?.length) {
      ctx.fillStyle = C.faint;
      ctx.font = `14px ${FONT}`;
      ctx.fillText('等待描述', startX, y + 34);
    } else {
      row.lines.forEach((line, li) => {
        let x = startX;
        const baseY = y + 34 + li * LINE_H;
        for (const ev of line) {
          ctx.font = evFont(ev);
          const w = evWidth(ctx, ev);
          if (ev.kind === 'desc') {
            fillRound(
              ctx,
              x,
              baseY - 18,
              w,
              26,
              13,
              ev.team === 'RED' ? C.redSoft : C.greenSoft,
              ev.team === 'RED' ? C.red : C.green
            );
            ctx.fillStyle = evColor(ev);
            ctx.fillText(ev.text, x + 12, baseY);
            x += w + EV_GAP;
          } else {
            ctx.fillStyle = evColor(ev);
            ctx.fillText(ev.text, x, baseY);
            x += w + EV_GAP;
          }
        }
      });
    }

    y += h;
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(PAD + 16, y);
    ctx.lineTo(PAD + INNER - 16, y);
    ctx.stroke();
  });
}

function drawFooter(ctx: CanvasRenderingContext2D, height: number) {
  ctx.fillStyle = C.faint;
  ctx.font = `12px ${FONT}`;
  ctx.fillText('随蓝射覆在线对战', PAD, height - 30);
}

export interface ImageOutcome {
  /** clipboard = 已复制到剪贴板；download = 剪贴板不可用，退化成下载 */
  method: 'clipboard' | 'download';
  blob: Blob;
  name: string;
}

/**
 * 生成局面图并放进剪贴板（不再下载文件）。
 *
 * 剪贴板 API 需要 https + 页面有焦点；拿不到权限时退化成下载，
 * 至少不会让「复制」这个动作彻底失败。
 */
export async function exportRoomImage(state: GameState): Promise<ImageOutcome> {
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('当前浏览器不支持导出图片');

  const layout = computeLayout(measure, state);

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = Math.ceil(layout.height * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持导出图片');

  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, layout.height);
  ctx.textBaseline = 'alphabetic';

  drawHeader(ctx, state);
  drawSeats(ctx, state, layout.seatsTop);
  drawBoard(ctx, state, layout.boardTop, layout.boardScale);
  drawRecords(ctx, state, layout);
  drawFooter(ctx, layout.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) throw new Error('导出失败，请重试');

  const name = `随蓝射覆-${state.roomCode}-第${state.round}回合.png`;

  try {
    if (!navigator.clipboard?.write || typeof window.ClipboardItem === 'undefined') {
      throw new Error('no clipboard');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return { method: 'clipboard', blob, name };
  } catch {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 留足时间给浏览器真正落盘/预览，避免刚生成就失效
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { method: 'download', blob, name };
  }
}
