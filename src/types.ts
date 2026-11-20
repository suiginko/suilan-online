export type Team = 'RED' | 'GREEN';
export type Role = 'DESC' | 'GUESS';
export type SeatKey = 'RED_DESC' | 'RED_GUESS' | 'GREEN_DESC' | 'GREEN_GUESS';

export const SEAT_ORDER: SeatKey[] = ['RED_DESC', 'RED_GUESS', 'GREEN_DESC', 'GREEN_GUESS'];

export const teamOf = (seat: SeatKey): Team => (seat.startsWith('RED') ? 'RED' : 'GREEN');
export const roleOf = (seat: SeatKey): Role => (seat.endsWith('DESC') ? 'DESC' : 'GUESS');
export const seatOf = (team: Team, role: Role): SeatKey => `${team}_${role}` as SeatKey;
export const other = (team: Team): Team => (team === 'RED' ? 'GREEN' : 'RED');
export const teamName = (team: Team): string => (team === 'RED' ? '红方' : '绿方');
export const roleName = (role: Role): string => (role === 'DESC' ? '描述' : '猜词');

export interface WordEntry {
  /** 展示用词：棋盘代号、结算文案、对局历史一律只用它 */
  word: string;
  /**
   * 同义的其它写法（词表里用 `/` 分隔）：判对时任何一个都算答对，
   * 但界面只显示 `word`，别名不出服务端。
   */
  alt?: string[];
  hint?: string;
  category?: string;
}

export interface BoardCell {
  id: string;
  row: number;
  col: number;
  code: string;
  firstLetter: string;
  charCount: number;
  owner: Team | null;
  /** 被答对后才公开的答案，未占领时为空 */
  revealedWord?: string;
}

/**
 * lobby →（四席准备完毕、题库就绪）→ select →（describe → guess →）… → result → select …
 *
 * describe 与 guess 是两段独立计时的行动：描述位先写下两个字（公开），
 * 猜词位再作答。抢答只发生在 guess 窗口，因此抢答者一定看得到描述。
 *
 * 答错不结算：改由对方描述、对方作答，如此交替，直到有人猜对为止。
 * 因此 describe/guess 这对状态会在同一个格子里来回出现多次。
 */
export type Phase = 'lobby' | 'select' | 'describe' | 'guess' | 'steal' | 'result' | 'finished';

/** 本格里某一方的描述与作答记录，全部公开 */
export interface AttemptLog {
  team: Team;
  describer: string | null;
  description: string | null;
  guesser: string | null;
  guess: string | null;
  /** 猜词结果；passed 表示没作答（超时/主动跳过），具体见 guessPass */
  outcome: 'correct' | 'wrong' | 'passed' | null;
  /**
   * 描述位没写出描述就过去了：
   * timeout = 超时，skip = 自己点了跳过。此时仍由本方猜词位作答。
   */
  descPass?: 'timeout' | 'skip';
  /** 猜词位没作答就过去了 */
  guessPass?: 'timeout' | 'skip';
  /** 这一格是被抢答拿下的 */
  stolen?: boolean;
  /**
   * 本条记录里「描述」和「作答」各自发生的时刻。
   *
   * 一条记录会被双方交替地打断：红描述 → 绿抢答 → 红猜中。三个事件分属两条记录，
   * 只按「记录建立的先后」排会把红方的猜中排到绿方抢答前面。
   * 渲染时按这两个时间合并排序，才和真实发生顺序一致。老房间没有这两个字段。
   */
  descAt?: number;
  guessAt?: number;
}

/**
 * 一个格子的完整公开记录。
 *
 * 记录在「选中这一格」时就建立，答对后继续留在历史里 ——
 * 公开记录不再只显示当前格子，而是整局的流水（需求 6）。
 */
export interface CellRecord {
  cellId: string;
  code: string;
  owner: Team | null;
  /** 答对后才有的答案 */
  word: string | null;
  attempts: AttemptLog[];
}

/** 观战者。id 由服务端根据观众令牌派生，用于稳定去重。 */
export interface Spectator {
  id: string;
  name: string;
  isReferee?: boolean;
}

/** 任何人上传的待审批题库（词表本身只存在服务端的 vault 里） */
export interface BankProposal {
  id: string;
  name: string;
  count: number;
  fingerprint: string;
  /** 上传者昵称 */
  by: string;
  at: number;
}

export interface LogItem {
  id: number;
  text: string;
  at: number;
}

/**
 * 一条待同意的撤回申请。发起方是「做错动作的那一队」，同意方是对方队的任一选手。
 * kind: desc = 描述（含点了「跳过描述」），guess = 作答（含超时/跳过）。
 */
export interface UndoRequest {
  team: Team;
  kind: 'desc' | 'guess';
  at: number;
}

export interface GameResult {
  kind: 'claim';
  team: Team;
  cellId: string;
}

export interface GameState {
  roomCode: string;
  phase: Phase;
  seq: number;
  round: number;
  /**
   * 本局开始时间（重开会刷新）。老房间没有这个字段，按 null 兜底。
   * 大厅判废按「最后一局打了多久」分档，用它和 `updatedAt` 一起判断。
   */
  startedAt?: number | null;
  /** 四个席位上的玩家名，null 表示空位 */
  players: Record<SeatKey, string | null>;
  /** 四席的准备状态：全部准备后自动开局 */
  ready: Record<SeatKey, boolean>;
  /** 观战者名单，人数不设上限（快照里只保留最近的若干位） */
  spectators: Spectator[];
  /** 被设为裁判的观众 id 列表 */
  refereeIds: string[];
  /** 是否存在可撤销的历史步骤 */
  canUndo?: boolean;
  /** 是否存在可恢复的历史步骤 */
  canRedo?: boolean;
  bank: { name: string; count: number; fingerprint: string } | null;
  /** 待房主审批的题库提案 */
  bankProposals: BankProposal[];
  board: BoardCell[];
  /** 当前握有选格权的队伍 */
  selector: Team;
  /** 本格首描述方 */
  firstDescriber: Team;
  /** 本格当前描述方（答错会易手） */
  activeDescriber: Team | null;
  currentCellId: string | null;
  /** 本格已尝试过的队伍 */
  tried: Team[];
  /** 本格当前这一轮已提交的描述（公开，抢答者据此作答） */
  description: string | null;
  /** 整局所有格子的公开记录，按选中顺序追加 */
  history: CellRecord[];
  /** by = 谁在用抢答权；lockedBy = 谁提前锁定防抢答 */
  steal: { by: Team | null; lockedBy: Team | null };
  /** 抢答预算：红按行、绿按列各一次 */
  stealUsed: { RED: number[]; GREEN: number[] };
  /**
   * 本局是否启用抢答。开局前由选手/房主设定，默认关闭；
   * 关闭时「抢答 / 防抢答」两个意图一律被拒，界面上也不给入口。
   */
  stealEnabled: boolean;
  /**
   * 重开表决：四个席位各按一次同意，凑满四席立即重开一局。
   * 只在对局中/结束后有效，按席位存（不按队），离开席位会把该席的票收走。
   */
  restartVotes: SeatKey[];
  swapVotes: Team[];
  swapUsed: boolean;
  /**
   * 判对申请：最新一次猜词其实是正确答案，双方描述位各投一票即可改判。
   * 与换题同一套双票机制，任一方都能发起，但必须对方也同意。
   */
  judgeVotes: Team[];
  /** 首票锁定的目标猜词：中途有人又猜了一次也不改变这次申请的对象 */
  judgeTarget: { team: Team; guess: string } | null;
  /**
   * 撤回申请：某队想作废自己最近一次描述/作答，**对方任意一人**点同意才生效。
   * 只覆盖还没结算的动作（答对已落格，归「判对/改判」管）。
   * 任何一次推进（新的描述/作答/选格/换题/超时）都会把它清掉，申请不会跨回合滞留。
   */
  undoRequest: UndoRequest | null;
  /** 暂停：任意选手可随时按下，计时窗口整体顺延 */
  pausedAt: number | null;
  pausedBy: string | null;
  deadlineAt: number | null;
  windowMs: number;
  result: GameResult | null;
  resultAt: number | null;
  winner: Team | null;
  /**
   * 解散时间戳：房主（或开发者）点「解散房间」后写上。
   * 一旦写上，房间视为已销毁——不接受任何操作，房号立刻可被回收复用。
   */
  closedAt: number | null;
  log: LogItem[];
  logSeq: number;
}

export interface Secrets {
  all: WordEntry[];
  cellWords: Record<string, WordEntry>;
  pool: WordEntry[];
  /**
   * 已经上过场的词（跨「重开」累计）：重开时优先发没上过场的。
   * 老房间没有这个字段，引擎按空数组兜底。
   */
  used?: string[];
  /**
   * 观众猜词的私下记账：观众 id → 本格猜了几次 / 是否已经猜中。
   *
   * 只解到 vault 里，**不进公开快照**——「谁猜了哪些词」如果公开，
   * 就等于把答案逐字排除给全房间看。每换一格、换题、重开都会清空，
   * 它只对「当前这一幕」有意义。
   */
  specGuesses?: Record<string, { tries: number; hit: boolean }>;
}

/**
 * 观众猜词的私下回执：只回给发起猜词的那台设备。
 * 猜中时战况里会多一句「观众 xx 猜中了 A2 格」，但答案本身不出服务端。
 */
export interface SpecGuessResult {
  /** 猜的是哪一格（展示码） */
  cell: string;
  hit: boolean;
}

export type Intent =
  | { t: 'join'; seat: SeatKey; name: string; specId?: string; force?: boolean }
  | { t: 'leave'; seat: SeatKey }
  | { t: 'watch'; id: string; name: string }
  | { t: 'rename'; name: string; seat?: SeatKey; specId?: string }
  | { t: 'ready'; seat: SeatKey; value?: boolean }
  | { t: 'select'; seat: SeatKey; cellId: string }
  | { t: 'describe'; seat: SeatKey; text: string }
  | { t: 'guess'; seat: SeatKey; text: string }
  /** 主动跳过自己此刻该做的行动（选格/描述/作答/抢答） */
  | { t: 'skip'; seat: SeatKey }
  | { t: 'steal'; seat: SeatKey }
  | { t: 'lock'; seat: SeatKey }
  /** 开局前设定本局是否启用抢答（默认关闭，重开沿用） */
  | { t: 'setSteal'; enabled: boolean }
  /** 重开表决：四席都同意才重开；再点一次表示撤回同意 */
  | { t: 'restart'; seat: SeatKey }
  | { t: 'swap'; seat: SeatKey }
  /** 描述位申请把最新一次猜词改判为正确（需对方描述位同意） */
  | { t: 'judge'; seat: SeatKey }
  /** 申请撤回本队最近一次描述/作答（需对方任意一人同意） */
  | { t: 'undo'; seat: SeatKey }
  /** 对方同意撤回：作废那次动作，退回对应的输入/作答窗口 */
  | { t: 'undoAgree'; seat: SeatKey }
  /**
   * 作废一条待表决的申请：发起方点=撤销自己的申请，对方点=拒绝。
   * 两种都让这条申请结束（换题/判对是双票制，撤回是单同意制）。
   */
  | { t: 'reject'; kind: 'swap' | 'judge' | 'undo'; seat: SeatKey }
  | { t: 'pause'; by?: string }
  | { t: 'resume'; by?: string }
  /**
   * 观众猜本格的词（任何对局阶段都行，猜中不影响对局）。
   * `id` / `name` 由服务端按观战令牌覆盖，客户端自报不作数。
   */
  | { t: 'specGuess'; text: string; id?: string; name?: string }
  | { t: 'approveBank'; id: string }
  | { t: 'rejectBank'; id: string }
  /** 选手将观众设为/取消裁判 */
  | { t: 'setReferee'; spectatorId: string; enabled: boolean }
  /** 裁判直接修改某个格子的词和外显代号（包括游戏中途） */
  | { t: 'refereeEditCell'; cellId: string; word: string; code?: string }
  /** 裁判调整/交换两个格子的位置 */
  | { t: 'refereeSwapCells'; cellIdA: string; cellIdB: string }
  /** 裁判撤销上一步操作 */
  | { t: 'refereeUndo' }
  /** 裁判恢复撤销的操作 */
  | { t: 'refereeRedo' }
  /** 房主（或开发者）解散房间：写上 closedAt，房号立即回收 */
  | { t: 'close' }
  /** 开发者模式：一次坐满四个测试席位 / 四席全部准备 */
  | { t: 'devSetup' }
  | { t: 'devReadyAll' }
  | { t: 'timeout' }
  | { t: 'next' }
  | { t: 'start' };

export const WINDOW_SELECT = 90_000;
export const WINDOW_DESCRIBE = 90_000;
export const WINDOW_GUESS = 90_000;
export const WINDOW_STEAL = 20_000;
export const RESULT_HOLD = 3_000;

/** 描述固定两个字：这是规则要求，不只是界面限制 */
export const DESC_CHARS = 2;
export const MAX_DESCRIPTION = DESC_CHARS;
export const MAX_GUESS = 40;
/** 快照里保留的观战者条目上限，避免无限增长的设备把快照撑大 */
export const MAX_SPECTATORS = 200;
/** 同一个格子里最多回看多少条描述/作答（答错会一直交替下去，必须封顶） */
export const MAX_ATTEMPTS = 30;
/** 观众在同一个格子里最多猜几次（防止拿词表暴力试词，也挡住无意义的写库风暴） */
export const MAX_SPEC_GUESS = 10;
/** 公开记录最多保留多少个格子（棋盘 5×5，一个格子只会被拿下一次） */
export const MAX_HISTORY = 25;

/** 开发者模式自带的四个测试席位昵称 */
export const DEV_NAMES: Record<SeatKey, string> = {
  RED_DESC: '测试甲',
  RED_GUESS: '测试乙',
  GREEN_DESC: '测试丙',
  GREEN_GUESS: '测试丁',
};
