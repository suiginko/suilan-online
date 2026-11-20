/**
 * 裁判换格之后的判胜回归。
 *
 * 现场事故（2026-11-10，房号 000）：裁判「改格子 / 换格子位置」之后，
 * 绿方正常答对一格，同一毫秒却判「红方 连通成线，对局结束」。
 *
 * 根因：`neighbors()` 以前返回 `cell-${r}-${c}` 当邻接键，而 `refereeSwapCells`
 * 只交换 row/col、**不动 id**。于是 id 不再编码坐标，判胜 BFS 在 id 网格上乱走，
 * 把物理上隔着好几格的两个红格连成一条从行 0 到行 4 的线。
 *
 * 这份测试锁两件事：
 *   ① 换格后不相邻的两格**不能**被判连通（本次 bug）；
 *   ② 换格后真正连成一片的仍然照常判胜（修 bug 不能把判胜一起修没了）。
 */
import { advance, applyIntent, createRoom, prepareSecrets, withBank } from '../src/engine';
import { findWinner } from '../src/hex';
import { GameState, Intent, Secrets, SEAT_ORDER, WordEntry } from '../src/types';

let seed = 20261110;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const WORDS: WordEntry[] = Array.from({ length: 60 }, (_, i) => ({
  word: `回归词${String.fromCharCode(0x4e00 + i)}`,
  hint: `第 ${i} 条`,
  category: '测试',
}));

const T0 = 1_700_000_000_000;
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

interface Ctx {
  state: GameState;
  secrets: Secrets;
}

function step(ctx: Ctx, intent: Intent, now = T0): Ctx {
  const r = applyIntent(ctx.state, ctx.secrets, intent, now);
  if (r.error) throw new Error(`意外被拒：${intent.t} → ${r.error}`);
  return { state: r.state, secrets: r.secrets };
}

function started(): Ctx {
  let ctx: Ctx = { state: createRoom('RGW'), secrets: prepareSecrets(WORDS) };
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'join', seat, name: `玩家${seat}` });
  ctx = {
    state: withBank(ctx.state, { name: '回归题库', count: WORDS.length, fingerprint: 'T' }),
    secrets: ctx.secrets,
  };
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'ready', seat, value: true });
  const a = advance(ctx.state, ctx.secrets, T0);
  return { state: a.state, secrets: a.secrets };
}

const cellOf = (s: GameState, id: string) => s.board.find((c) => c.id === id)!;

/** 直接给某格挂上归属（模拟「这格已经被这一方拿下」），比真的打完五格快 */
function own(ctx: Ctx, id: string, team: 'RED' | 'GREEN'): Ctx {
  const state = structuredClone(ctx.state);
  const cell = state.board.find((c) => c.id === id)!;
  cell.owner = team;
  cell.revealedWord = '占位词';
  return { state, secrets: ctx.secrets };
}

console.log('\n=== 裁判换格后的判胜 ===');

// ── ① 事故复现：红方只在 (0,0) 和 (1,1) 各有一格，把 (1,1) 那格换到 (4,1) ──
{
  let ctx = started();
  ctx = own(ctx, 'cell-0-0', 'RED'); // 留在 (0,0)
  ctx = own(ctx, 'cell-1-1', 'RED'); // 马上被换到 (4,1)
  const before = findWinner(ctx.state.board);
  check(before.winner === null, '换格之前：红方两格不相邻，不判胜');

  ctx = step(ctx, { t: 'refereeSwapCells', cellIdA: 'cell-1-1', cellIdB: 'cell-4-1' });
  check(cellOf(ctx.state, 'cell-1-1').row === 4, '换格后 cell-1-1 的物理位置到了行 4');
  check(cellOf(ctx.state, 'cell-1-1').id === 'cell-1-1', '换格不修改 id（这是本次事故的诱因）');

  const after = findWinner(ctx.state.board);
  check(after.winner === null, '换格之后：(0,0) 与 (4,1) 仍不相邻，不能判红方胜');
  check(after.path.length === 0, '换格之后：没有连出任何线路');
}

// ── ② 端到端：换格之后绿方正常答对，不能顺手把红方判成胜方 ──
{
  let ctx = started();
  ctx = own(ctx, 'cell-0-0', 'RED');
  ctx = own(ctx, 'cell-1-1', 'RED');
  ctx = step(ctx, { t: 'refereeSwapCells', cellIdA: 'cell-1-1', cellIdB: 'cell-4-1' });

  const target = 'cell-2-2';
  ctx = step(ctx, { t: 'select', seat: 'RED_DESC', cellId: target }, T0 + 1000);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: '甲乙' }, T0 + 2000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '肯定不是这个' }, T0 + 3000);
  ctx = step(ctx, { t: 'describe', seat: 'GREEN_DESC', text: '丙丁' }, T0 + 4000);
  const answer = ctx.secrets.cellWords[target].word;
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: answer }, T0 + 5000);

  check(ctx.state.phase !== 'finished', '绿方答对后没有结束对局');
  check(ctx.state.winner === null, '没有被判成红方获胜');
  check(cellOf(ctx.state, target).owner === 'GREEN', '这一格正常归绿方');
}

// ── ③ 反向保护：换格之后真的连成一片，仍然要判胜 ──
{
  let ctx = started();
  // 红方纵向：先占 (0,1)(1,1)(2,1)(3,1)，第 5 格 (4,1) 用别的格子换过来
  for (const id of ['cell-0-1', 'cell-1-1', 'cell-2-1', 'cell-3-1']) ctx = own(ctx, id, 'RED');
  const moved = ctx.state.board.find((c) => c.row === 0 && c.col === 4)!; // 行 0 最右那格
  ctx = own(ctx, moved.id, 'RED');

  const before = findWinner(ctx.state.board);
  check(before.winner === null, '换格之前：那条线还差一格，不判胜');

  ctx = step(ctx, { t: 'refereeSwapCells', cellIdA: moved.id, cellIdB: 'cell-4-1' });
  const after = findWinner(ctx.state.board);
  check(after.winner === 'RED', '换格之后：红方真的连通成线，照常判胜');
  check(after.path.length === 5, '判胜线路包含 5 格');
}

console.log(
  failures.length
    ? `\n结果：${pass} 项通过，${failures.length} 项失败\n${failures.map((f) => `  ✗ ${f}`).join('\n')}`
    : `\n结果：${pass} 项通过，0 项失败`
);
if (failures.length) process.exit(1);
