import {
  AttemptLog,
  BankProposal,
  BoardCell,
  CellRecord,
  DEV_NAMES,
  GameState,
  Intent,
  MAX_ATTEMPTS,
  MAX_GUESS,
  MAX_HISTORY,
  MAX_SPECTATORS,
  MAX_SPEC_GUESS,
  RESULT_HOLD,
  Secrets,
  SEAT_ORDER,
  SeatKey,
  Team,
  UndoRequest,
  WINDOW_DESCRIBE,
  WINDOW_GUESS,
  WINDOW_SELECT,
  WINDOW_STEAL,
  WordEntry,
  other,
  roleOf,
  roleName,
  seatOf,
  teamName,
  teamOf,
} from './types';
import { COLS, ROWS, findWinner } from './hex';
import {
  assignCodes,
  getCharCount,
  getFirstLetter,
  isAnswerMatch,
  uniqueCodeFor,
  validateDescription,
} from './words';

export function createRoom(roomCode: string): GameState {
  return {
    roomCode,
    phase: 'lobby',
    seq: 0,
    round: 0,
    startedAt: null,
    players: { RED_DESC: null, RED_GUESS: null, GREEN_DESC: null, GREEN_GUESS: null },
    ready: { RED_DESC: false, RED_GUESS: false, GREEN_DESC: false, GREEN_GUESS: false },
    spectators: [],
    refereeIds: [],
    canUndo: false,
    canRedo: false,
    bank: null,
    bankProposals: [],
    board: [],
    selector: 'RED',
    firstDescriber: 'RED',
    activeDescriber: null,
    currentCellId: null,
    tried: [],
    description: null,
    history: [],
    steal: { by: null, lockedBy: null },
    stealUsed: { RED: [], GREEN: [] },
    // 抢答默认关闭：开局前由选手/房主勾选，避免默认规则和旧习惯打架
    stealEnabled: false,
    restartVotes: [],
    swapVotes: [],
    swapUsed: false,
    judgeVotes: [],
    judgeTarget: null,
    undoRequest: null,
    pausedAt: null,
    pausedBy: null,
    deadlineAt: null,
    windowMs: WINDOW_SELECT,
    result: null,
    resultAt: null,
    winner: null,
    closedAt: null,
    log: [],
    logSeq: 0,
  };
}

export function prepareSecrets(all: WordEntry[]): Secrets {
  return { all, cellWords: {}, pool: [], used: [], specGuesses: {} };
}

/** 观众猜词的账只对「当前这一格」有意义：换格/换题/重开一律清零 */
function resetSpecGuesses(secrets: Secrets | null) {
  if (secrets) secrets.specGuesses = {};
}

/** 题库就绪 / 提案变更：只动公开元信息，词表始终留在服务端 vault */
export function withBank(state: GameState, info: GameState['bank']): GameState {
  return {
    ...state,
    bank: info,
    bankProposals: [],
    // 换了题库，四席需要重新确认准备
    ready: { RED_DESC: false, RED_GUESS: false, GREEN_DESC: false, GREEN_GUESS: false },
    seq: state.seq + 1,
  };
}

export function withProposal(state: GameState, proposal: BankProposal): GameState {
  const list = (state.bankProposals ?? []).filter((p) => p.id !== proposal.id);
  return { ...state, bankProposals: [...list, proposal].slice(-12), seq: state.seq + 1 };
}

/** 兼容上线前创建的旧房间：补齐后来才加的字段 */
function normalize(s: GameState) {
  if (!Array.isArray(s.history)) s.history = [];
  if (!Array.isArray(s.spectators)) s.spectators = [];
  if (!Array.isArray(s.refereeIds)) s.refereeIds = [];
  if (typeof s.canUndo !== 'boolean') s.canUndo = false;
  if (typeof s.canRedo !== 'boolean') s.canRedo = false;
  if (Array.isArray(s.spectators)) {
    for (const sp of s.spectators) {
      sp.isReferee = s.refereeIds.includes(sp.id);
    }
  }
  if (!Array.isArray(s.bankProposals)) s.bankProposals = [];
  if (!s.ready) s.ready = { RED_DESC: false, RED_GUESS: false, GREEN_DESC: false, GREEN_GUESS: false };
  for (const seat of SEAT_ORDER) if (typeof s.ready[seat] !== 'boolean') s.ready[seat] = false;
  if (s.description === undefined) s.description = null;
  if (s.pausedAt === undefined) s.pausedAt = null;
  if (s.pausedBy === undefined) s.pausedBy = null;
  if (s.closedAt === undefined) s.closedAt = null;
  if (s.undoRequest === undefined) s.undoRequest = null;
  if (typeof s.stealEnabled !== 'boolean') s.stealEnabled = false;
  if (!Array.isArray(s.restartVotes)) s.restartVotes = [];
}

function pushLog(state: GameState, text: string, at: number) {
  state.logSeq += 1;
  state.log = [{ id: state.logSeq, text, at }, ...state.log].slice(0, 40);
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildBoard(words: WordEntry[]): BoardCell[] {
  const codes = assignCodes(words.map((w) => w.word));
  const cells: BoardCell[] = [];
  let i = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const w = words[i];
      cells.push({
        id: `cell-${r}-${c}`,
        row: r,
        col: c,
        code: codes[i].code,
        firstLetter: getFirstLetter(w.word),
        charCount: getCharCount(w.word),
        owner: null,
      });
      i++;
    }
  }
  return cells;
}

/**
 * 发一副新棋盘：**先用题库里还没上过场的词**。
 *
 * 「上过场」= 曾经被摆到棋盘上（含被换题换掉的那个），跨重开累计在 `secrets.used`。
 * 剩下的词不够一盘时（题库小、重开多次），整份重新洗牌——否则会一直发不满 25 格。
 */
function dealBoard(s: GameState, secrets: Secrets): { recycled: boolean } {
  const used = new Set(secrets.used ?? []);
  let avail = secrets.all.filter((w) => !used.has(w.word));
  let recycled = false;
  if (avail.length < ROWS * COLS) {
    used.clear();
    avail = [...secrets.all];
    recycled = true;
  }

  const shuffled = shuffle(avail);
  const onBoard = shuffled.slice(0, ROWS * COLS);
  const rest = shuffled.slice(ROWS * COLS);
  secrets.cellWords = {};
  s.board = buildBoard(onBoard).map((cell, i) => {
    secrets.cellWords[cell.id] = onBoard[i];
    return cell;
  });
  secrets.pool = rest;
  for (const w of onBoard) used.add(w.word);
  secrets.used = Array.from(used);
  return { recycled };
}

/**
 * 开一局（首次开局与重开共用）。
 *
 * 重开不清 `players` / `ready` / `bank` / `stealEnabled`：四席同意本身就是「继续打」的意思，
 * 房间规则与人员沿用，只把棋盘和计分相关的东西换成新的。
 */
function beginGame(s: GameState, secrets: Secrets, now: number, why: 'start' | 'restart') {
  const { recycled } = dealBoard(s, secrets);
  resetSpecGuesses(secrets);

  s.phase = 'select';
  s.round = 1;
  s.startedAt = now;
  s.selector = 'RED';
  s.firstDescriber = 'RED';
  s.activeDescriber = null;
  s.currentCellId = null;
  s.winner = null;
  s.result = null;
  s.resultAt = null;
  s.history = [];
  s.pausedAt = null;
  s.pausedBy = null;
  s.restartVotes = [];
  s.swapUsed = false;
  s.tried = [];
  resetCellRuntime(s);
  s.stealUsed = { RED: [], GREEN: [] };
  s.windowMs = WINDOW_SELECT;
  s.deadlineAt = now + WINDOW_SELECT;

  if (why === 'start') {
    pushLog(s, '对局开始，红方描述位先选格（限时 90 秒）', now);
  } else {
    pushLog(
      s,
      `四席同意重开${recycled ? '（题库已全部用过，重新洗牌）' : ''}，红方先选格（限时 90 秒）`,
      now
    );
  }
}

export function stealBudgetOf(state: GameState, team: Team): { total: number; used: number[] } {
  return team === 'RED'
    ? { total: ROWS, used: state.stealUsed.RED }
    : { total: COLS, used: state.stealUsed.GREEN };
}

export function canSteal(state: GameState, team: Team, cell: BoardCell | undefined | null): boolean {
  if (!cell) return false;
  return team === 'RED'
    ? !state.stealUsed.RED.includes(cell.row)
    : !state.stealUsed.GREEN.includes(cell.col);
}

function consumeSteal(state: GameState, team: Team, cell: BoardCell) {
  if (team === 'RED') state.stealUsed.RED = [...state.stealUsed.RED, cell.row];
  else state.stealUsed.GREEN = [...state.stealUsed.GREEN, cell.col];
}

function currentCell(state: GameState): BoardCell | undefined {
  return state.board.find((c) => c.id === state.currentCellId);
}

/** 当前格子的公开记录（选中该格时建立，答对后仍留在 history 里） */
export function currentRecord(state: GameState): CellRecord | null {
  if (!state.currentCellId) return null;
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].cellId === state.currentCellId) return state.history[i];
  }
  return null;
}

/** 本格最新一次「判错」的猜词；最新那次猜词已经判对（= 格子已结算）时返回 null */
export function latestWrongGuess(state: GameState): { team: Team; guess: string } | null {
  const record = currentRecord(state);
  if (!record) return null;
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    const a = record.attempts[i];
    if (!a.guess) continue; // 没作答（超时/跳过）不算猜词，继续往回找
    return a.outcome === 'wrong' ? { team: a.team, guess: a.guess } : null;
  }
  return null;
}

/** 按首票锁定的目标找回那条猜词记录 */
function findJudgedAttempt(record: CellRecord | null, target: { team: Team; guess: string }): number {
  if (!record) return -1;
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    const a = record.attempts[i];
    if (a.team === target.team && a.guess === target.guess && a.outcome === 'wrong') return i;
  }
  return -1;
}

/** 本格里某队最后一条尝试（不管结没结算） */
function lastAttemptOf(record: CellRecord | null, team: Team): AttemptLog | null {
  if (!record) return null;
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    if (record.attempts[i].team === team) return record.attempts[i];
  }
  return null;
}

/**
 * 此刻可以撤回的「最近一次描述/作答」。
 *
 *   phase=guess   → 本方刚提交（或跳过）描述，还没人作答 → 可撤回「描述」
 *   phase=describe → 上一手是某队作答失败/超时/跳过 → 可撤回该队「作答」
 *   其余（选格中、抢答中、已结算、已暂停、已解散）→ 不给撤回入口
 *
 * 答对已经落格，属于「判对/改判」的地盘，这里一律不支持。
 */
export function undoableOf(state: GameState): { team: Team; kind: 'desc' | 'guess' } | null {
  if (state.closedAt || state.pausedAt) return null;
  const record = currentRecord(state);
  if (!record) return null;

  if (state.phase === 'guess') {
    const team = state.activeDescriber;
    if (!team) return null;
    const a = lastAttemptOf(record, team);
    // 这条尝试已经作答过，就不是「刚写完描述」了
    if (!a || a.outcome !== null) return null;
    return { team, kind: 'desc' };
  }

  if (state.phase === 'describe') {
    if (!state.activeDescriber) return null;
    const failed = other(state.activeDescriber);
    const a = lastAttemptOf(record, failed);
    // 新开格时对方还没有任何尝试 → 没有可撤的作答
    if (!a || a.outcome === null || a.outcome === 'correct') return null;
    return { team: failed, kind: 'guess' };
  }

  return null;
}

/**
 * 执行撤回：把那次描述/作答从记录里抹掉，退回对应窗口并重置计时。
 * 调用前申请已经通过（对方任一选手点了同意）。
 */
function applyUndo(state: GameState, req: UndoRequest, at: number): string | null {
  const record = currentRecord(state);
  const cell = currentCell(state);
  if (!record || !cell) return '当前没有进行中的格子';

  state.undoRequest = null;
  // 撤回改变了局面，之前投出的换题/判对票已经没有意义
  state.swapVotes = [];
  state.judgeVotes = [];
  state.judgeTarget = null;

  const a = lastAttemptOf(record, req.team);
  if (!a) return '找不到要撤回的记录';

  if (req.kind === 'desc') {
    if (a.outcome !== null) return '这次描述已经进入下一步，无法撤回';
    a.description = null;
    // 必须 delete 而不是 = undefined：签名用 canon()，它会把这个键算成 null，
    // 落库时 JSON.stringify 又把 undefined 丢掉 —— 读回来签名就对不上了（409 已被外部改写）
    delete a.descAt;
    delete a.descPass;
    openDescribe(state, req.team, at);
    pushLog(state, `↩ ${teamName(req.team)} 撤回描述，重新描述 ${cell.code} 格（90 秒）`, at);
    return null;
  }

  if (a.outcome === null || a.outcome === 'correct') return '这次作答已经结算，无法撤回';
  // 这条尝试退回「待作答」：猜词、结果、跳过标记全部抹掉，描述保留
  a.outcome = null;
  a.guess = null;
  delete a.guessAt;
  delete a.guessPass;
  delete a.stolen;
  state.tried = state.tried.filter((t) => t !== req.team);
  state.activeDescriber = req.team;
  // 重新作答＝重新开一次窗口，之前那次「防抢答」的锁定不沿用（否则日志写着 90 秒、
  // 实际对方还抢不了，两种状态并存）
  state.steal = { by: null, lockedBy: null };
  state.description = a.description ?? null;
  state.phase = 'guess';
  state.windowMs = WINDOW_GUESS;
  state.deadlineAt = at + WINDOW_GUESS;
  pushLog(
    state,
    `↩ ${teamName(req.team)} 撤回作答，重新作答 ${cell.code} 格（${state.description ? '90 秒' : '没有描述，可盲猜'}）`,
    at
  );
  return null;
}

function resetCellRuntime(state: GameState) {
  state.tried = [];
  state.steal = { by: null, lockedBy: null };
  state.swapVotes = [];
  state.swapUsed = false;
  state.judgeVotes = [];
  state.judgeTarget = null;
  state.undoRequest = null;
  state.description = null;
}

function beginCellRecord(state: GameState, cell: BoardCell) {
  const rest = state.history.filter((r) => r.cellId !== cell.id);
  const record: CellRecord = {
    cellId: cell.id,
    code: cell.code,
    owner: null,
    word: null,
    attempts: [],
  };
  state.history = [...rest, record].slice(-MAX_HISTORY);
}

/**
 * 取（或建立）某方本轮的公开记录。
 *
 * 答错会一直交替下去，所以同一队在一个格子里可能出现很多轮：
 * 只有「还没结算」的那条才是本轮记录，结算过的留在列表里供回看。
 */
function attemptOf(state: GameState, team: Team): AttemptLog {
  const record = currentRecord(state);
  if (!record) throw new Error('没有进行中的格子记录');
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    const a = record.attempts[i];
    if (a.team === team && a.outcome === null) {
      // 描述位/猜词位中途换人时，记录里跟着更新
      a.describer = state.players[seatOf(team, 'DESC')] ?? a.describer;
      a.guesser = state.players[seatOf(team, 'GUESS')] ?? a.guesser;
      return a;
    }
  }
  const entry: AttemptLog = {
    team,
    describer: state.players[seatOf(team, 'DESC')] ?? null,
    description: null,
    guesser: state.players[seatOf(team, 'GUESS')] ?? null,
    guess: null,
    outcome: null,
  };
  const next = [...record.attempts, entry];
  record.attempts = next.length > MAX_ATTEMPTS ? next.slice(-MAX_ATTEMPTS) : next;
  return entry;
}

function settleClaim(state: GameState, team: Team, cell: BoardCell, word: string, at: number) {
  cell.owner = team;
  cell.revealedWord = word;
  const record = currentRecord(state);
  if (record) {
    record.owner = team;
    record.word = word;
    record.code = cell.code;
  }
  state.result = { kind: 'claim', team, cellId: cell.id };
  state.resultAt = at;
  state.selector = team;
  state.deadlineAt = null;
  state.steal = { by: null, lockedBy: null };
  state.undoRequest = null;
  pushLog(state, `✓ ${teamName(team)} 答对「${word}」，占领 ${cell.code} 格`, at);

  const win = findWinner(state.board);
  if (win.winner) {
    state.winner = win.winner;
    state.phase = 'finished';
    state.resultAt = null;
    pushLog(state, `${teamName(win.winner)} 连通成线，对局结束`, at);
  } else {
    state.phase = 'result';
  }
}

/**
 * 这一方本轮没答出来：换对方描述，**不结算、不换格**。
 *
 * 规则是「直到有人猜对为止」，所以两个队会在这个格子上来回交替：
 * 红描 → 红答 → 绿描 → 绿答 → 红描 → ……
 * 只有答对才会离开这个循环，超时也算没答出来，同样交棒给对方。
 */
function applyWrongAnswer(state: GameState, team: Team, cell: BoardCell, at: number) {
  if (!state.tried.includes(team)) state.tried = [...state.tried, team];
  const next = other(team);
  state.activeDescriber = next;
  state.description = null;
  state.steal = { by: null, lockedBy: null };
  state.phase = 'describe';
  state.windowMs = WINDOW_DESCRIBE;
  state.deadlineAt = at + WINDOW_DESCRIBE;
  state.undoRequest = null;
  pushLog(
    state,
    `✗ ${teamName(team)} 未答出，仍由 ${teamName(next)} 描述 ${cell.code} 格，直到有人猜对`,
    at
  );
}

/** 描述一开始：给这一方的描述位开一个独立的 90 秒窗口 */
function openDescribe(state: GameState, team: Team, at: number) {
  state.activeDescriber = team;
  state.description = null;
  state.steal = { by: null, lockedBy: null };
  state.phase = 'describe';
  state.windowMs = WINDOW_DESCRIBE;
  state.deadlineAt = at + WINDOW_DESCRIBE;
  state.undoRequest = null;
}

/** 描述提交后进入作答窗口 */
function openGuess(state: GameState, at: number, guarded: boolean) {
  state.phase = 'guess';
  state.windowMs = guarded ? WINDOW_STEAL : WINDOW_GUESS;
  state.deadlineAt = at + state.windowMs;
  state.undoRequest = null;
}

/** 抢答没打中：把作答权还给本方，描述已提交就直接回到作答窗口 */
function resumeAfterSteal(state: GameState, at: number) {
  state.steal = { by: null, lockedBy: null };
  if (state.description) {
    openGuess(state, at, false);
  } else {
    state.phase = 'describe';
    state.windowMs = WINDOW_DESCRIBE;
    state.deadlineAt = at + WINDOW_DESCRIBE;
  }
}

/** 超时处理：抽成函数，离席导致行动方缺席时也复用同一条路径 */
function handleTimeout(state: GameState, now: number): string | null {
  return passAction(state, now, 'timeout');
}

/** 此刻轮到哪个席位行动（选格也算描述位的行动） */
export function actingSeatOf(state: GameState): SeatKey | null {
  if (state.phase === 'select') return seatOf(state.selector, 'DESC');
  if (state.phase === 'describe' && state.activeDescriber) return seatOf(state.activeDescriber, 'DESC');
  if (state.phase === 'guess' && state.activeDescriber) return seatOf(state.activeDescriber, 'GUESS');
  if (state.phase === 'steal' && state.steal.by) return seatOf(state.steal.by, 'GUESS');
  return null;
}

/**
 * 一个行动没做成：超时或本人主动跳过，走完全相同的规则。
 *
 *   select   → 选格权交给对方
 *   describe → 描述作废，**仍由本方猜词位作答**（不再直接跳到对方描述）
 *   guess    → 交棒给对方描述
 *   steal    → 抢答作废，作答权还给本方
 */
function passAction(state: GameState, now: number, why: 'timeout' | 'skip'): string | null {
  const label = why === 'timeout' ? '超时' : '跳过';
  const cell = currentCell(state);

  if (state.phase === 'select') {
    state.selector = other(state.selector);
    state.windowMs = WINDOW_SELECT;
    state.deadlineAt = now + WINDOW_SELECT;
    pushLog(state, `选格${label}，选格权转给 ${teamName(state.selector)}`, now);
    return null;
  }

  if (!cell) return '当前没有进行中的格子';

  if (state.phase === 'describe') {
    const team = state.activeDescriber!;
    const a = attemptOf(state, team);
    a.descPass = why;
    a.descAt = now;
    pushLog(state, `${teamName(team)} 描述${label}，由本方猜词位作答`, now);
    // 没有描述也要作答：这一格只能凭格子代号与字数猜
    openGuess(state, now, state.steal.lockedBy === team);
    return null;
  }

  if (state.phase === 'guess') {
    const team = state.activeDescriber!;
    const a = attemptOf(state, team);
    a.outcome = 'passed';
    a.guessPass = why;
    a.guessAt = now;
    pushLog(state, `${teamName(team)} 作答${label}，改由 ${teamName(other(team))} 描述 ${cell.code} 格`, now);
    applyWrongAnswer(state, team, cell, now);
    return null;
  }

  if (state.phase === 'steal') {
    const holder = state.steal.by;
    if (!holder) return '当前没有抢答方';
    const a = attemptOf(state, holder);
    a.outcome = 'passed';
    a.guessPass = why;
    a.guessAt = now;
    a.stolen = true;
    pushLog(state, `${teamName(holder)} 抢答${label}，仍由 ${teamName(state.activeDescriber!)} 作答`, now);
    resumeAfterSteal(state, now);
    return null;
  }

  return '现在没有可以跳过的行动';
}

/**
 * 行动方离席后，如果新的行动席位也没人，就继续往下推进，
 * 避免一张桌子空等 90 秒。
 */
function passUntilFilled(state: GameState, at: number) {
  for (let i = 0; i < 6; i++) {
    const seat = actingSeatOf(state);
    if (!seat) return;
    if (state.players[seat]) return;
    if (handleTimeout(state, at)) return;
  }
}

/** 该席位此刻是否正被规则要求行动（离席时要立刻按超时推进，否则会空转 90 秒） */
function isActingNow(state: GameState, seat: SeatKey): boolean {
  if (state.phase === 'select') return seat === seatOf(state.selector, 'DESC');
  if (state.phase === 'describe' && state.activeDescriber) {
    return seat === seatOf(state.activeDescriber, 'DESC');
  }
  if (state.phase === 'guess' && state.activeDescriber) {
    return seat === seatOf(state.activeDescriber, 'GUESS');
  }
  if (state.phase === 'steal' && state.steal.by) {
    return seat === seatOf(state.steal.by, 'GUESS');
  }
  return false;
}

function seatsFilled(state: GameState): boolean {
  return SEAT_ORDER.every((k) => !!state.players[k]);
}

function allReady(state: GameState): boolean {
  return SEAT_ORDER.every((k) => !!state.players[k] && state.ready[k]);
}

/** 四席坐满 + 题库就绪 + 四席都准备 → 允许开局 */
export function canStart(state: GameState, secrets: Secrets | null): boolean {
  return (
    state.phase === 'lobby' &&
    seatsFilled(state) &&
    allReady(state) &&
    !!state.bank &&
    !!secrets &&
    secrets.all.length >= ROWS * COLS
  );
}

export interface ApplyResult {
  state: GameState;
  secrets: Secrets;
  error?: string;
  /**
   * 观众猜词的私下结果。只有发起这次猜词的那台设备需要它（回执「未命中」），
   * 别的操作一律留空，也绝不写进公开快照。
   */
  guessHit?: boolean;
}

export function applyIntent(
  prev: GameState,
  prevSecrets: Secrets | null,
  intent: Intent,
  now: number
): ApplyResult {
  const state = structuredClone(prev);
  const secrets = prevSecrets ? structuredClone(prevSecrets) : null;
  const s = state;
  normalize(s);
  /** 观众猜词的回执，只有 specGuess 会填 */
  let guessHit: boolean | undefined;

  const fail = (error: string): ApplyResult => ({ state: prev, secrets: prevSecrets as Secrets, error });
  /** 暂停时除了改名/导出/继续，一律不能动 */
  const frozen = (): ApplyResult | null => (s.pausedAt ? fail('对局已暂停，先点「继续」') : null);
  /** 已解散的房间是一座冰雕：除了再次解散（幂等），什么操作都不接受，懒判定也不会推进它 */
  if (s.closedAt && intent.t !== 'close') return fail('房间已解散');

  switch (intent.t) {
    case 'join': {
      const name = intent.name.trim().slice(0, 12) || '玩家';
      if (!SEAT_ORDER.includes(intent.seat)) return fail('席位不合法');
      // 对局中也可以接替空位（选手中途退出后观众补位），但不能顶掉还在打的人
      const holder = s.players[intent.seat];
      if (holder && holder !== name && !intent.force) {
        return fail(`${roleName(roleOf(intent.seat))}位已被占用`);
      }
      s.players[intent.seat] = name;
      s.ready[intent.seat] = false;
      // 换了人，原来那一票不能算在新人头上
      s.restartVotes = s.restartVotes.filter((x) => x !== intent.seat);
      // 由观众转为选手：从观战名单里移除
      if (intent.specId) s.spectators = s.spectators.filter((x) => x.id !== intent.specId);
      pushLog(s, `${name} 入座 ${teamName(teamOf(intent.seat))}${roleName(roleOf(intent.seat))}`, now);
      break;
    }

    case 'leave': {
      const name = s.players[intent.seat];
      if (!name) return fail('该席位没有人');
      s.players[intent.seat] = null;
      s.ready[intent.seat] = false;
      s.restartVotes = s.restartVotes.filter((x) => x !== intent.seat);
      pushLog(s, `${name} 离席，转为观战`, now);
      // 走的人恰好是当前行动方：立刻按超时推进，避免整桌干等 90 秒
      if (s.phase !== 'lobby' && isActingNow(s, intent.seat)) {
        passUntilFilled(s, now);
      }
      break;
    }

    case 'watch': {
      if (!intent.id) return fail('观众标识缺失');
      const name = intent.name.trim().slice(0, 12) || '观众';
      const isRef = s.refereeIds?.includes(intent.id) ?? false;
      const idx = s.spectators.findIndex((x) => x.id === intent.id);
      if (idx >= 0) {
        const next = [...s.spectators];
        next[idx] = { id: intent.id, name, isReferee: isRef };
        s.spectators = next;
      } else {
        s.spectators = [...s.spectators, { id: intent.id, name, isReferee: isRef }];
        pushLog(s, `${name} 进入观战席`, now);
      }
      if (s.spectators.length > MAX_SPECTATORS) {
        s.spectators = s.spectators.slice(-MAX_SPECTATORS);
      }
      break;
    }

    case 'rename': {
      const name = intent.name.trim().slice(0, 12);
      if (!name) return fail('昵称不能为空');
      if (intent.seat) {
        if (!s.players[intent.seat]) return fail('该席位没有人');
        s.players[intent.seat] = name;
        // 当前格子的记录里也同步改名，避免公开记录出现旧名字
        const record = currentRecord(s);
        for (const a of record?.attempts ?? []) {
          if (a.team === teamOf(intent.seat)) {
            if (roleOf(intent.seat) === 'DESC') a.describer = name;
            else a.guesser = name;
          }
        }
        break;
      }
      if (intent.specId) {
        const idx = s.spectators.findIndex((x) => x.id === intent.specId);
        if (idx < 0) return fail('你不在观战名单里');
        const next = [...s.spectators];
        next[idx] = { id: intent.specId, name };
        s.spectators = next;
        break;
      }
      return fail('无法确定要改谁的昵称');
    }

    case 'ready': {
      if (s.phase !== 'lobby') return fail('对局已经开始');
      if (!s.players[intent.seat]) return fail('该席位还没有人');
      if (s.pausedAt) return fail('对局已暂停');
      const next = intent.value === undefined ? !s.ready[intent.seat] : !!intent.value;
      s.ready[intent.seat] = next;
      pushLog(
        s,
        `${s.players[intent.seat]} ${next ? '已准备' : '取消准备'}`,
        now
      );
      break;
    }

    case 'devSetup': {
      if (s.phase !== 'lobby') return fail('对局已经开始');
      let added = 0;
      for (const seat of SEAT_ORDER) {
        if (s.players[seat]) continue;
        s.players[seat] = DEV_NAMES[seat];
        s.ready[seat] = false;
        added += 1;
      }
      if (!added) return fail('四个席位都已坐满');
      pushLog(s, `开发者填入 ${added} 个测试席位`, now);
      break;
    }

    case 'devReadyAll': {
      if (s.phase !== 'lobby') return fail('对局已经开始');
      if (!seatsFilled(s)) return fail('四个席位尚未坐满');
      for (const seat of SEAT_ORDER) s.ready[seat] = true;
      pushLog(s, '开发者将四个席位全部置为准备', now);
      break;
    }

    case 'start': {
      if (s.phase !== 'lobby') return fail('对局已经开始');
      if (!seatsFilled(s)) return fail('四个席位尚未坐满');
      if (!s.bank) return fail('还没有导入本局题库');
      if (!allReady(s)) return fail('还有选手没有准备');
      if (!secrets || secrets.all.length < ROWS * COLS) return fail('题库不足 25 词，请先导入');

      beginGame(s, secrets, now, 'start');
      break;
    }

    case 'setSteal': {
      if (s.phase !== 'lobby') return fail('对局已开始，规则不能再改');
      const on = !!intent.enabled;
      if (on === s.stealEnabled) break;
      s.stealEnabled = on;
      pushLog(s, on ? '规则设定：本局启用抢答' : '规则设定：本局不启用抢答', now);
      break;
    }

    /**
     * 重开：**四个席位各按一次同意**才生效（不是双票，也不是房主说了算）。
     * 对局中与结束后都可以发起；重开沿用人员、题库和规则，只换棋盘。
     */
    case 'restart': {
      if (s.phase === 'lobby') return fail('对局还没开始');
      if (!s.players[intent.seat]) return fail('该席位没有人');
      if (!seatsFilled(s)) return fail('四个席位都有人时才能重开');
      if (!secrets || secrets.all.length < ROWS * COLS) return fail('题库不足 25 词，无法重开');

      const name = s.players[intent.seat]!;
      if (s.restartVotes.includes(intent.seat)) {
        s.restartVotes = s.restartVotes.filter((x) => x !== intent.seat);
        pushLog(s, `${name} 撤回重开同意（${s.restartVotes.length}/4）`, now);
        break;
      }

      s.restartVotes = [...s.restartVotes, intent.seat];
      if (s.restartVotes.length < SEAT_ORDER.length) {
        pushLog(s, `${name} 同意重开（${s.restartVotes.length}/4）`, now);
        break;
      }
      beginGame(s, secrets, now, 'restart');
      break;
    }

    case 'select': {
      const f = frozen();
      if (f) return f;
      if (s.phase !== 'select') return fail('现在不是选格阶段');
      if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以选格');
      if (teamOf(intent.seat) !== s.selector) return fail('本轮选格权不在你们队');
      const cell = s.board.find((c) => c.id === intent.cellId);
      if (!cell) return fail('格子不存在');
      if (cell.owner) return fail('该格已被占领');

      s.currentCellId = cell.id;
      s.firstDescriber = s.selector;
      resetCellRuntime(s);
      resetSpecGuesses(secrets);
      beginCellRecord(s, cell);
      openDescribe(s, s.selector, now);
      pushLog(s, `${teamName(s.selector)} 选定 ${cell.code} 格，双方描述位已收到答案`, now);
      break;
    }

    case 'describe': {
      const f = frozen();
      if (f) return f;
      if (s.phase !== 'describe') return fail('现在不是描述阶段');
      if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以写描述');
      const team = teamOf(intent.seat);
      if (team !== s.activeDescriber) return fail('本轮不由你们描述');
      const cell = currentCell(s);
      if (!cell) return fail('当前没有进行中的格子');
      const entry = secrets?.cellWords[cell.id];
      if (!entry) return fail('缺少该格答案');

      // 规则校验：正好两个汉字、且不能出现答案里的字。绕过界面直接提交同样过不去。
      const text = (intent.text ?? '').trim();
      const verdict = validateDescription(text, entry.word);
      if (!verdict.ok) return fail(verdict.error ?? '描述不合规则');

      s.description = text;
      const a = attemptOf(s, team);
      a.describer = s.players[intent.seat] ?? a.describer;
      a.description = text;
      a.descAt = now;

      const guarded = s.steal.lockedBy === team;
      openGuess(s, now, guarded);
      pushLog(
        s,
        `${teamName(team)} 描述完毕，进入作答${guarded ? '（已锁定，20 秒）' : '（90 秒）'}`,
        now
      );
      break;
    }

    case 'guess': {
      const f = frozen();
      if (f) return f;
      if (roleOf(intent.seat) !== 'GUESS') return fail('只有猜词位可以作答');
      const cell = currentCell(s);
      if (!cell || !s.currentCellId) return fail('当前没有进行中的格子');
      const entry = secrets?.cellWords[cell.id];
      if (!entry) return fail('缺少该格答案');
      const text = (intent.text ?? '').trim().slice(0, MAX_GUESS);
      if (!text) return fail('答案不能为空');
      const team = teamOf(intent.seat);

      if (s.phase === 'guess') {
        if (team !== s.activeDescriber) return fail('现在不是你们的作答窗口');
        const a = attemptOf(s, team);
        a.guess = text;
        a.guessAt = now;
        if (isAnswerMatch(text, entry.word, entry.alt)) {
          a.outcome = 'correct';
          settleClaim(s, team, cell, entry.word, now);
        } else {
          a.outcome = 'wrong';
          pushLog(s, `${teamName(team)} 猜「${text.slice(0, 12)}」未命中`, now);
          applyWrongAnswer(s, team, cell, now);
        }
        break;
      }

      if (s.phase === 'steal') {
        const holder = s.steal.by;
        if (!holder || team !== holder) return fail('抢答权不在你们这边');
        const a = attemptOf(s, team);
        a.guess = text;
        a.guessAt = now;
        if (isAnswerMatch(text, entry.word, entry.alt)) {
          a.outcome = 'correct';
          a.stolen = true;
          settleClaim(s, holder, cell, entry.word, now);
        } else {
          a.outcome = 'wrong';
          a.stolen = true;
          pushLog(s, `${teamName(holder)} 抢答未命中，仍由 ${teamName(s.activeDescriber!)} 作答`, now);
          resumeAfterSteal(s, now);
        }
        break;
      }

      return fail('现在不能作答');
    }

    case 'skip': {
      const f = frozen();
      if (f) return f;
      const acting = actingSeatOf(s);
      if (!acting) return fail('现在没有可以跳过的行动');
      if (intent.seat !== acting) return fail('现在轮不到这个席位行动');
      const err = passAction(s, now, 'skip');
      if (err) return fail(err);
      break;
    }

    case 'steal': {
      const f = frozen();
      if (f) return f;
      if (!s.stealEnabled) return fail('本局未启用抢答');
      if (s.phase !== 'describe' && s.phase !== 'guess') return fail('现在不在对方描述/作答窗口，不能抢答');
      if (roleOf(intent.seat) !== 'GUESS') return fail('只有猜词位可以抢答');
      if (s.steal.by || s.steal.lockedBy) return fail('本格抢答权已被占用');
      const cell = currentCell(s);
      if (!cell) return fail('当前没有进行中的格子');
      const team = teamOf(intent.seat);
      if (team === s.activeDescriber) return fail('不能抢答自己队的题目');
      if (!canSteal(s, team, cell)) return fail('本行/本列的抢答机会已用完');

      consumeSteal(s, team, cell);
      s.steal.by = team;
      s.phase = 'steal';
      s.windowMs = WINDOW_STEAL;
      s.deadlineAt = now + WINDOW_STEAL;
      // 对方已经开始照着描述抢答，这条描述就撤不回了
      s.undoRequest = null;
      pushLog(s, `${teamName(team)} 使用抢答权，答题限时 20 秒`, now);
      break;
    }

    case 'lock': {
      const f = frozen();
      if (f) return f;
      if (!s.stealEnabled) return fail('本局未启用抢答，无需防抢答');
      // 「防抢答」等价于在自己的答题时机抢答本应由自己答的题：描述还没写完时不算答题时机，
      // 所以只认 guess 阶段（本方作答窗口已经开出来）。
      if (s.phase !== 'guess') return fail('只有在自己作答时才能防抢答');
      if (roleOf(intent.seat) !== 'GUESS') return fail('只有猜词位可以防抢答');
      if (s.steal.by || s.steal.lockedBy) return fail('本格抢答权已被占用');
      const cell = currentCell(s);
      if (!cell) return fail('当前没有进行中的格子');
      const team = teamOf(intent.seat);
      if (team !== s.activeDescriber) return fail('只有本题作答方可以防抢答');

      // 抢的是「本应自己答的题」，所以不占抢答次数、也不受本行/本列预算限制
      s.steal.lockedBy = team;
      s.windowMs = WINDOW_STEAL;
      s.deadlineAt = now + WINDOW_STEAL;
      pushLog(
        s,
        `${teamName(team)} 抢先锁定作答权，对方无法抢答（不消耗抢答次数），作答限时 20 秒`,
        now
      );
      break;
    }

    case 'swap': {
      const f = frozen();
      if (f) return f;
      if (s.phase !== 'describe' && s.phase !== 'guess' && s.phase !== 'steal') {
        return fail('当前没有可换的题目');
      }
      if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以发起换题');
      if (s.swapUsed) return fail('本格已经换过一次题了');
      const cell = currentCell(s);
      if (!cell) return fail('当前没有进行中的格子');
      if (!secrets) return fail('缺少题库');

      const team = teamOf(intent.seat);
      if (s.swapVotes.includes(team)) return fail('你已经投过换题票');
      s.swapVotes = [...s.swapVotes, team];
      if (s.swapVotes.length < 2) {
        pushLog(s, `${teamName(team)} 请求换题（1/2），需双方描述位同意`, now);
        break;
      }
      if (secrets.pool.length === 0) {
        s.swapVotes = [];
        return fail('备用题库已用尽');
      }

      const idx = Math.floor(Math.random() * secrets.pool.length);
      const next = secrets.pool[idx];
      secrets.pool = secrets.pool.filter((_, i) => i !== idx);
      secrets.pool.push(secrets.cellWords[cell.id]);
      secrets.cellWords[cell.id] = next;
      // 换上台的词也算「上过场」：重开时不能再发它
      secrets.used = Array.from(new Set([...(secrets.used ?? []), next.word]));

      const taken = s.board.filter((c) => c.id !== cell.id).map((c) => c.code);
      cell.code = uniqueCodeFor(next.word, taken);
      cell.firstLetter = getFirstLetter(next.word);
      cell.charCount = getCharCount(next.word);
      s.swapUsed = true;
      s.swapVotes = [];
      s.judgeVotes = [];
      s.judgeTarget = null;
      // 换了题，之前的描述作废，重新从描述开始
      const record = currentRecord(s);
      if (record) {
        record.attempts = [];
        record.code = cell.code;
        record.owner = null;
        record.word = null;
      }
      s.description = null;
      s.steal = { by: null, lockedBy: null };
      // 换了一个词，之前猜中过的人也就不知道新答案了：账本清零，重新开始
      resetSpecGuesses(secrets);
      openDescribe(s, s.activeDescriber ?? s.firstDescriber, now);
      pushLog(s, `双方同意换题，${cell.code} 已更换为备用题，重新描述`, now);
      break;
    }

    case 'judge': {
      const f = frozen();
      if (f) return f;
      if (s.phase !== 'describe' && s.phase !== 'guess' && s.phase !== 'steal') {
        return fail('当前没有可改判的猜词');
      }
      if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以申请判对');
      const cell = currentCell(s);
      if (!cell) return fail('当前没有进行中的格子');
      const entry = secrets?.cellWords[cell.id];
      if (!entry) return fail('缺少该格答案');

      const team = teamOf(intent.seat);
      if (s.judgeVotes.includes(team)) return fail('你已经投过票了');

      // 首票就锁定目标：之后再有人猜错也不会改变这次申请谈的是哪一句
      const target = s.judgeTarget ?? latestWrongGuess(s);
      if (!target) return fail('这一格没有判错的猜词，不能改判');

      s.judgeVotes = [...s.judgeVotes, team];
      s.judgeTarget = target;
      if (s.judgeVotes.length < 2) {
        pushLog(
          s,
          `${teamName(team)} 申请把「${target.guess}」判为正确（1/2），需双方描述位同意`,
          now
        );
        break;
      }

      const record = currentRecord(s);
      const idx = findJudgedAttempt(record, target);
      if (idx < 0) {
        s.judgeVotes = [];
        s.judgeTarget = null;
        return fail('这次申请已失效，请重新发起');
      }
      const judged = record!.attempts[idx];
      judged.outcome = 'correct';
      pushLog(s, `双方描述位同意，「${target.guess}」改判为正确`, now);
      settleClaim(s, judged.team, cell, entry.word, now);
      s.judgeVotes = [];
      s.judgeTarget = null;
      break;
    }

    case 'undo': {
      const f = frozen();
      if (f) return f;
      if (s.undoRequest) return fail('已经有一条撤回申请在等对方同意');
      const target = undoableOf(s);
      if (!target) return fail('现在没有可以撤回的描述或作答');
      if (teamOf(intent.seat) !== target.team) return fail('只能撤回本队刚做的动作');
      s.undoRequest = { team: target.team, kind: target.kind, at: now };
      pushLog(
        s,
        `${teamName(target.team)} 申请撤回${target.kind === 'desc' ? '描述' : '作答'}，需对方任意一人同意`,
        now
      );
      break;
    }

    case 'undoAgree': {
      const f = frozen();
      if (f) return f;
      const req = s.undoRequest;
      if (!req) return fail('没有待同意的撤回申请');
      if (teamOf(intent.seat) === req.team) return fail('撤回需要对方同意，本方不能自己批');
      // 申请发出后局面又推进过：这次撤回已经没意义
      const still = undoableOf(s);
      if (!still || still.team !== req.team || still.kind !== req.kind) {
        s.undoRequest = null;
        return fail('这次撤回已经失效，请重新发起');
      }
      const err = applyUndo(s, req, now);
      if (err) return fail(err);
      break;
    }

    case 'reject': {
      const f = frozen();
      if (f) return f;
      const team = teamOf(intent.seat);

      if (intent.kind === 'swap') {
        if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以先换题/拒绝换题');
        if (s.swapVotes.length === 0) return fail('现在没有换题申请');
        const mine = s.swapVotes.includes(team);
        s.swapVotes = [];
        pushLog(
          s,
          mine ? `${teamName(team)} 撤销换题申请` : `${teamName(team)} 拒绝换题，申请作废`,
          now
        );
        break;
      }

      if (intent.kind === 'judge') {
        if (roleOf(intent.seat) !== 'DESC') return fail('只有描述位可以对判对表态');
        if (s.judgeVotes.length === 0) return fail('现在没有判对申请');
        const mine = s.judgeVotes.includes(team);
        const guess = s.judgeTarget?.guess ?? '';
        s.judgeVotes = [];
        s.judgeTarget = null;
        pushLog(
          s,
          mine
            ? `${teamName(team)} 撤销判对申请`
            : `${teamName(team)} 拒绝把「${guess}」判为正确`,
          now
        );
        break;
      }

      // undo：发起方撤销、对方拒绝，都会让这条申请作废
      const req = s.undoRequest;
      if (!req) return fail('现在没有待处理的撤回申请');
      const mine = req.team === team;
      const what = req.kind === 'desc' ? '描述' : '作答';
      s.undoRequest = null;
      pushLog(
        s,
        mine ? `${teamName(team)} 撤销撤回申请` : `${teamName(team)} 拒绝撤回${what}，继续当前进度`,
        now
      );
      break;
    }

    case 'pause': {
      if (s.phase === 'lobby' || s.phase === 'finished') return fail('对局未在进行中');
      if (s.pausedAt) return fail('已经在暂停中');
      s.pausedAt = now;
      s.pausedBy = (intent.by ?? '').trim().slice(0, 12) || '选手';
      pushLog(s, `${s.pausedBy} 暂停了对局`, now);
      break;
    }

    case 'resume': {
      if (s.phase === 'lobby' || s.phase === 'finished') return fail('对局未在进行中');
      if (!s.pausedAt) return fail('当前没有暂停');
      const delta = Math.max(0, now - s.pausedAt);
      if (s.deadlineAt) s.deadlineAt += delta;
      if (s.resultAt) s.resultAt += delta;
      s.pausedAt = null;
      s.pausedBy = null;
      pushLog(s, `▶ ${(intent.by ?? '').trim() || '选手'} 继续对局（计时顺延 ${Math.round(delta / 1000)} 秒）`, now);
      break;
    }

    /**
     * 观众猜词：任何一方都还没把格子拿下时，围观的人也可以猜本格的词。
     *
     * 三条规矩：
     *   ① **不影响对局**——不换格、不计分、不推进计时，猜中也不叫「答对」；
     *   ② **只公开「猜中了」**——战况写「观众 xx 猜中了 A2 格」，猜的是什么词一个字都不写，
     *      战况是公开的，写进去就等于把答案告诉全房间；
     *   ③ **猜错不公开**——只回给这一台设备一句「未命中」。写进战况等于把答案逐字排除。
     *
     * 次数按「一个观众 × 当前这一格」封顶（`MAX_SPEC_GUESS`）：换格/换题/重开都清零。
     * 没有人能靠这个功能刷屏，也挡掉了拿词表暴力试词。
     */
    case 'specGuess': {
      if (!intent.id) return fail('观战身份缺失');
      if (s.phase !== 'describe' && s.phase !== 'guess' && s.phase !== 'steal') {
        return fail('现在没有正在猜的格子');
      }
      const cell = currentCell(s);
      if (!cell) return fail('现在没有正在猜的格子');
      if (!secrets) return fail('缺少题库');
      const entry = secrets.cellWords[cell.id];
      if (!entry) return fail('缺少该格答案');

      const text = (intent.text ?? '').trim().slice(0, MAX_GUESS);
      if (!text) return fail('猜词不能为空');

      const book = (secrets.specGuesses ??= {});
      const prev = book[intent.id] ?? { tries: 0, hit: false };
      if (!prev.hit && prev.tries >= MAX_SPEC_GUESS) {
        return fail('这一格猜的次数够了，等下一格再试');
      }

      const hit = isAnswerMatch(text, entry.word, entry.alt);
      book[intent.id] = { tries: prev.tries + 1, hit: prev.hit || hit };
      guessHit = hit;

      if (hit && !prev.hit) {
        // 昵称以观战名单为准（改名会同步到名单），名单里没有就退回服务端给的昵称
        const name = s.spectators.find((x) => x.id === intent.id)?.name ?? (intent.name?.trim() || '观众');
        pushLog(s, `观众 ${name} 猜中了 ${cell.code} 格`, now);
      }
      break;
    }

    case 'approveBank': {
      if (s.phase !== 'lobby') return fail('对局已经开始，不能更换题库');
      const proposal = s.bankProposals.find((p) => p.id === intent.id);
      if (!proposal) return fail('这份题库提案已失效');
      s.bank = {
        name: proposal.name,
        count: proposal.count,
        fingerprint: proposal.fingerprint,
      };
      s.bankProposals = [];
      s.ready = { RED_DESC: false, RED_GUESS: false, GREEN_DESC: false, GREEN_GUESS: false };
      pushLog(s, `房主同意了「${proposal.name}」，题库已就绪`, now);
      break;
    }

    case 'rejectBank': {
      if (s.phase !== 'lobby') return fail('对局已经开始');
      const proposal = s.bankProposals.find((p) => p.id === intent.id);
      if (!proposal) return fail('这份题库提案已失效');
      s.bankProposals = s.bankProposals.filter((p) => p.id !== intent.id);
      pushLog(s, `已拒绝「${proposal.name}」`, now);
      break;
    }

    case 'setReferee': {
      if (!intent.spectatorId) return fail('未指定观众');
      const spec = s.spectators.find((x) => x.id === intent.spectatorId);
      const name = spec?.name ?? '观众';
      const set = new Set(s.refereeIds ?? []);
      if (intent.enabled) {
        set.add(intent.spectatorId);
        pushLog(s, `${name} 被设为裁判`, now);
      } else {
        set.delete(intent.spectatorId);
        pushLog(s, `${name} 不再担任裁判`, now);
      }
      s.refereeIds = Array.from(set);
      s.spectators = s.spectators.map((x) => ({
        ...x,
        isReferee: set.has(x.id),
      }));
      break;
    }

    case 'refereeEditCell': {
      const cell = s.board.find((c) => c.id === intent.cellId);
      if (!cell) return fail('目标格子不存在');
      const word = (intent.word ?? '').trim();
      if (!word) return fail('词语不能为空');

      // 更新答案词。裁判改的是「这一格要考什么」，旧词的别名必须一起丢掉，
      // 否则改完之后旧答案还能被判对。
      if (secrets) {
        secrets.cellWords[cell.id] = { word };
      }
      // 更新代号、首字母、字数
      const customCode = (intent.code ?? '').trim().toUpperCase();
      cell.code = customCode || `${getFirstLetter(word)}${getCharCount(word)}`;
      cell.firstLetter = getFirstLetter(word);
      cell.charCount = getCharCount(word);

      // 如果当前已经被公开，同步更新
      if (cell.revealedWord) {
        cell.revealedWord = word;
      }
      const inCurrent = s.currentCellId === cell.id;
      pushLog(s, `[裁判] 修改了 ${cell.code} 格内容为「${word}」${inCurrent ? '（正在对决中）' : ''}`, now);
      break;
    }

    case 'refereeSwapCells': {
      const cellA = s.board.find((c) => c.id === intent.cellIdA);
      const cellB = s.board.find((c) => c.id === intent.cellIdB);
      if (!cellA || !cellB) return fail('指定的格子不存在');
      if (cellA.id === cellB.id) return fail('不能与自身交换位置');

      const tmpRow = cellA.row;
      const tmpCol = cellA.col;
      cellA.row = cellB.row;
      cellA.col = cellB.col;
      cellB.row = tmpRow;
      cellB.col = tmpCol;

      pushLog(s, `[裁判] 交换了 ${cellA.code} 格与 ${cellB.code} 格的位置`, now);
      break;
    }

    case 'close': {
      // 解散：幂等。重复解散（网络重试）不报错，也不改时间
      if (!s.closedAt) {
        s.closedAt = now;
        pushLog(s, '房主解散了房间', now);
      }
      break;
    }

    case 'timeout': {
      if (s.pausedAt) return fail('对局已暂停');
      const err = handleTimeout(s, now);
      if (err) return fail(err);
      break;
    }

    case 'next': {
      if (s.phase !== 'result') return fail('当前不在结算阶段');
      s.result = null;
      s.resultAt = null;
      s.currentCellId = null;
      s.activeDescriber = null;
      s.tried = [];
      s.steal = { by: null, lockedBy: null };
      s.swapVotes = [];
      s.swapUsed = false;
      s.judgeVotes = [];
      s.judgeTarget = null;
      s.phase = 'select';
      s.round += 1;
      s.windowMs = WINDOW_SELECT;
      s.deadlineAt = now + WINDOW_SELECT;
      pushLog(s, `${teamName(s.selector)} 获得选格权`, now);
      break;
    }

    default:
      return fail('未知操作');
  }

  s.seq = prev.seq + 1;
  return { state: s, secrets: secrets as Secrets, guessHit };
}

/** 到期的计时窗口与自动开局（没有常驻定时器，靠下一次访问做懒判定） */
export function tick(state: GameState, secrets: Secrets | null, now: number): ApplyResult | null {
  if (state.pausedAt) return null;
  if (
    (state.phase === 'select' ||
      state.phase === 'describe' ||
      state.phase === 'guess' ||
      state.phase === 'steal') &&
    state.deadlineAt &&
    now >= state.deadlineAt
  ) {
    return applyIntent(state, secrets, { t: 'timeout' }, now);
  }
  if (state.phase === 'result' && state.resultAt && now >= state.resultAt + RESULT_HOLD) {
    return applyIntent(state, secrets, { t: 'next' }, now);
  }
  return null;
}

/**
 * 推进：到点结算 →（满足条件则）自动开局。
 *
 * 四席全部准备 + 题库就绪后自动开局，不需要房主再点一次「开始」。
 */
export function advance(state: GameState, secrets: Secrets | null, now: number) {
  let cur = state;
  let sec = secrets;
  for (let i = 0; i < 8; i++) {
    if (canStart(cur, sec)) {
      const r = applyIntent(cur, sec, { t: 'start' }, now);
      if (!r.error) {
        cur = r.state;
        sec = r.secrets;
        continue;
      }
    }
    const t = tick(cur, sec, now);
    if (t && !t.error) {
      cur = t.state;
      sec = t.secrets;
      continue;
    }
    break;
  }
  return { state: cur, secrets: sec };
}

export { seatsFilled, allReady };
export function seatKeys(): SeatKey[] {
  return SEAT_ORDER;
}
