import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GameState,
  Intent,
  SEAT_ORDER,
  SeatKey,
  SpecGuessResult,
  WordEntry,
  other,
  roleOf,
  roleName,
  seatOf,
  teamName,
  teamOf,
} from '../types';
import { canSteal, latestWrongGuess, undoableOf } from '../engine';
import { validateDescription } from '../words';
import { Reveal } from '../net/room';
import { Board } from './Board';
import { Records } from './Records';
import { BankPanel } from './Bank';
import { actingSeat } from './turn';
import { exportRoomImage } from './exportImage';

interface Props {
  state: GameState;
  reveal: Reveal | null;
  mySeat: SeatKey | null;
  /** 服务端下发的本机观众身份 id：判断「哪个是我」只认它，不认昵称 */
  spectatorId?: string | null;
  isHost: boolean;
  isReferee?: boolean;
  isDev: boolean;
  allCellWords?: Record<string, WordEntry> | null;
  nick: string;
  /** 服务端时钟 - 本机时钟；deadlineAt 是服务端时间戳，需要换算 */
  clockOffset: number;
  onIntent: (intent: Intent) => void;
  /** 观众猜词：返回服务端的私下回执（猜中 / 未命中），不影响对局 */
  onSpecGuess: (text: string) => Promise<SpecGuessResult | null>;
  onRename: (name: string) => void;
  onClaimSeat: (seat: SeatKey) => void;
  onLeaveSeat: () => void;
  onExit: () => void;
  onProposeFile: (file: File, passphrase: string) => Promise<void>;
  onProposeText: (name: string, words: WordEntry[]) => Promise<void>;
  onProposeDemo: () => Promise<void>;
}

const fmt = (ms: number) => `${Math.ceil(ms / 1000)}s`;

function phaseLabel(state: GameState): string {
  switch (state.phase) {
    case 'select':
      return `${teamName(state.selector)} 选格`;
    case 'describe':
      return `${teamName(state.activeDescriber ?? 'RED')} 描述`;
    case 'guess':
      return `${teamName(state.activeDescriber ?? 'RED')} 作答`;
    case 'steal':
      return `${teamName(state.steal.by ?? 'RED')} 抢答`;
    case 'result':
      return '本格结算';
    case 'finished':
      return '对局结束';
    default:
      return '等待开局';
  }
}

export function Room({
  state,
  reveal,
  mySeat,
  spectatorId,
  isHost,
  isReferee = false,
  isDev,
  allCellWords,
  nick,
  clockOffset,
  onIntent,
  onSpecGuess,
  onRename,
  onClaimSeat,
  onLeaveSeat,
  onExit,
  onProposeFile,
  onProposeText,
  onProposeDemo,
}: Props) {
  const [tick, setTick] = useState(Date.now());
  const [guess, setGuess] = useState('');
  const [desc, setDesc] = useState('');
  const [descErr, setDescErr] = useState<string | null>(null);
  /** 观众猜词：输入、提交中、上一次的回执（猜中 / 未命中） */
  const [specText, setSpecText] = useState('');
  const [specBusy, setSpecBusy] = useState(false);
  const [specHint, setSpecHint] = useState<{ hit: boolean; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 「解散房间」两步确认：点一次进入确认态，再点一次才真解散 */
  const [confirmClose, setConfirmClose] = useState(false);
  /** 开发者代打：先选一个席位，再像真人一样操作它 */
  const [devSeat, setDevSeat] = useState<SeatKey>('RED_DESC');

  /** 裁判透视开关：是否显示棋盘上所有格子的真实词语 */
  const [showRefereeWords, setShowRefereeWords] = useState(true);
  /** 裁判交互模式：'edit' 改词/代号 | 'swap' 换格子位置 | null */
  const [refereeMode, setRefereeMode] = useState<'edit' | 'swap' | null>(null);
  /** 换位模式下选中的第一个格子 ID */
  const [refereeSelectedCellId, setRefereeSelectedCellId] = useState<string | null>(null);
  /** 正在编辑格子的弹窗数据 */
  const [editingCell, setEditingCell] = useState<{ id: string; code: string; word: string } | null>(null);
  /** 展开观众管理列表 */
  const [showSpectatorManager, setShowSpectatorManager] = useState(false);

  const toastTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 200);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    setGuess('');
    setDesc('');
    setDescErr(null);
  }, [state.currentCellId, state.phase, state.activeDescriber]);

  // 换到新的一格就清空：上一格的猜词结果与输入对新格子没有意义
  useEffect(() => {
    setSpecText('');
    setSpecHint(null);
  }, [state.currentCellId]);

  const flash = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  const cell = useMemo(
    () => state.board.find((c) => c.id === state.currentCellId) ?? null,
    [state.board, state.currentCellId]
  );

  const paused = !!state.pausedAt;
  const now = tick + clockOffset;
  /** 暂停时用「暂停那一刻的剩余时间」，而不是让进度条自己变满 */
  const remaining = state.deadlineAt
    ? paused
      ? Math.max(0, state.deadlineAt - (state.pausedAt as number))
      : Math.max(0, state.deadlineAt - now)
    : 0;
  const pct = state.windowMs ? Math.min(100, (remaining / state.windowMs) * 100) : 0;
  const active = actingSeat(state);

  const myTeam = mySeat ? teamOf(mySeat) : null;
  const myRole = mySeat ? roleOf(mySeat) : null;
  const holder = state.steal.by;

  const selectSeat = seatOf(state.selector, 'DESC');
  const descSeat = state.activeDescriber ? seatOf(state.activeDescriber, 'DESC') : null;
  const guessSeat = state.activeDescriber ? seatOf(state.activeDescriber, 'GUESS') : null;
  const foeGuessSeat = state.activeDescriber ? seatOf(other(state.activeDescriber), 'GUESS') : null;
  const heldSeat = holder ? seatOf(holder, 'GUESS') : null;

  /** 开发者按「当前代打的席位」操作；普通玩家只能操作自己的席位 */
  const can = (seat: SeatKey | null) =>
    !!seat && (isDev ? seat === devSeat || seat === mySeat : mySeat === seat);

  const canSelectNow = state.phase === 'select' && can(selectSeat);
  const canDescribeNow = state.phase === 'describe' && can(descSeat);
  const canGuessNow = !!state.activeDescriber && state.phase === 'guess' && can(guessSeat);
  /** 本局是否启用抢答：关闭时界面不给入口，引擎也会拒（默认关闭） */
  const stealOn = !!state.stealEnabled;
  const canStealNow =
    stealOn &&
    (state.phase === 'describe' || state.phase === 'guess') &&
    can(foeGuessSeat) &&
    !holder &&
    !state.steal.lockedBy;
  /**
   * 防抢答 = 在自己的作答时机抢答本应自己答的题（不消耗抢答次数），
   * 所以只在本方作答窗口（guess）出现；描述还没写完时不算答题时机。
   */
  const canLockNow =
    stealOn && state.phase === 'guess' && can(guessSeat) && !holder && !state.steal.lockedBy;

  /**
   * 换题要**双方描述位各投一票**才生效（引擎里 swapVotes 满 2 才换），
   * 所以入口对双方的描述位都要可见，而不是只给当前行动方。
   */
  const swapDescSeat: SeatKey | null = (() => {
    // 开发者可能一边坐着某个席位、一边代打另一个：表态入口要跟着「当前代打的席位」走。
    // 之前用 [mySeat, devSeat].find(...)，切到对方描述位后仍会认回自己原来那个席位，
    // 于是同一行既显示「撤销申请」又发不出对方的票。
    if (isDev && devSeat && roleOf(devSeat) === 'DESC') return devSeat;
    if (mySeat && roleOf(mySeat) === 'DESC') return mySeat;
    return null;
  })();
  const swapTeam = swapDescSeat ? teamOf(swapDescSeat) : null;
  const swapVoted = !!swapTeam && state.swapVotes.includes(swapTeam);
  const swapOpen = state.phase === 'describe' || state.phase === 'guess';

  const showWord = !!reveal?.word && (isDev || (myRole === 'DESC' && !!mySeat));
  const inGame = state.phase !== 'lobby' && state.phase !== 'finished';
  /** 这三个阶段下面有行动标题，头部就不再重复阶段名 */
  const hasTurnTitle = state.phase === 'describe' || state.phase === 'guess' || state.phase === 'steal';
  const isRefereeUser = isReferee || isDev;
  const canManageReferee = !!mySeat || isHost || isReferee || isDev;

  const handleRefereeCellClick = (cellId: string) => {
    if (refereeMode === 'edit') {
      const c = state.board.find((b) => b.id === cellId);
      if (!c) return;
      const w = allCellWords?.[cellId]?.word ?? c.revealedWord ?? '';
      setEditingCell({ id: cellId, code: c.code, word: w });
    } else if (refereeMode === 'swap') {
      if (!refereeSelectedCellId) {
        setRefereeSelectedCellId(cellId);
        flash('已选定第 1 个格子，请点击第 2 个格子交换位置');
      } else if (refereeSelectedCellId === cellId) {
        setRefereeSelectedCellId(null);
        flash('已取消选中');
      } else {
        onIntent({ t: 'refereeSwapCells', cellIdA: refereeSelectedCellId, cellIdB: cellId });
        setRefereeSelectedCellId(null);
        setRefereeMode(null);
        flash('已交换两格位置');
      }
    }
  };

  const submitEditCell = () => {
    if (!editingCell) return;
    const word = editingCell.word.trim();
    if (!word) {
      flash('词语不能为空');
      return;
    }
    onIntent({
      t: 'refereeEditCell',
      cellId: editingCell.id,
      word,
      code: editingCell.code.trim() || undefined,
    });
    setEditingCell(null);
    flash('格子词语与代号已更新');
  };
  const emptySeats = SEAT_ORDER.filter((s) => !state.players[s]);
  const readyCount = SEAT_ORDER.filter((s) => state.ready[s]).length;
  const seatedCount = SEAT_ORDER.filter((s) => state.players[s]).length;
  const spectatorCount = state.spectators?.length ?? 0;
  const totalParticipants = seatedCount + spectatorCount;
  const refereeCount = state.spectators?.filter((s) => state.refereeIds?.includes(s.id)).length ?? 0;

  const submitGuess = () => {
    if (!mySeat && !isDev) return;
    const seat = state.phase === 'steal' ? heldSeat : guessSeat;
    if (!seat || !guess.trim()) return;
    onIntent({ t: 'guess', seat, text: guess.trim() });
    setGuess('');
  };

  /** 描述只在提交时判断：输入过程中不提前警告 */
  const submitDesc = () => {
    if (!descSeat) return;
    const verdict = validateDescription(desc, reveal?.word ?? '');
    if (!verdict.ok) {
      setDescErr(verdict.error ?? '描述不合规则');
      return;
    }
    setDescErr(null);
    // 不清空输入：万一服务端仍拒绝，玩家还能看到并改自己写的两个字
    onIntent({ t: 'describe', seat: descSeat, text: desc.trim() });
  };

  const skip = (seat: SeatKey | null) => {
    if (seat) onIntent({ t: 'skip', seat });
  };

  /**
   * 观众猜词。猜中**不算答对**：只往战况里写一句「观众 xx 猜中了 A2 格」，
   * 猜的是什么词一个字都不出现；猜错只有自己看到「未命中」。
   */
  const submitSpecGuess = async () => {
    const text = specText.trim();
    if (!text || specBusy) return;
    setSpecBusy(true);
    try {
      const res = await onSpecGuess(text);
      if (res) setSpecHint({ hit: res.hit, text: res.hit ? '猜中了' : '未命中' });
    } finally {
      setSpecBusy(false);
    }
  };

  /** 观众（不在席位上的人）在这一格还没被拿下时可以猜，三个阶段都算「过程中」 */
  const specGuessOpen =
    !mySeat &&
    !!spectatorId &&
    !!cell &&
    !paused &&
    (state.phase === 'describe' || state.phase === 'guess' || state.phase === 'steal');

  const specGuessRow = specGuessOpen ? (
    <div className="spec-guess" data-spec-guess>
      <span className="tiny faint" title="猜中只在战况里公布「猜中了」，答案不会公开；也不影响对局">
        观众猜词
      </span>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input grow"
          placeholder="猜本格的词，回车提交"
          value={specText}
          onChange={(e) => {
            setSpecText(e.target.value);
            setSpecHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitSpecGuess();
          }}
        />
        <button
          className="btn"
          onClick={() => void submitSpecGuess()}
          disabled={!specText.trim() || specBusy}
        >
          猜
        </button>
      </div>
      {specHint ? (
        <p className={`spec-guess-hint ${specHint.hit ? 'is-hit' : 'is-miss'}`}>{specHint.text}</p>
      ) : null}
    </div>
  ) : null;

  const doExport = async () => {
    setExporting(true);
    try {
      const out = await exportRoomImage(state);
      flash(out.method === 'clipboard' ? '局面图已复制到剪贴板' : '剪贴板不可用，已改为下载');
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  /** 解散房间：房主/开发者专属。两步确认，避免误点；解散后房号立即回收 */
  const doClose = () => {
    if (!confirmClose) {
      setConfirmClose(true);
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    setConfirmClose(false);
    window.clearTimeout(closeTimer.current);
    onIntent({ t: 'close' });
  };

  const guessBox = (
    <div className="stack" style={{ gap: 8 }}>
      <input
        className="input"
        placeholder="输入你猜的词语，回车提交"
        value={guess}
        onChange={(e) => setGuess(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitGuess();
        }}
      />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary grow" onClick={submitGuess} disabled={!guess.trim()}>
          提交答案
        </button>
        <button className="btn" onClick={() => skip(state.phase === 'steal' ? heldSeat : guessSeat)}>
          {state.phase === 'steal' ? '放弃抢答' : '跳过作答'}
        </button>
      </div>
    </div>
  );

  const swapRow = () => {
    if (!swapOpen || !swapDescSeat) return null;
    const otherVoted = state.swapVotes.length > 0 && !swapVoted;
    const hint = state.swapUsed
      ? '本格已换过题'
      : swapVoted
        ? '换题票 1/2 · 等对方同意'
        : otherVoted
          ? '对方请求换题'
          : '换题票 0/2';
    return (
      <div className="row-between">
        <span className="small faint">{hint}</span>
        {swapVoted ? (
          <button
            className="btn"
            title="撤掉自己这一票，换题申请作废"
            onClick={() => onIntent({ t: 'reject', kind: 'swap', seat: swapDescSeat })}
          >
            撤销申请
          </button>
        ) : otherVoted ? (
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-gold"
              onClick={() => onIntent({ t: 'swap', seat: swapDescSeat })}
            >
              同意换题
            </button>
            <button
              className="btn"
              title="拒绝后这条换题申请作废，双方要重新发起"
              onClick={() => onIntent({ t: 'reject', kind: 'swap', seat: swapDescSeat })}
            >
              拒绝
            </button>
          </div>
        ) : (
          <button
            className="btn btn-gold"
            disabled={state.swapUsed}
            onClick={() => onIntent({ t: 'swap', seat: swapDescSeat })}
          >
            请求换题
          </button>
        )}
      </div>
    );
  };

  /**
   * 判对申请：最新一次猜词其实是正确答案（同义说法被判错），
   * 由**双方描述位各投一票**改判——和换题同一套双票机制，任一方都能发起。
   */
  const judgeTarget = state.judgeTarget ?? latestWrongGuess(state);
  const judgeVoted = !!swapTeam && state.judgeVotes.includes(swapTeam);
  const judgeOtherVoted = state.judgeVotes.length > 0 && !judgeVoted;

  const judgeRow = () => {
    // 没有可改判的猜词就不占位（按钮亮着却点不了比不显示更糟）
    if (!swapOpen || !swapDescSeat || !judgeTarget) return null;
    // 答案最多 40 字，提示里只留前 10 个字，否则会把右栏撑爆
    const g = judgeTarget.guess.length > 10 ? `${judgeTarget.guess.slice(0, 10)}…` : judgeTarget.guess;
    const hint = judgeVoted
      ? '已申请判对 · 等对方同意'
      : judgeOtherVoted
        ? `对方申请判「${g}」为正确`
        : `判「${g}」为正确？`;
    return (
      <div className="row-between">
        <span className="small faint" title={`最新猜词：${judgeTarget.guess}`}>
          {hint}
        </span>
        {judgeVoted ? (
          <button
            className="btn"
            title="撤掉自己这一票，判对申请作废"
            onClick={() => onIntent({ t: 'reject', kind: 'judge', seat: swapDescSeat })}
          >
            撤销申请
          </button>
        ) : judgeOtherVoted ? (
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-gold"
              onClick={() => onIntent({ t: 'judge', seat: swapDescSeat })}
              title="最新一次猜词如果其实是正确答案，双方描述位各点一次即可改判"
            >
              同意判对
            </button>
            <button
              className="btn"
              title="拒绝后这条判对申请作废，要改判需重新发起"
              onClick={() => onIntent({ t: 'reject', kind: 'judge', seat: swapDescSeat })}
            >
              拒绝
            </button>
          </div>
        ) : (
          <button
            className="btn btn-gold"
            onClick={() => onIntent({ t: 'judge', seat: swapDescSeat })}
            title="最新一次猜词如果其实是正确答案，双方描述位各点一次即可改判"
          >
            申请判对
          </button>
        )}
      </div>
    );
  };

  /**
   * 撤回：作废本队最近一次描述/作答，**对方任意一人**点头就生效。
   * 发起方和同意方看的是同一处、不同文案；观众没有入口。
   */
  const undoRow = () => {
    if (paused) return null;
    const actSeat: SeatKey | null = isDev ? devSeat : mySeat;
    const myTeam = actSeat ? teamOf(actSeat) : null;
    if (!actSeat || !myTeam) return null;

    const req = state.undoRequest ?? null;
    if (req) {
      const what = req.kind === 'desc' ? '描述' : '作答';
      if (myTeam === req.team) {
        return (
          <div className="row-between">
            <span className="small faint">已申请撤回{what} · 等对方同意</span>
            <button
              className="btn"
              title="撤回自己的申请，继续当前进度"
              onClick={() => onIntent({ t: 'reject', kind: 'undo', seat: actSeat })}
            >
              撤销申请
            </button>
          </div>
        );
      }
      return (
        <div className="row-between">
          <span className="small faint">{teamName(req.team)}申请撤回{what}</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-gold" onClick={() => onIntent({ t: 'undoAgree', seat: actSeat })}>
              同意撤回
            </button>
            <button
              className="btn"
              title="拒绝后继续当前进度，要撤回需对方重新发起"
              onClick={() => onIntent({ t: 'reject', kind: 'undo', seat: actSeat })}
            >
              拒绝
            </button>
          </div>
        </div>
      );
    }

    const target = undoableOf(state);
    if (!target || target.team !== myTeam) return null;
    const what = target.kind === 'desc' ? '描述' : '作答';
    return (
      <div className="row-between">
        <span className="small faint">撤回{what}作废重来，需对方同意</span>
        <button className="btn" onClick={() => onIntent({ t: 'undo', seat: actSeat })}>
          申请撤回{what}
        </button>
      </div>
    );
  };

  /** 开局前的规则设定：是否启用抢答（默认关闭）。观众没有入口，权限在引擎/服务端判 */
  const canSetRule = !!(mySeat || isHost || isReferee || isDev);
  const ruleRow = (
    <label
      className={`rule-check${canSetRule ? '' : ' is-locked'}`}
      title="开启后，猜词位可以在对方描述/作答时抢答：红按行、绿按列各一次，每次 20 秒"
    >
      <input
        type="checkbox"
        checked={stealOn}
        disabled={!canSetRule}
        onChange={(e) => onIntent({ t: 'setSteal', enabled: e.target.checked })}
      />
      <span className="rule-check-text">启用抢答功能</span>
    </label>
  );

  /**
   * 重开：**四个席位各点一次同意**才生效（引擎 restartVotes 满 4）。
   * 入口在顶栏——它是对局级动作，不属于「本回合我要做什么」，放在答题卡里每次都要多占一行。
   * 只认席位票，观众只读。
   */
  const voteSeat: SeatKey | null = isDev ? devSeat : mySeat;
  const restartVotes = state.restartVotes ?? [];
  const restartButton = () => {
    if (state.phase === 'lobby') return null;
    const n = restartVotes.length;
    if (!voteSeat) return n ? <span className="pill">重开表决 {n}/4</span> : null;
    const voted = restartVotes.includes(voteSeat);
    const short = SEAT_ORDER.filter((s) => state.players[s]).length < SEAT_ORDER.length;
    return (
      <button
        className={`btn ${voted ? '' : 'btn-gold'}`}
        data-restart
        disabled={short}
        title={
          short
            ? '四个席位都有人时才能重开'
            : voted
              ? '再点一次即撤销同意'
              : '四席都同意后，用题库里没用过的词重开一局'
        }
        onClick={() => onIntent({ t: 'restart', seat: voteSeat })}
      >
        {voted ? `已同意重开 ${n}/4` : n ? `重开 ${n}/4` : '重开'}
      </button>
    );
  };

  /**
   * 席位卡。桌面上放在棋盘左右两侧（一队一列），窄屏自动折回棋盘下方。
   * 「我的席位」只认服务端下发的 seat，不按昵称判断（重名是合法的）。
   */
  const seatCard = (seat: SeatKey) => {
    const name = state.players[seat];
    const team = teamOf(seat);
    const mine = can(seat);
    const isActive = active === seat;
    const claimable = !name;
    const ready = state.ready[seat];
    const canToggleReady = state.phase === 'lobby' && !!name && (mine || isDev);
    return (
      <div
        key={seat}
        className={[
          'roster-seat',
          isActive ? 'is-active' : '',
          mine ? 'is-mine' : '',
          claimable ? 'is-claimable' : '',
        ].join(' ')}
        onClick={() => {
          if (claimable) onClaimSeat(seat);
          else if (isDev) setDevSeat(seat);
        }}
      >
        <span className="tiny faint roster-team">
          <span className={`seat-dot ${team === 'RED' ? 'is-red' : 'is-green'}`} aria-hidden="true" />
          <span className="roster-team-long">
            {teamName(team)} · {roleName(roleOf(seat))}
          </span>
          {/* 手机上棋盘角落只有几十像素宽，全称放不下，只留一个「描 / 猜」 */}
          <span className="roster-role-short" aria-hidden="true">
            {roleName(roleOf(seat))[0]}
          </span>
        </span>
        <span className="roster-name">{name ?? '空位'}</span>

        <div className="roster-tags">
          {isActive ? (
            <span className={`acting ${mine ? 'is-mine' : ''}`}>
              <span className="acting-dot" aria-hidden="true" />
              {mine ? '轮到你了' : '行动中'}
            </span>
          ) : null}
          {name && state.phase === 'lobby' ? (
            <span className={`pill ${ready ? 'pill-green' : ''}`}>{ready ? '已准备' : '待准备'}</span>
          ) : null}
          {claimable ? <span className="tiny seat-empty-hint">点我入座</span> : null}
        </div>

        {canToggleReady ? (
          <button
            className={`btn btn-block ${ready ? '' : 'btn-primary'}`}
            style={{ padding: '4px 10px', fontSize: 12, marginTop: 2 }}
            onClick={(e) => {
              e.stopPropagation();
              onIntent({ t: 'ready', seat, value: !ready });
            }}
            disabled={paused}
          >
            {ready ? '取消准备' : '准备'}
          </button>
        ) : null}
      </div>
    );
  };

  // 房间已解散：整块换成一句提示，不再渲染对局界面
  if (state.closedAt) {
    return (
      <div className="landing">
        <div className="card stack center" style={{ width: 'min(420px, 100%)', gap: 10 }}>
          <h2 className="display" style={{ fontSize: 20 }}>房间已解散</h2>
          <p className="small muted">房号 {state.roomCode} 已释放，可以被其他房间重用。</p>
          <button className="btn btn-primary" onClick={onExit}>
            返回
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell shell-room">
      <div className="topbar">
        <span className="pill mono">房号 {state.roomCode}</span>
        <span className="pill pill-blue">{phaseLabel(state)}</span>
        <span className="pill">第 {state.round} 回合</span>
        {paused ? <span className="pill pill-gold">已暂停</span> : null}
        <button
          className="btn"
          style={{ padding: '3px 8px', fontSize: 12 }}
          onClick={() => setShowSpectatorManager((v) => !v)}
          title="查看包含观众在内的当前房间全部玩家"
        >
          房间玩家 {totalParticipants}
        </button>
        {isDev ? (
          <div className="dev-seats">
            {SEAT_ORDER.map((seat) => (
              <button
                key={seat}
                data-dev-seat={seat}
                className={[
                  'dev-seat',
                  teamOf(seat) === 'RED' ? 'is-red' : 'is-green',
                  devSeat === seat ? 'is-on' : '',
                ].join(' ')}
                title={`代打 ${state.players[seat] ?? '空位'}`}
                onClick={() => setDevSeat(seat)}
              >
                {teamName(teamOf(seat))[0]}
                {roleName(roleOf(seat))[0]}
              </button>
            ))}
          </div>
        ) : null}
        {isReferee ? <span className="pill pill-gold" style={{ background: '#fef3c7', color: '#92400e', borderColor: '#fcd34d' }}>裁判</span> : null}
        {isHost ? <span className="pill pill-gold">房主</span> : null}
        {isDev ? <span className="pill pill-blue">开发者</span> : null}
        <span className="grow" />
        <NickEditor value={nick} onSave={onRename} />
        <button className="btn" onClick={doExport} disabled={exporting}>
          {exporting ? '生成中…' : '复制局面图'}
        </button>
        {inGame ? (
          <button
            className="btn"
            onClick={() => onIntent({ t: paused ? 'resume' : 'pause' })}
            disabled={!mySeat && !isHost && !isReferee && !isDev}
            title={!mySeat && !isReferee ? '只有选手或裁判可以暂停' : '暂停后计时整体顺延'}
          >
            {paused ? '继续' : '暂停'}
          </button>
        ) : null}
        {restartButton()}
        {isHost || isDev ? (
          <button
            className="btn"
            data-close-room
            onClick={doClose}
            title="解散后房号立即回收"
          >
            {confirmClose ? '确认解散？' : '解散房间'}
          </button>
        ) : null}
        {/* 离席和退出都是会话级动作，放同一排；手机端因此可以整行省掉下面的玩家名单 */}
        {mySeat ? (
          <button className="btn" onClick={onLeaveSeat} title="让出席位、留在房间观战">
            离席
          </button>
        ) : null}
        <button className="btn" onClick={onExit}>
          退出
        </button>
      </div>

      {paused ? (
        <div className="pause-banner">
          <span>{state.pausedBy ?? '选手'} 暂停了对局，计时已冻结</span>
          <button className="btn btn-primary" onClick={() => onIntent({ t: 'resume' })} disabled={!mySeat && !isHost && !isReferee && !isDev}>
            继续对局
          </button>
        </div>
      ) : null}

      <div className="room-sub">
        <span className="tiny room-sub-names" style={{ color: 'var(--muted)', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <strong style={{ color: 'var(--ink)' }}>房间玩家 {totalParticipants} 人</strong>
          <span style={{ color: 'var(--faint)' }}>（选手 {seatedCount}/4 · 观战 {spectatorCount} 人）</span>
          {spectatorCount ? (
            <span style={{ color: 'var(--muted)' }}>
              观战：{state.spectators.slice(-8).map((s) => s.name).join('、')}
            </span>
          ) : null}
          {state.refereeIds?.length ? (
            <span style={{ marginLeft: 6, color: '#92400e', fontWeight: 500 }}>
              裁判：{state.spectators.filter((s) => state.refereeIds.includes(s.id)).map((s) => s.name).join('、') || '无'}
            </span>
          ) : null}
        </span>
        <button
          className="btn room-sub-players"
          style={{ padding: '3px 8px', fontSize: 11 }}
          onClick={() => setShowSpectatorManager((v) => !v)}
          title="查看包含观众在内的当前房间全部玩家并管理裁判"
        >
          {showSpectatorManager ? '收起玩家列表' : `房间玩家·含观众 (${totalParticipants})`}
        </button>
        <span className="grow" />
        {isReferee ? <span className="pill pill-gold" style={{ background: '#fef3c7', color: '#92400e' }}>裁判</span> : null}
        {isHost ? <span className="pill pill-gold">房主</span> : null}
        {isDev ? <span className="pill pill-blue">开发者</span> : null}
      </div>

      <div className="room-grid">
        {/* 左列 = 棋盘 + 对局历史，两列各自独立排布：
            否则历史属于「下一行栅格」，行高被更高的右栏撑开，棋盘下就会空出一大块。 */}
        <div className="room-main">
          <div className={`card board-card stack${state.phase === 'lobby' ? '' : ' seats-compact'}`} style={{ gap: 10 }}>
            {/* 裁判专属控制面板 */}
            {isRefereeUser ? (
              <div
                className="stack"
                style={{
                  background: '#fffdf5',
                  border: '1px solid #fde047',
                  borderRadius: 8,
                  padding: '10px 12px',
                  gap: 8,
                }}
              >
                <div className="row-between" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <strong style={{ fontSize: 13, color: '#854d0e' }}>裁判权限</strong>
                    <button
                      className={`btn ${showRefereeWords ? 'btn-primary' : ''}`}
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      onClick={() => setShowRefereeWords((v) => !v)}
                      title="在棋盘上常驻显示所有格子的真实词语"
                    >
                      {showRefereeWords ? '透视词语 (已开)' : '透视词语 (已关)'}
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      onClick={() => onIntent({ t: paused ? 'resume' : 'pause', by: nick || '裁判' })}
                    >
                      {paused ? '继续' : '暂停'}
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      disabled={!state.canUndo}
                      onClick={() => onIntent({ t: 'refereeUndo' })}
                      title="将对局历史撤销到上一步（自动暂停）"
                    >
                      撤销上一步
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      disabled={!state.canRedo}
                      onClick={() => onIntent({ t: 'refereeRedo' })}
                      title="恢复已撤销的操作"
                    >
                      恢复
                    </button>
                  </div>

                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <button
                      className={`btn ${refereeMode === 'edit' ? 'btn-primary' : ''}`}
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      onClick={() => {
                        setRefereeMode((m) => (m === 'edit' ? null : 'edit'));
                        setRefereeSelectedCellId(null);
                      }}
                    >
                      {refereeMode === 'edit' ? '退出编辑' : '改格子词/代号'}
                    </button>
                    <button
                      className={`btn ${refereeMode === 'swap' ? 'btn-primary' : ''}`}
                      style={{ padding: '4px 8px', fontSize: 11 }}
                      onClick={() => {
                        setRefereeMode((m) => (m === 'swap' ? null : 'swap'));
                        setRefereeSelectedCellId(null);
                      }}
                    >
                      {refereeMode === 'swap' ? '退出换位' : '改变格子位置'}
                    </button>
                  </div>
                </div>

                {refereeMode === 'edit' ? (
                  <div className="tiny" style={{ color: '#7c3aed' }}>
                    编辑模式：直接点击棋盘上任意格子，即可实时修改该格子的真实词语与外显代号（中途有效）。
                  </div>
                ) : null}
                {refereeMode === 'swap' ? (
                  <div className="tiny" style={{ color: '#2563eb' }}>
                    换位模式：{refereeSelectedCellId ? '已选定第 1 格，请点击第 2 格进行位置互换' : '请先点击第 1 个要调位的格子'}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="board-area">
              {/* 席位卡放在棋盘两侧空出来的地方：一队一列，中间是棋盘 */}
              <div className="seat-rail" data-rail="RED">
                {SEAT_ORDER.filter((x) => teamOf(x) === 'RED').map(seatCard)}
              </div>

              <div className="board-mid stack" style={{ gap: 10 }}>
                <Board
                  board={state.board}
                  currentCellId={state.currentCellId}
                  canSelect={canSelectNow && !paused}
                  onSelect={(id) => selectSeat && onIntent({ t: 'select', seat: selectSeat, cellId: id })}
                  placeholder={state.bank ? null : '等待导入本局题库'}
                  allCellWords={allCellWords}
                  showRefereeWords={isRefereeUser && showRefereeWords}
                  refereeMode={refereeMode}
                  refereeSelectedCellId={refereeSelectedCellId}
                  onRefereeCellClick={handleRefereeCellClick}
                />
                {state.phase === 'select' && !paused ? (
                  <div className="row-between" style={{ padding: '0 4px' }}>
                    <p className="small" style={{ color: canSelectNow ? 'var(--gold)' : 'var(--muted)' }}>
                      {canSelectNow ? '轮到你们选格' : `等待 ${state.players[selectSeat] ?? '描述位'} 选格…`}
                    </p>
                    {canSelectNow ? (
                      <button className="btn" onClick={() => skip(selectSeat)}>
                        跳过选格
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {!mySeat && !isDev && emptySeats.length ? (
                  <p className="small center muted">观战中 · {emptySeats.length} 个空位可接替</p>
                ) : null}
              </div>

              <div className="seat-rail" data-rail="GREEN">
                {SEAT_ORDER.filter((x) => teamOf(x) === 'GREEN').map(seatCard)}
              </div>
            </div>

            {/* 胜利条件常驻棋盘底部：写在 .board-area 之外，免得把右下的绿方席位卡推下去 */}
            <p className="board-hint">红方纵向或绿方横向连成一条线即可胜利</p>
          </div>

          <Records state={state} />
        </div>

        {/* 右栏：作答面板 + 次要卡片（题库 / 战况）。分成两块是为了手机端能把
            「作答」排在「对局历史」前面、把题库和战况压到最后——手机上它们不是每回合都要看。 */}
        <div className="room-side">
        <div className="panel">
            {showSpectatorManager ? (
              <div
                className="card stack room-players-sidebar"
                style={{
                  background: '#faf9f6',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  gap: 10,
                }}
              >
                <div className="row-between" style={{ alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  <div>
                    <strong style={{ fontSize: 13, color: 'var(--ink)' }}>当前房间玩家</strong>
                    <span className="tiny muted" style={{ marginLeft: 6 }}>
                      ({totalParticipants} 人 · 选手 {seatedCount}/4)
                    </span>
                  </div>
                  <button
                    className="btn"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setShowSpectatorManager(false)}
                  >
                    收起
                  </button>
                </div>

                {/* 对战选手席位 (4席) */}
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row-between" style={{ alignItems: 'center' }}>
                    <span className="tiny" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                      对战选手席位（{seatedCount}/4）
                    </span>
                    {!mySeat ? (
                      <span className="tiny" style={{ color: 'var(--blue)', fontSize: 11 }}>
                        点空位可参赛
                      </span>
                    ) : null}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {SEAT_ORDER.map((seat) => {
                      const name = state.players[seat];
                      const team = teamOf(seat);
                      const role = roleOf(seat);
                      const isMine = mySeat === seat;
                      const ready = state.ready[seat];
                      const canToggleReady = state.phase === 'lobby' && !!name && (isMine || isDev);
                      const isClaimable = !name;

                      return (
                        <div
                          key={seat}
                          style={{
                            background: isMine ? 'var(--blue-soft)' : '#ffffff',
                            border: isMine ? '1px solid var(--blue-line)' : isClaimable ? '1px dashed var(--line-strong)' : '1px solid var(--line)',
                            borderRadius: 6,
                            padding: '6px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 3,
                          }}
                        >
                          <div className="row-between" style={{ alignItems: 'center' }}>
                            <span className="tiny roster-team" style={{ color: team === 'RED' ? 'var(--red)' : 'var(--green)', fontWeight: 600, fontSize: 11 }}>
                              <span className={`seat-dot ${team === 'RED' ? 'is-red' : 'is-green'}`} aria-hidden="true" />
                              {teamName(team)[0]}{roleName(role)[0]}
                            </span>
                            <div className="row" style={{ gap: 2 }}>
                              {isMine ? <span className="pill pill-blue" style={{ fontSize: 9, padding: '0 4px' }}>我</span> : null}
                              {isMine && isHost ? <span className="pill pill-gold" style={{ fontSize: 9, padding: '0 4px' }}>房主</span> : null}
                            </div>
                          </div>

                          <div className="row-between" style={{ alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontWeight: name ? 500 : 400, color: name ? 'var(--ink)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {name ?? '空位'}
                            </span>
                            {name && state.phase === 'lobby' ? (
                              <span className={`pill ${ready ? 'pill-green' : ''}`} style={{ fontSize: 9, padding: '0 4px' }}>
                                {ready ? '就绪' : '待定'}
                              </span>
                            ) : null}
                          </div>

                          {isClaimable && !mySeat ? (
                            <button
                              className="btn btn-primary"
                              style={{ padding: '1px 6px', fontSize: 10, alignSelf: 'flex-start', marginTop: 2 }}
                              onClick={() => onClaimSeat(seat)}
                            >
                              入座
                            </button>
                          ) : null}
                          {canToggleReady ? (
                            <button
                              className={`btn ${ready ? '' : 'btn-primary'}`}
                              style={{ padding: '1px 6px', fontSize: 10, alignSelf: 'flex-start', marginTop: 2 }}
                              onClick={() => onIntent({ t: 'ready', seat, value: !ready })}
                              disabled={paused}
                            >
                              {ready ? '取消准备' : '准备'}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 观战与裁判人员 */}
                <div className="stack" style={{ gap: 6, marginTop: 2 }}>
                  <div className="row-between" style={{ alignItems: 'center' }}>
                    <span className="tiny" style={{ fontWeight: 600, color: 'var(--ink)' }}>
                      观战与裁判人员（{spectatorCount} 人）
                    </span>
                    <span className="tiny faint" style={{ fontSize: 10 }}>
                      {canManageReferee ? '可指派裁判' : ''}
                    </span>
                  </div>

                  {state.spectators?.length ? (
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {state.spectators.map((sp) => {
                        const isRef = state.refereeIds?.includes(sp.id) ?? false;
                        // 只认服务端下发的 specId。以前用「昵称相同」判断，
                        // 一旦名单里有重名条目，两条都会被标成「我」（看到两个自己）。
                        const isMe = !mySeat && !!spectatorId && sp.id === spectatorId;
                        return (
                          <div
                            key={sp.id}
                            className="row"
                            style={{
                              background: isRef ? '#fefce8' : isMe ? 'var(--blue-soft)' : '#ffffff',
                              border: isRef ? '1px solid #facc15' : isMe ? '1px solid var(--blue-line)' : '1px solid #cbd5e1',
                              borderRadius: 6,
                              padding: '3px 8px',
                              alignItems: 'center',
                              gap: 5,
                            }}
                          >
                            <span style={{ fontSize: 12, fontWeight: isRef || isMe ? 600 : 400, color: isRef ? '#92400e' : 'var(--ink)' }}>
                              {sp.name}
                            </span>
                            {isMe ? <span className="pill pill-blue" style={{ fontSize: 9, padding: '0 4px' }}>我</span> : null}
                            {isMe && isHost ? <span className="pill pill-gold" style={{ fontSize: 9, padding: '0 4px' }}>房主</span> : null}
                            {isRef ? <span className="pill pill-gold" style={{ fontSize: 9, padding: '0 4px' }}>裁判</span> : null}
                            {canManageReferee ? (
                              <button
                                className="btn"
                                style={{ padding: '1px 5px', fontSize: 10 }}
                                onClick={() => onIntent({ t: 'setReferee', spectatorId: sp.id, enabled: !isRef })}
                              >
                                {isRef ? '取消' : '设为裁判'}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="tiny muted" style={{ margin: 0 }}>当前暂无额外观战人员</p>
                  )}
                </div>
              </div>
            ) : null}

            <div className="card stack act-card">
              {/* 头部只占一行：左边「本格代号 + 首字/字数 + 阶段」，右边倒计时。
                  描述/作答/抢答三个阶段不写阶段名——下面那行行动标题（「绿方 描述位写描述」）
                  已经写着「哪一方、做什么」，重复一遍只是多占宽度。 */}
              <div className="row-between act-head">
                <div className="act-head-left">
                  {cell && state.phase !== 'lobby' ? (
                    <>
                      <span className="act-code mono">{cell.code}</span>
                      <span className="tiny muted">
                        首字 {cell.firstLetter} · {cell.charCount} 字
                      </span>
                    </>
                  ) : null}
                  {hasTurnTitle ? null : <span className="small muted">{phaseLabel(state)}</span>}
                </div>
                <span className="small mono" data-timer>
                  {state.deadlineAt ? fmt(remaining) : '—'}
                </span>
              </div>
              {state.deadlineAt ? (
                <div className="timer-track">
                  <div
                    className={`timer-fill ${paused ? 'is-paused' : remaining <= 10_000 ? 'is-warn' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              ) : (
                <div className="divider" />
              )}

              {state.phase === 'lobby' ? (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="turn-title">等待四席准备</div>
                  <div className="checklist">
                    <span className={state.bank ? 'is-ok' : ''}>
                      {state.bank ? '✓' : '○'} 题库{state.bank ? `「${state.bank.name}」` : '待导入'}
                    </span>
                    <span className={seatedCount === 4 ? 'is-ok' : ''}>
                      {seatedCount === 4 ? '✓' : '○'} 入座 {seatedCount}/4
                    </span>
                    <span className={readyCount === 4 ? 'is-ok' : ''}>
                      {readyCount === 4 ? '✓' : '○'} 准备 {readyCount}/4
                    </span>
                  </div>
                  {isDev ? (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-gold" onClick={() => onIntent({ t: 'devSetup' })} disabled={seatedCount === 4}>
                        坐满四个测试选手
                      </button>
                      <button className="btn" onClick={() => onIntent({ t: 'devReadyAll' })} disabled={seatedCount < 4}>
                        四席全部准备
                      </button>
                    </div>
                  ) : null}
                  {ruleRow}
                </div>
              ) : null}

              {showWord && reveal ? (
                <div className="word-card">
                  <span className="tiny" style={{ color: 'var(--gold)' }}>
                    题面{isDev ? ' · 开发者可见' : ''}
                  </span>
                  <div className="word-main">{reveal.word}</div>
                </div>
              ) : null}

              {state.phase === 'describe' && cell && !paused ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="turn-title">{teamName(state.activeDescriber!)} 描述位写描述</div>

                  {canDescribeNow ? (
                    <div className="stack" style={{ gap: 8 }}>
                      <input
                        className="input desc-input"
                        placeholder="两个字"
                        value={desc}
                        autoFocus
                        onChange={(e) => {
                          setDesc(e.target.value);
                          setDescErr(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            submitDesc();
                          }
                        }}
                      />
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn btn-primary grow" onClick={submitDesc} disabled={!desc.trim()}>
                          提交描述
                        </button>
                        <button className="btn" onClick={() => skip(descSeat)}>
                          跳过描述
                        </button>
                      </div>
                      {descErr ? <p className="small desc-error">{descErr}</p> : null}
                    </div>
                  ) : (
                    <p className="small muted">等待 {state.players[descSeat!] ?? '描述位'} 写描述…</p>
                  )}

                  {canStealNow && cell ? (
                    <button
                      className="btn btn-red btn-block"
                      disabled={!canSteal(state, other(state.activeDescriber!), cell)}
                      onClick={() => foeGuessSeat && onIntent({ t: 'steal', seat: foeGuessSeat })}
                    >
                      抢答（限时 20 秒）
                    </button>
                  ) : null}

                  {swapRow()}
                  {judgeRow()}
                  {undoRow()}
                </div>
              ) : null}

              {state.phase === 'guess' && cell && !paused ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="turn-title">{teamName(state.activeDescriber!)} 作答</div>
                  <div className="desc-bubble">
                    <span className="tiny faint">
                      {state.players[descSeat!] ?? '描述位'} 的描述
                    </span>
                    <p className="desc-text clue">{state.description ?? '（没有描述）'}</p>
                  </div>

                  {canGuessNow ? guessBox : <p className="small faint">等待 {state.players[guessSeat!] ?? '猜词位'} 作答…</p>}

                  {canLockNow && cell ? (
                    <button
                      className="btn"
                      onClick={() => guessSeat && onIntent({ t: 'lock', seat: guessSeat })}
                    >
                      防抢答（答题压到 20 秒）
                    </button>
                  ) : null}

                  {canStealNow && cell ? (
                    <button
                      className="btn btn-red btn-block"
                      disabled={!canSteal(state, other(state.activeDescriber!), cell)}
                      onClick={() => foeGuessSeat && onIntent({ t: 'steal', seat: foeGuessSeat })}
                    >
                      {state.steal.lockedBy ? '对方已锁定作答权' : '抢答（限时 20 秒）'}
                    </button>
                  ) : null}

                  {swapRow()}
                  {judgeRow()}
                  {undoRow()}
                </div>
              ) : null}

              {state.phase === 'steal' && cell && !paused ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="turn-title">{teamName(holder!)} 抢答中</div>
                  {state.description ? (
                    <div className="desc-bubble">
                      <span className="tiny faint">对方的描述</span>
                      <p className="desc-text clue">{state.description}</p>
                    </div>
                  ) : null}
                  {can(heldSeat) ? guessBox : <p className="small faint">等待抢答方作答…</p>}
                </div>
              ) : null}

              {paused ? <p className="small" style={{ color: 'var(--gold)' }}>暂停中，计时已冻结</p> : null}

              {/* 观众猜词：放在最后一行，不打断「轮到谁做什么」的主线 */}
              {specGuessRow}

              {state.phase === 'result' && state.result ? (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="result-big">
                    {teamName(state.result.team)} 拿下 {cell?.code ?? ''} 格
                  </div>
                  <p className="tiny faint">3 秒后自动继续</p>
                </div>
              ) : null}

              {state.phase === 'finished' ? (
                <div className="result-big">{teamName(state.winner!)} 获胜</div>
              ) : null}
            </div>
        </div>

          <div className="panel-more">
            {/* 战况常驻展开：对局中要一眼看到最近发生了什么，折叠按钮只会多一次点击 */}
            <div className="card stack" style={{ gap: 8 }}>
              <h2 style={{ fontSize: 14 }}>战况</h2>
              <div className="log">
                {state.log.map((item) => (
                  <div key={item.id} className="log-item">
                    {item.text}
                  </div>
                ))}
              </div>
            </div>

            {/* 题库排在战况下面：它只在开局前/换题库时才用，战况是每回合都要看的 */}
            <BankPanel
              state={state}
              isHost={isHost}
              isReferee={isReferee}
              isDev={isDev}
              onProposeFile={onProposeFile}
              onProposeText={onProposeText}
              onProposeDemo={onProposeDemo}
              onApprove={(id) => onIntent({ t: 'approveBank', id })}
              onReject={(id) => onIntent({ t: 'rejectBank', id })}
            />
          </div>
        </div>
      </div>

      {editingCell ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setEditingCell(null)}
        >
          <div
            className="card stack"
            style={{ width: 'min(380px, 92vw)', gap: 12, background: '#ffffff', padding: 20, boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between">
              <strong style={{ fontSize: 15, color: '#1f2937' }}>裁判修改格子内容</strong>
              <button className="btn" style={{ padding: '2px 8px', fontSize: 14 }} onClick={() => setEditingCell(null)}>
                ×
              </button>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <label className="tiny faint">外显代号 (如 X3，留空按首字母与字数自动生成)</label>
              <input
                className="input"
                value={editingCell.code}
                onChange={(e) => setEditingCell({ ...editingCell, code: e.target.value })}
                placeholder="例如 X3"
              />
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <label className="tiny faint">实际词语（必填，对决中途也可修改）</label>
              <input
                className="input"
                value={editingCell.word}
                onChange={(e) => setEditingCell({ ...editingCell, word: e.target.value })}
                placeholder="输入该格子的目标词"
                autoFocus
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button className="btn" onClick={() => setEditingCell(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={submitEditCell}>
                保存修改
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

/** 昵称随时可改：座位上是选手名，观战席上是观众名 */
function NickEditor({ value, onSave }: { value: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) boxRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const name = draft.trim().slice(0, 12);
    setEditing(false);
    if (name && name !== value) onSave(name);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <button className="btn nick-btn" onClick={() => setEditing(true)} title="点一下就能改昵称">
        <span className="nick-name">{value}</span>
        <span className="tiny faint">改昵称</span>
      </button>
    );
  }

  return (
    <input
      ref={boxRef}
      className="input nick-input"
      value={draft}
      maxLength={12}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}
