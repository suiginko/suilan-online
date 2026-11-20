import { advance, applyIntent, canSteal, createRoom, prepareSecrets, tick, undoableOf, withBank, withProposal } from '../src/engine';
import { GameState, Intent, Secrets, SEAT_ORDER, WordEntry } from '../src/types';
import { eventsOf } from '../src/records';
import { nextRoomCode } from '../server/crypto';

let seed = 20261019;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const WORDS: WordEntry[] = Array.from({ length: 60 }, (_, i) => ({
  word: `测试词${String.fromCharCode(0x4e00 + i)}`,
  hint: `第 ${i} 条提示`,
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

function reject(ctx: Ctx, intent: Intent, now = T0) {
  return applyIntent(ctx.state, ctx.secrets, intent, now).error ?? null;
}

function seated(words: WordEntry[] = WORDS): Ctx {
  let ctx: Ctx = { state: createRoom('123'), secrets: prepareSecrets(words) };
  for (const seat of SEAT_ORDER) {
    ctx = step(ctx, { t: 'join', seat, name: `玩家${seat}` });
  }
  return ctx;
}

/** 题库就绪 + 四席准备 + 推进 → 自动开局；`steal` 打开抢答（默认关闭） */
function started(opts: { steal?: boolean; words?: WordEntry[] } = {}): Ctx {
  const words = opts.words ?? WORDS;
  let ctx = seated(words);
  if (opts.steal) ctx = step(ctx, { t: 'setSteal', enabled: true });
  ctx = {
    state: withBank(ctx.state, { name: '测试题库', count: words.length, fingerprint: 'T' }),
    secrets: ctx.secrets,
  };
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'ready', seat, value: true });
  const a = advance(ctx.state, ctx.secrets, T0);
  return { state: a.state, secrets: a.secrets };
}

const CLUE = '甲乙丙丁戊己庚辛壬癸子丑寅卯';

function clueFor(answer: string): string {
  const banned = new Set([...answer]);
  return [...CLUE].filter((c) => !banned.has(c)).slice(0, 2).join('');
}

function answerOf(ctx: Ctx, cellId: string): string {
  return ctx.secrets.cellWords[cellId].word;
}

/** 选第一个格子，返回格子 id */
function pickFirst(ctx: Ctx): { ctx: Ctx; cellId: string } {
  const cell = ctx.state.board.find((c) => !c.owner)!;
  const seat = ctx.state.selector === 'RED' ? 'RED_DESC' : 'GREEN_DESC';
  const next = step(ctx, { t: 'select', seat, cellId: cell.id }, T0 + 1000);
  return { ctx: next, cellId: cell.id };
}

/** 正确作答当前格 */
function solveCurrent(ctx: Ctx, at = T0 + 2000): Ctx {
  const cellId = ctx.state.currentCellId!;
  const team = ctx.state.activeDescriber!;
  const descSeat = team === 'RED' ? 'RED_DESC' : 'GREEN_DESC';
  const guessSeat = team === 'RED' ? 'RED_GUESS' : 'GREEN_GUESS';
  let next = step(ctx, { t: 'describe', seat: descSeat, text: clueFor(answerOf(ctx, cellId)) }, at);
  next = step(next, { t: 'guess', seat: guessSeat, text: answerOf(next, cellId) }, at + 1000);
  return next;
}

console.log('\n== 开局条件 ==');

{
  const ctx = seated();
  check(ctx.state.phase === 'lobby', '四席坐满但无题库时仍在等待');
  const a = advance(ctx.state, ctx.secrets, T0);
  check(a.state.phase === 'lobby', '没有题库不会自动开局');
}

{
  let ctx = seated();
  ctx = { state: withBank(ctx.state, { name: 'b', count: 60, fingerprint: 'x' }), secrets: ctx.secrets };
  ctx = step(ctx, { t: 'ready', seat: 'RED_DESC', value: true });
  ctx = step(ctx, { t: 'ready', seat: 'RED_GUESS', value: true });
  ctx = step(ctx, { t: 'ready', seat: 'GREEN_DESC', value: true });
  const a = advance(ctx.state, ctx.secrets, T0);
  check(a.state.phase === 'lobby', '三席准备时不会自动开局');
  const full = step(ctx, { t: 'ready', seat: 'GREEN_GUESS', value: true });
  const b = advance(full.state, full.secrets, T0);
  check(b.state.phase === 'select', '四席准备 + 题库就绪后自动开局');
  check(b.state.board.length === 25, '开局后棋盘发满 25 格');
  check(b.state.deadlineAt === T0 + 90_000, '开局即开始选格计时');
}

{
  const ctx = seated();
  const err = reject(ctx, { t: 'start' });
  check(!!err, '缺题库时手动开局也被拒');
}

console.log('\n== 房间即入口：席位 / 昵称 / 观众 ==');

{
  const state = createRoom('456');
  check(state.players.RED_DESC === null, '新建房间没有任何人入座（房主只是观众）');
  check(state.ready.RED_DESC === false, '准备状态默认为未准备');
}

{
  let ctx: Ctx = { state: createRoom('457'), secrets: prepareSecrets(WORDS) };
  ctx = step(ctx, { t: 'watch', id: 'spec-1', name: '路人甲' });
  check(ctx.state.spectators.length === 1, '观众可以直接进入观战席');
  ctx = step(ctx, { t: 'join', seat: 'GREEN_DESC', name: '路人甲', specId: 'spec-1' });
  check(ctx.state.players.GREEN_DESC === '路人甲', '观众可以接替空位');
  check(ctx.state.spectators.length === 0, '接替后不再重复出现在观战名单');
}

{
  let ctx: Ctx = { state: createRoom('458'), secrets: prepareSecrets(WORDS) };
  ctx = step(ctx, { t: 'watch', id: 'spec-2', name: '观众一' });
  ctx = step(ctx, { t: 'rename', name: '新名字', specId: 'spec-2' });
  check(ctx.state.spectators[0].name === '新名字', '观众可以随时改昵称');
  ctx = step(ctx, { t: 'join', seat: 'RED_GUESS', name: '新名字', specId: 'spec-2' });
  ctx = step(ctx, { t: 'rename', name: '选手乙', seat: 'RED_GUESS' });
  check(ctx.state.players.RED_GUESS === '选手乙', '选手也可以随时改昵称');
}

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) });
  ctx = step(ctx, { t: 'rename', name: '改名后的红描', seat: 'RED_DESC' });
  const record = ctx.state.history[ctx.state.history.length - 1];
  check(record.attempts[0].describer === '改名后的红描', '改名会同步到当前格子的公开记录');
}

console.log('\n== 房号顺序分配 ==');

{
  check(nextRoomCode([]) === '000', '没有房间时从 000 开始分配');
  check(nextRoomCode(['000']) === '001', '紧接已被占用的号分配下一个');
  check(nextRoomCode(['000', '002']) === '001', '中间出现空号时补最小的空位');
  const almost = Array.from({ length: 999 }, (_, i) => String(i).padStart(3, '0'));
  check(nextRoomCode(almost) === '999', '只剩最后一个号时分配 999');
  const full = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
  check(nextRoomCode(full) === null, '1000 个号全部占用时返回 null（建房报「房号已用尽」）');
}

console.log('\n== 题库提案 ==');

{
  let ctx: Ctx = { state: createRoom('460'), secrets: prepareSecrets(WORDS) };
  ctx = {
    state: withProposal(ctx.state, { id: 'p1', name: '朋友传的题库', count: 30, fingerprint: 'AB', by: '观众甲', at: T0 }),
    secrets: ctx.secrets,
  };
  check(ctx.state.bankProposals.length === 1, '任何人上传的题库进入待审批列表');
  check(ctx.state.bank === null, '未经房主同意不进本局');
  ctx = step(ctx, { t: 'approveBank', id: 'p1' });
  check(ctx.state.bank?.name === '朋友传的题库', '房主同意后题库生效');
  check(ctx.state.bankProposals.length === 0, '同意后清空提案列表');
}

{
  let ctx: Ctx = { state: createRoom('461'), secrets: prepareSecrets(WORDS) };
  ctx = {
    state: withProposal(ctx.state, { id: 'p2', name: '不合适的题库', count: 30, fingerprint: 'CD', by: '观众乙', at: T0 }),
    secrets: ctx.secrets,
  };
  ctx = step(ctx, { t: 'rejectBank', id: 'p2' });
  check(ctx.state.bankProposals.length === 0 && ctx.state.bank === null, '房主拒绝后提案消失、本局题库不变');
}

console.log('\n== 描述与作答 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  check(ctx.state.phase === 'describe', '选格后进入描述阶段');
  check(ctx.state.history.length === 1, '公开记录为每个格子新建一行');
  check(ctx.state.history[0].cellId === picked.cellId, '记录行对应当前格子');

  const answer = answerOf(ctx, picked.cellId);
  const bad = answer[0];
  check(!!reject(ctx, { t: 'describe', seat: 'RED_DESC', text: '一' }), '一个字被拒');
  check(!!reject(ctx, { t: 'describe', seat: 'RED_DESC', text: '一二三' }), '三个字被拒');
  check(!!reject(ctx, { t: 'describe', seat: 'RED_DESC', text: `一${bad}` }), '含答案里的字被拒');
  check(!!reject(ctx, { t: 'describe', seat: 'GREEN_DESC', text: '甲乙' }), '非本方描述位不能写描述');

  const clue = clueFor(answer);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clue }, T0 + 1000);
  check(ctx.state.phase === 'guess', '描述提交后进入作答阶段');
  check(ctx.state.history[0].attempts[0].description === clue, '描述写入公开记录');
  check(ctx.state.deadlineAt === T0 + 1000 + 90_000, '作答有独立的 90 秒窗口（描述、作答各 90 秒）');
}

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const answer = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '完全不对' }, T0 + 2000);
  check(ctx.state.phase === 'describe', '答错后仍在这一格，回到描述阶段');
  check(ctx.state.activeDescriber === 'GREEN', '答错后改由对方描述');
  check(ctx.state.result === null, '答错不结算');
  check(ctx.state.history.length === 1, '答错不会新开一行记录');
  check(ctx.state.history[0].attempts.length === 1, '答错先留下本方这一条记录');
  check(ctx.state.history[0].attempts[0].outcome === 'wrong', '答错被记录');

  // 对方再答错 → 又轮回红方
  ctx = step(ctx, { t: 'describe', seat: 'GREEN_DESC', text: clueFor(answer) }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '还是不对' }, T0 + 4000);
  check(ctx.state.activeDescriber === 'RED', '两队交替描述，直到有人猜对');

  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 5000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: answer }, T0 + 6000);
  check(ctx.state.phase === 'result', '猜对后进入结算');
  check(ctx.state.history[0].owner === 'RED' && ctx.state.history[0].word === answer, '记录的格子行写下归属与答案');
  check(ctx.state.selector === 'RED', '答对方获得下一格选格权');

  const next = advance(ctx.state, ctx.secrets, T0 + 10_000);
  check(next.state.phase === 'select', '结算 3 秒后自动进入下一轮选格');
  check(next.state.history.length === 1, '历史记录在下一格仍然保留');
}

console.log('\n== 别名答案（词表里的 甲/乙） ==');

{
  // 词表里写「言不二价/言无二价」= 两种写法都算对，但棋盘与历史只认斜杠前那个
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const entry = ctx.secrets.cellWords[picked.cellId];
  const answer = entry.word;
  const alias = `${answer}二`;
  ctx.secrets.cellWords[picked.cellId] = { ...entry, alt: [alias] };

  check(ctx.secrets.cellWords[picked.cellId].alt?.[0] === alias, '把别名挂到本题面（模拟词表里的斜杠）');

  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: alias }, T0 + 2000);
  check(ctx.state.phase === 'result', '用别名作答同样判对');
  check(ctx.state.history[0].owner === 'RED', '别名答对后正常占格');
  check(ctx.state.history[0].word === answer, '结算记录写的是展示词，不是别名');
  check(ctx.state.board.find((c) => c.id === picked.cellId)?.revealedWord === answer, '棋盘公开的也是展示词');
}

{
  // 换题换上台的词要连别名一起带过来，否则换题后原写法反而判错
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const answer = answerOf(ctx, picked.cellId);
  ctx.secrets.cellWords[picked.cellId] = { ...ctx.secrets.cellWords[picked.cellId], alt: [`${answer}丙`] };
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  // 换题要双方描述位各点一次
  ctx = step(ctx, { t: 'swap', seat: 'RED_DESC' }, T0 + 1200);
  ctx = step(ctx, { t: 'swap', seat: 'GREEN_DESC' }, T0 + 1500);
  const next = ctx.secrets.cellWords[picked.cellId];
  check(next.word !== answer, '换题后题面变了');
  check(next.alt === undefined, '换上台的新词不带旧词的别名（别名跟着词走）');
  check(ctx.secrets.pool.some((w) => w.word === answer), '被换下去的词回到池子里，别名还在它自己身上');
}

console.log('\n== 超时 / 跳过 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const t = tick(ctx.state, ctx.secrets, T0 + 1000 + 90_000);
  check(!!t && !t.error, '描述超时会被推进');
  const after: Ctx = { state: t!.state, secrets: t!.secrets };
  check(after.state.history[0].attempts[0].descPass === 'timeout', '描述超时写进记录');
  check(after.state.phase === 'guess', '描述超时后由该方猜词位作答，而不是跳到对方描述');
  check(after.state.activeDescriber === 'RED', '描述方仍是红方');
  check(after.state.description === null, '没有描述也要作答');
  check(after.state.deadlineAt === T0 + 1000 + 90_000 * 2, '作答仍有独立的 90 秒窗口');

  // 连作答也超时，才交棒给对方描述
  const t2 = tick(after.state, after.secrets, T0 + 1000 + 90_000 * 2);
  check(!!t2 && !t2.error, '作答超时会被推进');
  check(t2!.state.history[0].attempts[0].outcome === 'passed', '作答超时记在猜词结果上');
  check(t2!.state.history[0].attempts[0].guessPass === 'timeout', '作答超时有明确标记');
  check(t2!.state.activeDescriber === 'GREEN', '作答超时才交棒给对方描述');
  check(t2!.state.phase === 'describe', '超时后仍在这一格');
}

{
  // 主动跳过：描述 → 本方作答；作答 → 对方描述；选格 → 对方选格
  let ctx = started();
  check(!!reject(ctx, { t: 'skip', seat: 'RED_GUESS' }, T0 + 900), '选格阶段猜词位不能跳过');
  ctx = step(ctx, { t: 'skip', seat: 'RED_DESC' }, T0 + 1000);
  check(ctx.state.selector === 'GREEN', '跳过选格把选格权交给对方');

  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  check(!!reject(ctx, { t: 'skip', seat: 'GREEN_GUESS' }, T0 + 1500), '轮不到的人不能跳过');
  ctx = step(ctx, { t: 'skip', seat: 'GREEN_DESC' }, T0 + 2000);
  check(ctx.state.phase === 'guess', '描述位可以主动跳过描述');
  check(ctx.state.history[0].attempts[0].descPass === 'skip', '跳过描述写进记录');
  check(ctx.state.activeDescriber === 'GREEN', '跳过描述后仍由本方作答');

  ctx = step(ctx, { t: 'skip', seat: 'GREEN_GUESS' }, T0 + 3000);
  check(ctx.state.history[0].attempts[0].guessPass === 'skip', '跳过作答写进记录');
  check(ctx.state.phase === 'describe' && ctx.state.activeDescriber === 'RED', '跳过作答后交棒给对方描述');
}

console.log('\n== 抢答 ==');

{
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const cell = ctx.state.board.find((c) => c.id === picked.cellId)!;
  const answer = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);

  check(canSteal(ctx.state, 'GREEN', cell), '绿方在未用过的列上有抢答权');
  check(canSteal(ctx.state, 'RED', cell), '红方该行的抢答预算仍在（是否允许抢由阶段决定）');

  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 2000);
  check(ctx.state.phase === 'steal', '抢答进入 20 秒窗口');
  check(ctx.state.steal.by === 'GREEN', '抢答方被记录');
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: answer }, T0 + 3000);
  check(ctx.state.result?.team === 'GREEN', '抢答答对直接拿下本格');
  check(ctx.state.history[0].attempts.some((a) => a.stolen), '抢答标记写进记录');
}

{
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const answer = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 2000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '错错错' }, T0 + 3000);
  check(ctx.state.phase === 'guess', '抢答答错后回到本方作答窗口');
  check(ctx.state.steal.by === null, '抢答权已用掉');
  check(ctx.state.stealUsed.GREEN.includes(ctx.state.board.find((c) => c.id === picked.cellId)!.col), '绿方该列预算已消耗');
}

{
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const answer = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  ctx = step(ctx, { t: 'lock', seat: 'RED_GUESS' }, T0 + 2000);
  check(ctx.state.steal.lockedBy === 'RED', '本方可以在自己的作答窗口防抢答');
  check(ctx.state.windowMs === 20_000, '锁定后答题窗口压到 20 秒');
  check(!!reject(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 3000), '锁定后对方不能抢答');
}

{
  // 防抢答 = 在自己的答题时机抢答本应自己答的题：描述还没写完就不算答题时机
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  check(!!reject(ctx, { t: 'lock', seat: 'RED_GUESS' }, T0 + 1200), '描述阶段还不能防抢答');
  check(ctx.state.steal.lockedBy === null, '被拒时不留下锁定状态');
}

{
  // 不消耗抢答次数：锁完照样能在别的行/列抢答
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const row = ctx.state.board.find((c) => c.id === picked.cellId)!.row;
  const before = JSON.stringify(ctx.state.stealUsed);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 1000);
  ctx = step(ctx, { t: 'lock', seat: 'RED_GUESS' }, T0 + 2000);
  check(JSON.stringify(ctx.state.stealUsed) === before, '防抢答不消耗本方抢答次数');
  check(ctx.state.steal.lockedBy === 'RED', '锁定生效');

  // 就算这一行/列早就抢答过，防抢答也不该被预算拦住
  const strained: Ctx = {
    state: { ...ctx.state, steal: { by: null, lockedBy: null }, stealUsed: { ...ctx.state.stealUsed, RED: [row] } },
    secrets: ctx.secrets,
  };
  check(!canSteal(strained.state, 'RED', strained.state.board.find((c) => c.id === picked.cellId)), '（前提）这一行抢答预算已用完');
  const locked = step(strained, { t: 'lock', seat: 'RED_GUESS' }, T0 + 3000);
  check(locked.state.steal.lockedBy === 'RED', '抢答次数用完也能防抢答（它不算抢答）');
}

console.log('\n== 抢答开关（默认关闭） ==');

{
  let ctx = seated();
  check(ctx.state.stealEnabled === false, '新房默认不启用抢答');
  ctx = step(ctx, { t: 'setSteal', enabled: true });
  check(ctx.state.stealEnabled === true, '开局前可以勾选启用抢答');
  ctx = step(ctx, { t: 'setSteal', enabled: false });
  check(ctx.state.stealEnabled === false, '开局前也可以再关掉');

  const running = started({ steal: true });
  check(!!reject(running, { t: 'setSteal', enabled: false }, T0 + 1000), '开局后规则不能再改');
  check(running.state.stealEnabled === true, '被拒的改规则不影响本局设置');
}

{
  // 未启用抢答：界面没有入口，绕过界面直接提交也必须被拒
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);

  check(!!reject(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 3000), '未启用抢答时抢答被拒');
  check(!!reject(ctx, { t: 'lock', seat: 'RED_GUESS' }, T0 + 3100), '未启用抢答时防抢答也被拒');
  check(ctx.state.steal.by === null && ctx.state.steal.lockedBy === null, '被拒的抢答不占预算、不改局面');
  check(!ctx.state.stealUsed.GREEN.length && !ctx.state.stealUsed.RED.length, '被拒时抢答预算原封不动');

  // 关掉抢答不影响正常作答
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: word }, T0 + 4000);
  check(ctx.state.result?.team === 'RED', '没有抢答也能正常答对结算');
}

console.log('\n== 暂停 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const deadline = ctx.state.deadlineAt!;

  ctx = step(ctx, { t: 'pause', by: '红描' }, T0 + 5000);
  check(!!ctx.state.pausedAt, '任意选手可以暂停');
  const t = tick(ctx.state, ctx.secrets, T0 + 500_000);
  check(t === null, '暂停期间不会推进超时');

  check(!!reject(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 6000), '暂停期间不能描述');
  check(!!reject(ctx, { t: 'select', seat: 'RED_DESC', cellId: 'cell-0-0' }, T0 + 6000), '暂停期间不能选格');

  ctx = step(ctx, { t: 'resume', by: '红描' }, T0 + 25_000);
  check(ctx.state.pausedAt === null, '可以继续对局');
  check(ctx.state.deadlineAt === deadline + 20_000, '暂停时长整体顺延，计时不吃亏');
}

{
  let ctx: Ctx = { state: createRoom('462'), secrets: prepareSecrets(WORDS) };
  check(!!reject(ctx, { t: 'pause' }), '未开局不能暂停');
}

console.log('\n== 换题 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const before = ctx.secrets.cellWords[picked.cellId].word;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(before) }, T0 + 1000);
  ctx = step(ctx, { t: 'swap', seat: 'RED_DESC' }, T0 + 2000);
  check(ctx.state.swapVotes.length === 1, '换题需要双方描述位同意');
  ctx = step(ctx, { t: 'swap', seat: 'GREEN_DESC' }, T0 + 3000);
  const after = ctx.secrets.cellWords[picked.cellId].word;
  check(after !== before, '双方同意后换掉题面');
  check(ctx.secrets.used?.includes(after), '换上台的词也记为「上过场」，重开不会再发它');
  check(ctx.state.history[0].attempts.length === 0, '换题后旧描述作废');
  check(ctx.state.phase === 'describe', '换题后重新描述');
}

console.log('\n== 拒绝 / 撤销申请 ==');

{
  // 换题：对方可以拒绝，发起方也可以自己撤销；两种都让这条申请作废
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const before = ctx.secrets.cellWords[picked.cellId].word;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(before) }, T0 + 1000);

  ctx = step(ctx, { t: 'swap', seat: 'RED_DESC' }, T0 + 2000);
  check(!!reject(ctx, { t: 'reject', kind: 'swap', seat: 'RED_GUESS' }, T0 + 2100), '猜词位不能对换题表态');
  ctx = step(ctx, { t: 'reject', kind: 'swap', seat: 'GREEN_DESC' }, T0 + 3000);
  check(ctx.state.swapVotes.length === 0, '对方拒绝后换题票清零');
  check(ctx.secrets.cellWords[picked.cellId].word === before, '拒绝后题面不变');
  check(!!reject(ctx, { t: 'reject', kind: 'swap', seat: 'GREEN_DESC' }, T0 + 3100), '没有申请时拒绝会给出提示');

  ctx = step(ctx, { t: 'swap', seat: 'GREEN_DESC' }, T0 + 4000);
  ctx = step(ctx, { t: 'reject', kind: 'swap', seat: 'GREEN_DESC' }, T0 + 5000);
  check(ctx.state.swapVotes.length === 0, '发起方可以撤销自己的换题申请');
  check(ctx.secrets.cellWords[picked.cellId].word === before, '撤销后题面同样不变');
  check(ctx.state.swapUsed === false, '拒绝/撤销都不算用掉本格的换题机会');
}

{
  // 判对：拒绝后目标与票都要清掉，否则下一句猜错会被拿去改判
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 1000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '错错错' }, T0 + 2000);
  ctx = step(ctx, { t: 'describe', seat: 'GREEN_DESC', text: clueFor(word) }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '又错了' }, T0 + 4000);
  check(ctx.state.phase === 'describe', '（前提）又轮到红方描述');

  ctx = step(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 5000);
  check(ctx.state.judgeVotes.length === 1 && !!ctx.state.judgeTarget, '（前提）判对申请已发出');
  ctx = step(ctx, { t: 'reject', kind: 'judge', seat: 'GREEN_DESC' }, T0 + 6000);
  check(ctx.state.judgeVotes.length === 0 && ctx.state.judgeTarget === null, '拒绝后判对申请作废');
  check(ctx.state.board.find((c) => c.id === picked.cellId)!.owner === null, '拒绝后格子没有被判给任何一方');
}

{
  // 撤回：对方拒绝后原进度继续，发起方也能自己撤销
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 1000);

  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 2000);
  const deadline = ctx.state.deadlineAt;
  ctx = step(ctx, { t: 'reject', kind: 'undo', seat: 'GREEN_GUESS' }, T0 + 3000);
  check(ctx.state.undoRequest === null, '对方拒绝后撤回申请作废');
  check(ctx.state.description !== null, '拒绝后那条描述仍然有效');
  check(ctx.state.deadlineAt === deadline, '拒绝不重置计时');

  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 4000);
  check(!!ctx.state.undoRequest, '（前提）可以再次申请');
  ctx = step(ctx, { t: 'reject', kind: 'undo', seat: 'RED_DESC' }, T0 + 5000);
  check(ctx.state.undoRequest === null, '发起方可以撤销自己的撤回申请');
  check(!!reject(ctx, { t: 'reject', kind: 'undo', seat: 'RED_GUESS' }, T0 + 5100), '没有申请时撤销会给出提示');
}

console.log('\n== 公开记录（历史格子） ==');

{
  let ctx = started();
  const first = pickFirst(ctx);
  ctx = solveCurrent(first.ctx, T0 + 2000);
  const a = advance(ctx.state, ctx.secrets, T0 + 6000);
  ctx = { state: a.state, secrets: a.secrets };
  const second = pickFirst({ ...ctx });
  ctx = second.ctx;
  check(ctx.state.history.length === 2, '第二个格子追加新行，第一个格子仍保留');
  check(ctx.state.history[0].owner !== null, '已完成格子在记录里保留归属');
  check(ctx.state.history[1].attempts.length === 0, '新格子从空记录开始');

  ctx = solveCurrent(ctx, T0 + 8000);
  const b = advance(ctx.state, ctx.secrets, T0 + 12_000);
  check(b.state.history.length === 2, '下一轮不会丢失已完成的记录');
}

console.log('\n== 对局中接替空位 ==');

{
  let ctx = started();
  ctx = step(ctx, { t: 'leave', seat: 'GREEN_GUESS' }, T0 + 1000);
  check(ctx.state.players.GREEN_GUESS === null, '选手可以中途离席转观战');
  ctx = step(ctx, { t: 'watch', id: 'late', name: '迟到的人' }, T0 + 2000);
  ctx = step(ctx, { t: 'join', seat: 'GREEN_GUESS', name: '迟到的人', specId: 'late' }, T0 + 3000);
  check(ctx.state.players.GREEN_GUESS === '迟到的人', '对局进行中观众也能接替空位');
  check(ctx.state.spectators.every((x) => x.id !== 'late'), '接替后从观战名单移除');
  check(!!reject(ctx, { t: 'join', seat: 'RED_DESC', name: '想抢座的人' }, T0 + 4000), '不能顶掉还在打的人');
}

console.log('\n== 开发者模式 ==');

{
  let ctx: Ctx = { state: createRoom('463'), secrets: prepareSecrets(WORDS) };
  ctx = step(ctx, { t: 'devSetup' });
  check(SEAT_ORDER.every((s) => !!ctx.state.players[s]), '开发者可以一次坐满四个测试选手');
  check(!!reject(ctx, { t: 'devSetup' }), '四席已满时再点会给出提示');
  ctx = step(ctx, { t: 'devReadyAll' });
  check(SEAT_ORDER.every((s) => ctx.state.ready[s]), '开发者可以一次置四席准备');
  check(ctx.state.phase === 'lobby', '缺题库时仍不会开赛');
}

{
  // 开发者代打：四席的操作都通过同一套规则校验
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const answer = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answer) }, T0 + 1000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '不对' }, T0 + 2000);
  ctx = step(ctx, { t: 'describe', seat: 'GREEN_DESC', text: clueFor(answer) }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: answer }, T0 + 4000);
  check(ctx.state.result?.team === 'GREEN', '代打绿方猜词位可以正常拿下格子');
}

console.log('\n== 解散房间 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'close' }, T0 + 1000);
  check(ctx.state.closedAt === T0 + 1000, '解散后写下 closedAt 时间戳');

  const err = reject(ctx, { t: 'describe', seat: 'RED_DESC', text: '甲乙' }, T0 + 2000);
  check(err === '房间已解散', '解散后一切操作被拒', err);
  check(!!reject(ctx, { t: 'rename', name: '改名' }, T0 + 2000), '解散后改名也被拒');
  check(!!reject(ctx, { t: 'watch', id: 'x', name: '新观众' }, T0 + 2000), '解散后新观众进不来');

  // 幂等：重复解散（网络重试）不报错，也不改时间
  ctx = step(ctx, { t: 'close' }, T0 + 3000);
  check(ctx.state.closedAt === T0 + 1000, '重复解散是幂等的，不改解散时间');

  // 解散后懒判定不会把对局继续推走
  const late = advance(ctx.state, ctx.secrets, T0 + 999_000);
  check(late.state.phase === ctx.state.phase && late.state === ctx.state, '解散后超时判定不会推进对局');
}

console.log('\n== 观众裁判 ==');

{
  let ctx = started();
  ctx = step(ctx, { t: 'watch', id: 'spec-1', name: '热心观众' }, T0 + 1000);
  check(ctx.state.spectators.some((s) => s.id === 'spec-1'), '观众已进入观战席');

  // 选手将观众设为裁判
  ctx = step(ctx, { t: 'setReferee', spectatorId: 'spec-1', enabled: true }, T0 + 2000);
  check(ctx.state.refereeIds.includes('spec-1'), '观众成功被设为裁判');
  check(ctx.state.spectators.find((s) => s.id === 'spec-1')?.isReferee === true, '观战列表中包含裁判标记');

  // 取消裁判
  ctx = step(ctx, { t: 'setReferee', spectatorId: 'spec-1', enabled: false }, T0 + 2500);
  check(!ctx.state.refereeIds.includes('spec-1'), '成功取消观众的裁判身份');
  check(ctx.state.spectators.find((s) => s.id === 'spec-1')?.isReferee === false, '观战列表中裁判标记已撤销');

  // 重新设为裁判
  ctx = step(ctx, { t: 'setReferee', spectatorId: 'spec-1', enabled: true }, T0 + 3000);

  // 裁判修改格子词语与代号（中途有效）
  const targetCell = ctx.state.board[0];
  ctx = step(ctx, { t: 'refereeEditCell', cellId: targetCell.id, word: '青蛙', code: 'QW2' }, T0 + 3500);
  const updatedCell = ctx.state.board.find((c) => c.id === targetCell.id)!;
  check(updatedCell.code === 'QW2', '裁判成功修改格子外显代号');
  check(ctx.secrets?.cellWords[targetCell.id].word === '青蛙', '裁判成功修改格子实际词语');
  check(updatedCell.firstLetter === 'Q' && updatedCell.charCount === 2, '修改后首字母与字数自动同步');

  // 裁判改变格子的位置（交换两个格子）
  const cellA = ctx.state.board[0];
  const cellB = ctx.state.board[1];
  const origRowA = cellA.row;
  const origColA = cellA.col;
  const origRowB = cellB.row;
  const origColB = cellB.col;
  ctx = step(ctx, { t: 'refereeSwapCells', cellIdA: cellA.id, cellIdB: cellB.id }, T0 + 4000);
  const swappedA = ctx.state.board.find((c) => c.id === cellA.id)!;
  const swappedB = ctx.state.board.find((c) => c.id === cellB.id)!;
  check(swappedA.row === origRowB && swappedA.col === origColB, '格子A成功移至格子B位置');
  check(swappedB.row === origRowA && swappedB.col === origColA, '格子B成功移至格子A位置');
}

console.log('\n== 抢答与历史顺序 ==');

{
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  // 绿方在红方作答窗口抢答，没猜中 → 作答权还给红方
  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '肯定不是这个' }, T0 + 4000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: word }, T0 + 5000);

  const rec = ctx.state.history[0];
  const evs = eventsOf(rec).map((e) => `${e.team}:${e.kind}`);
  check(
    evs.join(' → ') === 'RED:desc → GREEN:guess → RED:answer',
    `抢答记录不抢到答案前面（实际 ${evs.join(' → ')}）`
  );
  check(rec.attempts[0].descAt === T0 + 2000 && rec.attempts[0].guessAt === T0 + 5000, '描述与作答各自记了时间');
  check(rec.attempts[1].guessAt === T0 + 4000, '抢答记录记了时间');
}

{
  // 抢答直接命中的情形：答案对，且位置在对方描述之后
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: word }, T0 + 4000);
  const evs = eventsOf(ctx.state.history[0]).map((e) => `${e.team}:${e.kind}`);
  check(evs.join(' → ') === 'RED:desc → GREEN:answer', `抢答命中顺序正确（实际 ${evs.join(' → ')}）`);
}

console.log('\n== 判对申请 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  // 红方写了个「其实就是答案」的说法，但引擎按字面判错
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '肯定不是' }, T0 + 3000);
  check(ctx.state.phase === 'describe' && ctx.state.activeDescriber === 'GREEN', '猜错后改由绿方描述');
  check(ctx.state.judgeVotes.length === 0, '开局时没有判对票');

  ctx = step(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 4000);
  check(ctx.state.judgeVotes.join(',') === 'RED', '红方描述位申请判对：先记一票');
  check(ctx.state.judgeTarget?.guess === '肯定不是', '首票锁定要改判的那句猜词');
  check(ctx.state.board.find((c) => c.id === picked.cellId)!.owner === null, '只有一票不结算');
  check(!!reject(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 4200), '同一方不能重复投判对票');
  check(!!reject(ctx, { t: 'judge', seat: 'RED_GUESS' }, T0 + 4300), '猜词位不能申请判对');

  ctx = step(ctx, { t: 'judge', seat: 'GREEN_DESC' }, T0 + 5000);
  const cell = ctx.state.board.find((c) => c.id === picked.cellId)!;
  check(cell.owner === 'RED', '双方描述位同意后改判：格子归猜词的红方');
  check(cell.revealedWord === word, '改判后翻出真实答案');
  check(ctx.state.phase === 'result', '改判后进入结算');
  check(ctx.state.judgeVotes.length === 0 && ctx.state.judgeTarget === null, '改判后清空投票状态');
  const rec = ctx.state.history.find((r) => r.cellId === picked.cellId)!;
  check(rec.attempts.some((a) => a.guess === '肯定不是' && a.outcome === 'correct'), '那条猜词被记成 correct');
  const evs = eventsOf(rec).map((e) => `${e.team}:${e.kind}`);
  check(evs[evs.length - 1] === 'RED:answer', '历史以「答案 ✓」收尾');
}

{
  // 首票投完，对方又猜错一次：晚到的那一票仍然改判首票锁定的那句
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '第一猜' }, T0 + 3000);
  ctx = step(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 4000);
  ctx = step(ctx, { t: 'describe', seat: 'GREEN_DESC', text: clueFor(word) }, T0 + 5000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '第二猜' }, T0 + 6000);
  ctx = step(ctx, { t: 'judge', seat: 'GREEN_DESC' }, T0 + 7000);

  const cell = ctx.state.board.find((c) => c.id === picked.cellId)!;
  const rec = ctx.state.history.find((r) => r.cellId === picked.cellId)!;
  check(cell.owner === 'RED', '晚到的一票也按首票锁定的那句改判');
  check(rec.attempts.find((a) => a.guess === '第一猜')?.outcome === 'correct', '「第一猜」判为正确');
  check(rec.attempts.find((a) => a.guess === '第二猜')?.outcome === 'wrong', '「第二猜」仍然是错的');
}

{
  // 抢答猜错也能改判，改判后归抢答方
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 3000);
  ctx = step(ctx, { t: 'guess', seat: 'GREEN_GUESS', text: '抢答猜的' }, T0 + 4000);
  ctx = step(ctx, { t: 'judge', seat: 'GREEN_DESC' }, T0 + 5000);
  ctx = step(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 6000);
  const cell = ctx.state.board.find((c) => c.id === picked.cellId)!;
  check(cell.owner === 'GREEN', '抢答猜错被改判时归抢答方');
}

{
  // 还没人猜过：没有可改判的对象
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  check(!!reject(ctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 2000), '没有猜词时不能申请判对');
  const solved = solveCurrent(ctx, T0 + 3000);
  check(solved.state.phase === 'result', '正常答对仍然直接结算');
  check(!!reject(solved, { t: 'judge', seat: 'RED_DESC' }, T0 + 4000), '格子已结算后不能再申请判对');
}

console.log('\n== 申请撤回：描述 ==');

{
  // 描述刚提交、还没人作答 → 本队可以申请撤回，对方任意一人都能批
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);

  check(undoableOf(ctx.state)?.kind === 'desc', '描述提交后出现「可撤回描述」');
  check(!!reject(ctx, { t: 'undo', seat: 'GREEN_DESC' }), '不能替对方发起撤回');
  check(!!reject(ctx, { t: 'undoAgree', seat: 'RED_DESC' }), '还没有申请时不能同意');

  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 3000);
  check(ctx.state.undoRequest?.kind === 'desc', '撤回描述申请已登记');
  check(!!reject(ctx, { t: 'undo', seat: 'RED_GUESS' }, T0 + 3100), '同一次撤回不能重复申请');
  check(!!reject(ctx, { t: 'undoAgree', seat: 'RED_GUESS' }, T0 + 3200), '本队不能自己批准撤回');

  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_GUESS' }, T0 + 4000);
  check(ctx.state.phase === 'describe', '对方同意后回到描述阶段');
  check(ctx.state.description === null, '那条描述已作废');
  check(ctx.state.activeDescriber === 'RED', '仍由红方描述位重写');
  check(ctx.state.deadlineAt === T0 + 4000 + 90_000, '撤回后重新给满 90 秒');
  check(ctx.state.undoRequest === null, '撤回后申请自动清空');
  const rec = ctx.state.history.at(-1)!;
  check(rec.attempts.every((a) => !a.description && !a.descAt), '对局历史里不再留这条描述');
}

{
  // 对方描述位同意也算数（「对方任意一人」）
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);
  ctx = step(ctx, { t: 'undo', seat: 'RED_GUESS' }, T0 + 3000);
  check(ctx.state.undoRequest?.team === 'RED', '描述位不做也可以由猜词位发起');
  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_DESC' }, T0 + 4000);
  check(ctx.state.phase === 'describe' && ctx.state.description === null, '对方描述位同意同样生效');
}

{
  // 对方开始抢答后，这条描述就不能再撤回
  let ctx = started({ steal: true });
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);
  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 3000);
  ctx = step(ctx, { t: 'steal', seat: 'GREEN_GUESS' }, T0 + 4000);
  check(ctx.state.undoRequest === null, '对方抢答后撤回申请作废');
  check(!!reject(ctx, { t: 'undoAgree', seat: 'GREEN_GUESS' }, T0 + 5000), '作废后不能再批准');
}

console.log('\n== 申请撤回：作答 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  const word = answerOf(ctx, picked.cellId);
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(word) }, T0 + 2000);
  const desc = ctx.state.description!;
  ctx = step(ctx, { t: 'guess', seat: 'RED_GUESS', text: '猜错了' }, T0 + 3000);
  check(ctx.state.phase === 'describe' && ctx.state.activeDescriber === 'GREEN', '猜错后交棒给绿方描述');
  const target = undoableOf(ctx.state);
  check(target?.team === 'RED' && target.kind === 'guess', '可以撤回红方刚才的作答');

  ctx = step(ctx, { t: 'undo', seat: 'RED_GUESS' }, T0 + 4000);
  check(ctx.state.undoRequest?.kind === 'guess', '撤回作答申请已登记');
  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_DESC' }, T0 + 5000);

  check(ctx.state.phase === 'guess', '同意后回到作答阶段');
  check(ctx.state.activeDescriber === 'RED', '作答权回到红方');
  check(ctx.state.description === desc, '描述还在，可以直接重答');
  check(!ctx.state.tried.includes('RED'), '红方不再算「本格已试过」');
  check(ctx.state.deadlineAt === T0 + 5000 + 90_000, '重新给满 90 秒作答');
  const a = ctx.state.history.at(-1)!.attempts.at(-1)!;
  check(a.outcome === null && a.guess === null && a.guessAt === undefined, '失败的那次作答已从记录里抹掉');
}

{
  // 超时/跳过也算「作答」，同样能撤回
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);
  ctx = step(ctx, { t: 'skip', seat: 'RED_GUESS' }, T0 + 3000);
  check(undoableOf(ctx.state)?.kind === 'guess', '跳过作答后仍可撤回');
  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 4000);
  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_GUESS' }, T0 + 5000);
  check(ctx.state.phase === 'guess' && ctx.state.activeDescriber === 'RED', '撤回跳过后退回红方作答');
}

{
  // 描述被跳过（没有描述文字）也能撤回到描述阶段重写
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'skip', seat: 'RED_DESC' }, T0 + 2000);
  check(ctx.state.phase === 'guess' && ctx.state.description === null, '跳过描述后进入盲猜窗口');
  ctx = step(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 3000);
  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_GUESS' }, T0 + 4000);
  check(ctx.state.phase === 'describe' && ctx.state.activeDescriber === 'RED', '撤回「跳过描述」后退回描述阶段');
}

console.log('\n== 申请撤回：边界 ==');

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  check(!!reject(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 2000), '刚选完格、什么都没做时没有可撤回动作');
}

{
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = solveCurrent(picked.ctx, T0 + 2000);
  check(ctx.state.phase === 'result', '答对后已经结算');
  check(!!reject(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 5000), '已结算的格子不能撤回');
}

{
  // 撤回后原来的换题票/判对票要一起作废
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);
  ctx = step(ctx, { t: 'swap', seat: 'RED_DESC' }, T0 + 3000);
  check(ctx.state.swapVotes.length === 1, '换题票已投出');
  ctx = step(ctx, { t: 'undo', seat: 'RED_GUESS' }, T0 + 4000);
  ctx = step(ctx, { t: 'undoAgree', seat: 'GREEN_DESC' }, T0 + 5000);
  check(ctx.state.swapVotes.length === 0, '撤回后换题票作废');
}

{
  // 暂停期间不能发起也不能批准
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: clueFor(answerOf(ctx, picked.cellId)) }, T0 + 2000);
  ctx = step(ctx, { t: 'pause', by: '玩家' }, T0 + 2500);
  check(!!reject(ctx, { t: 'undo', seat: 'RED_DESC' }, T0 + 2600), '暂停时不能申请撤回');
  check(!!reject(ctx, { t: 'undoAgree', seat: 'GREEN_DESC' }, T0 + 2700), '暂停时不能批准撤回');
}

console.log('\n== 重开：四席全同意 ==');

{
  // 先打下一格再表决：重开要把这一格也一起清掉
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = solveCurrent(ctx, T0 + 2000);
  const usedBefore = new Set(Object.values(ctx.secrets.cellWords).map((w) => w.word));

  ctx = step(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 5000);
  check(ctx.state.restartVotes.length === 1, '一票时先记表决，不立即重开');
  check(ctx.state.board.some((c) => c.owner), '一票时棋盘不变');

  ctx = step(ctx, { t: 'restart', seat: 'GREEN_DESC' }, T0 + 6000);
  ctx = step(ctx, { t: 'restart', seat: 'RED_GUESS' }, T0 + 7000);
  check(ctx.state.restartVotes.length === 3, '三票还不重开');

  ctx = step(ctx, { t: 'restart', seat: 'GREEN_GUESS' }, T0 + 8000);
  check(ctx.state.phase === 'select', '四席同意后立即重开');
  check(ctx.state.restartVotes.length === 0, '重开后表决清零');
  check(ctx.state.board.length === 25 && ctx.state.board.every((c) => !c.owner), '重开后棋盘清空重发 25 格');
  check(ctx.state.history.length === 0, '重开后对局历史清空');
  check(ctx.state.round === 1 && ctx.state.selector === 'RED', '重开从第 1 回合、红方选格开始');
  check(ctx.state.winner === null && ctx.state.result === null, '重开后胜负与结算清空');
  check(ctx.state.deadlineAt === T0 + 8000 + 90_000, '重开后重新给满 90 秒选格');

  const fresh = new Set(Object.values(ctx.secrets.cellWords).map((w) => w.word));
  check(fresh.size === 25, '新棋盘仍是 25 个不同的词');
  check([...fresh].every((w) => !usedBefore.has(w)), '重开发的是题库里还没上过场的词');
  check(ctx.secrets.used?.length === 50, '上过场的词跨局累计（25 + 25）');
}

{
  // 再点一次 = 撤回同意
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 2000);
  check(ctx.state.restartVotes.length === 1, '已记一票');
  ctx = step(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 3000);
  check(ctx.state.restartVotes.length === 0, '再点一次撤回同意');
  check(ctx.state.board.some((c) => c.id === picked.cellId), '撤回同意不影响对局');
}

{
  // 有人离席 → 凑不齐四票
  let ctx = started();
  ctx = step(ctx, { t: 'leave', seat: 'GREEN_GUESS' }, T0 + 1000);
  check(!!reject(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 2000), '四席不满时不能重开');

  // 空席位（没人在）也不能投票
  let ctx2 = started();
  ctx2 = step(ctx2, { t: 'leave', seat: 'GREEN_GUESS' }, T0 + 1000);
  check(!!reject(ctx2, { t: 'restart', seat: 'GREEN_GUESS' }, T0 + 2000), '空席位不能投票');
}

{
  // 换人后旧票作废：新人不该被前一个人的同意绑住
  let ctx = started();
  const picked = pickFirst(ctx);
  ctx = picked.ctx;
  ctx = step(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 2000);
  ctx = step(ctx, { t: 'leave', seat: 'RED_DESC' }, T0 + 3000);
  check(ctx.state.restartVotes.length === 0, '离席会收走该席位的票');
  ctx = step(ctx, { t: 'join', seat: 'RED_DESC', name: '替补' }, T0 + 4000);
  check(ctx.state.restartVotes.length === 0, '换人后旧票不跟着走');
}

{
  // 对局结束后也能重开；重开沿用抢答开关
  let ctx = started({ steal: true });
  const finished: Ctx = {
    state: { ...ctx.state, phase: 'finished', winner: 'RED', resultAt: null, deadlineAt: null },
    secrets: ctx.secrets,
  };
  ctx = step(finished, { t: 'restart', seat: 'RED_GUESS' }, T0 + 1000);
  ctx = step(ctx, { t: 'restart', seat: 'RED_DESC' }, T0 + 2000);
  ctx = step(ctx, { t: 'restart', seat: 'GREEN_DESC' }, T0 + 3000);
  ctx = step(ctx, { t: 'restart', seat: 'GREEN_GUESS' }, T0 + 4000);
  check(ctx.state.phase === 'select', '对局结束后四席同意也能重开');
  check(ctx.state.stealEnabled === true, '重开沿用抢答开关');
  check(ctx.state.players.RED_DESC === '玩家RED_DESC', '重开沿用原班人马');
}

{
  // 题库小到只够一盘：第二局必须整份重新洗牌，否则发不满 25 格
  const small = WORDS.slice(0, 25);
  let ctx = started({ words: small });
  check(ctx.secrets.used?.length === 25, '第一局把 25 个词全用上了');
  for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'restart', seat }, T0 + 1000);
  check(ctx.state.phase === 'select' && ctx.state.board.length === 25, '没词可用时整份重洗，仍发满 25 格');
  check(ctx.state.board.every((c) => !!ctx.secrets.cellWords[c.id]), '重洗后每格都有答案');
}

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
