/**
 * 观众猜词（`specGuess`）。
 *
 * 规则层要保证四件事：
 *   ① 猜中只公开「观众 xx 猜中了 A2 格」，**答案这个词不出现在任何公开文本里**；
 *   ② 猜错不公开（写进战况等于把答案逐字排除给全房间看）；
 *   ③ 完全不影响对局——不换格、不计分、不推进计时、不结算；
 *   ④ 次数按「一个观众 × 一个格子」封顶，换格/换题/重开清零。
 */
import { advance, applyIntent, createRoom, prepareSecrets, withBank } from '../src/engine';
import { GameState, MAX_SPEC_GUESS, Secrets, SEAT_ORDER, WordEntry } from '../src/types';

let seed = 20261110;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const WORDS: WordEntry[] = Array.from({ length: 60 }, (_, i) => ({
  word: `样例词${String.fromCharCode(0x4e00 + i)}`,
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

function step(ctx: Ctx, intent: Parameters<typeof applyIntent>[2], now = T0): Ctx {
  const r = applyIntent(ctx.state, ctx.secrets, intent, now);
  if (r.error) throw new Error(`意外被拒：${intent.t} → ${r.error}`);
  return { state: r.state, secrets: r.secrets };
}

/** 猜一次词的完整回执（含被拒的情况） */
function guess(ctx: Ctx, id: string, text: string, now = T0) {
  return applyIntent(ctx.state, ctx.secrets, { t: 'specGuess', id, text }, now);
}

const CLUE = '甲乙丙丁戊己庚辛壬癸子丑寅卯';
function clueFor(answer: string): string {
  const banned = new Set([...answer]);
  return [...CLUE].filter((c) => !banned.has(c)).slice(0, 2).join('');
}

/** 开局 → 第一位描述位选格 → 写描述，停在「等待本方作答」 */
function atGuessPhase(): { ctx: Ctx; cellId: string; word: string } {
  let ctx: Ctx = { state: createRoom('123'), secrets: prepareSecrets(WORDS) };
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'join', seat, name: `选手${seat}` });
  ctx = step(ctx, { t: 'watch', id: 'spec-a', name: '路人甲' });
  ctx = step(ctx, { t: 'watch', id: 'spec-b', name: '路人乙' });
  ctx.state = withBank(ctx.state, { name: '测试题库', count: WORDS.length, fingerprint: 'T' });
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'ready', seat, value: true });
  const started = advance(ctx.state, ctx.secrets, T0);
  ctx = { state: started.state, secrets: started.secrets };

  const cell = ctx.state.board[0];
  const word = ctx.secrets.cellWords[cell.id].word;
  ctx = step(ctx, { t: 'select', seat: 'RED_DESC', cellId: cell.id }, T0 + 1000);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  return { ctx, cellId: cell.id, word };
}

console.log('\n== 观众猜词 ==\n');

// ── 1. 猜中：公开「猜中了」，不公开词 ──────────────────────
{
  const { ctx, cellId, word } = atGuessPhase();
  const before = ctx.state.log.length;
  const r = guess(ctx, 'spec-a', word, T0 + 3000);

  check(!r.error, `观众可以猜词（${r.error ?? 'ok'}）`);
  check(r.guessHit === true, '猜中时回执 hit=true');
  check(r.state.log.length === before + 1, '猜中会在战况里多一条');
  check(r.state.log[0].text === `观众 路人甲 猜中了 ${r.state.board.find((c) => c.id === cellId)!.code} 格`,
    `战况文案只说「猜中了」：${r.state.log[0].text}`);
  check(!r.state.log[0].text.includes(word), '战况里没有出现答案本身');
  check(!JSON.stringify(r.state).includes(word), '整个公开快照里都不含答案');
  check(r.secrets.specGuesses?.['spec-a']?.hit === true, 'vault 里记账为已猜中（不进公开快照）');
  check(!JSON.stringify(r.state).includes('specGuesses'), '猜词记账不出现在公开快照里');
}

// ── 2. 不影响对局 ─────────────────────────────────────────
{
  const { ctx, cellId } = atGuessPhase();
  const before = ctx.state;
  const r = guess(ctx, 'spec-a', ctx.secrets.cellWords[cellId].word, T0 + 3000);

  check(r.state.phase === 'guess', '猜中不改变阶段（仍在本方作答）');
  check(r.state.currentCellId === cellId, '猜中不换格');
  check(r.state.deadlineAt === before.deadlineAt, '猜中不动计时');
  check(r.state.result === null && r.state.winner === null, '猜中不结算、不判胜');
  check(r.state.board.every((c) => !c.owner), '猜中不占领任何格子');
  check(r.state.history[0].attempts[0].outcome === null, '对局记录里不会多出一次「作答」');
}

// ── 3. 猜错：只有自己知道，不进公开战况 ─────────────────────
{
  const { ctx } = atGuessPhase();
  const before = ctx.state.log.length;
  const r = guess(ctx, 'spec-a', '肯定不是这个', T0 + 3000);

  check(!r.error, '猜错不算非法操作');
  check(r.guessHit === false, '猜错时回执 hit=false');
  check(r.state.log.length === before, '猜错不往战况里写字');
  check(r.secrets.specGuesses?.['spec-a']?.hit === false, '猜错只在自己的账本里记一次');
  check(r.secrets.specGuesses?.['spec-a']?.tries === 1, '猜错计入次数');
}

// ── 4. 同一格重复猜中只记一条 ──────────────────────────────
{
  const { ctx, cellId } = atGuessPhase();
  const word = ctx.secrets.cellWords[cellId].word;
  const first = guess(ctx, 'spec-a', word, T0 + 3000);
  const again = guess({ state: first.state, secrets: first.secrets }, 'spec-a', word, T0 + 4000);

  check(again.guessHit === true, '再猜一次仍回执 hit=true');
  check(again.state.log.length === first.state.log.length, '同一格重复猜中不会刷第二条战况');
}

// ── 5. 次数上限 ───────────────────────────────────────────
{
  const { ctx } = atGuessPhase();
  let cur = ctx;
  let rejected = '';
  for (let i = 0; i < MAX_SPEC_GUESS; i++) {
    const r = guess(cur, 'spec-b', `错词${i}`, T0 + 3000 + i);
    if (r.error) rejected = r.error;
    cur = { state: r.state, secrets: r.secrets };
  }
  check(!rejected, `前 ${MAX_SPEC_GUESS} 次都不会被拒`);
  const over = guess(cur, 'spec-b', '再猜一次', T0 + 9000);
  check(!!over.error, `第 ${MAX_SPEC_GUESS + 1} 次被拒：${over.error}`);
  check(over.state === cur.state, '被拒的猜词不写库（state 原样返回）');
}

// ── 6. 换格清零 ───────────────────────────────────────────
{
  const { ctx, cellId } = atGuessPhase();
  const word = ctx.secrets.cellWords[cellId].word;
  let cur = guess(ctx, 'spec-a', word, T0 + 3000);
  // 用尽之后本题结算：本方猜对 → 结算 → 下一回合
  cur = step({ state: cur.state, secrets: cur.secrets }, { t: 'guess', seat: 'RED_GUESS', text: word }, T0 + 4000);
  cur = step({ state: cur.state, secrets: cur.secrets }, { t: 'next' }, T0 + 5000);
  check(cur.state.phase === 'select', '本格结算后回到选格');

  const nextCell = cur.state.board.find((c) => !c.owner)!;
  cur = step({ state: cur.state, secrets: cur.secrets }, { t: 'select', seat: 'RED_DESC', cellId: nextCell.id }, T0 + 6000);
  check(Object.keys(cur.secrets.specGuesses ?? {}).length === 0, '换格后清零（新格子重新计数）');
  const r = guess({ state: cur.state, secrets: cur.secrets }, 'spec-a', cur.secrets.cellWords[nextCell.id].word, T0 + 7000);
  check(r.guessHit === true, '新格子里又能猜中');
  check(r.state.log[0].text.includes('猜中了'), '新格子的猜中同样进战况');
}

// ── 7. 不该猜的时候拒绝 ───────────────────────────────────
{
  let ctx: Ctx = { state: createRoom('123'), secrets: prepareSecrets(WORDS) };
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'join', seat, name: `选手${seat}` });
  ctx = step(ctx, { t: 'watch', id: 'spec-a', name: '路人甲' });
  const lobby = guess(ctx, 'spec-a', '随便猜', T0);
  check(/没有正在猜的格子/.test(lobby.error ?? ''), `大厅阶段不能猜：${lobby.error}`);

  const { ctx: inCell } = atGuessPhase();
  const empty = guess(inCell, 'spec-a', '   ', T0 + 3000);
  check(/不能为空/.test(empty.error ?? ''), `空猜词被拒：${empty.error}`);
  const anonymous = guess(inCell, '', '随便猜', T0 + 3000);
  check(/身份缺失/.test(anonymous.error ?? ''), `没有观战身份被拒：${anonymous.error}`);
}

// ── 8. 别名也算猜中，但战况仍然只写「猜中了」 ───────────────
{
  const { ctx, cellId } = atGuessPhase();
  const patched: Ctx = {
    state: ctx.state,
    secrets: { ...ctx.secrets, cellWords: { ...ctx.secrets.cellWords, [cellId]: { word: '苹果', alt: ['红苹果'] } } },
  };
  const r = guess(patched, 'spec-a', '红苹果', T0 + 3000);
  check(r.guessHit === true, '词表里的别名同样算猜中');
  check(!r.state.log[0].text.includes('红苹果'), '别名不会写进战况');
}

// ── 9. 昵称以观战名单为准（客户端自报不作数） ───────────────
{
  const { ctx, cellId } = atGuessPhase();
  const r = applyIntent(
    ctx.state,
    ctx.secrets,
    { t: 'specGuess', id: 'spec-a', name: '我改名了', text: ctx.secrets.cellWords[cellId].word },
    T0 + 3000
  );
  check(r.state.log[0].text.startsWith('观众 路人甲'), '战况用观战名单里的昵称，不用客户端自报的');
}

if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n全部通过：${pass} 项\n`);
