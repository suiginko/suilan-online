import { useCallback, useEffect, useRef, useState } from 'react';
import { GameState, Intent, SeatKey, SpecGuessResult, Spectator, WordEntry } from '../types';
import {
  Creds,
  Reveal,
  Snapshot,
  apiAct,
  apiImportBank,
  apiImportDemoBank,
  apiImportTextBank,
  apiSnapshot,
  apiWatch,
} from './api';

export type { Reveal, Snapshot } from './api';

export interface RoomApi {
  state: GameState | null;
  reveal: Reveal | null;
  /** 服务端根据令牌判定的席位，客户端自报的席位不作数 */
  mySeat: SeatKey | null;
  /** 本机的观战身份（坐进席位后为 null） */
  spectator: Spectator | null;
  isHost: boolean;
  /** 是否是裁判 */
  isReferee: boolean;
  isDev: boolean;
  /** 裁判或开发者透视用全局词表 */
  allCellWords: Record<string, WordEntry> | null;
  notice: string | null;
  /** 服务端时钟 - 本机时钟，用于把 deadlineAt 换算成本机时间 */
  clockOffset: number;
  online: boolean;
  /** 提交意图；返回的 Promise 在这轮请求落库后结束（离席这类操作要等它） */
  send: (intent: Intent) => Promise<void>;
  /**
   * 观众猜本格的词。回执只回给这一台设备（猜中 / 未命中），
   * 猜中时公开战况里会多一句「观众 xx 猜中了 A2 格」，答案本身不会出现。
   * 被拒（次数用尽/不在观战席）时返回 null，原因走 `notice` 提示。
   */
  specGuess: (text: string) => Promise<SpecGuessResult | null>;
  /**
   * 以观众身份登记（幂等，重复调用只会刷新昵称）。
   * 返回的 token 可能是**席位令牌**——服务端认回你原来坐的座位时会把座位还给你
   * （此时 seat 非空），调用方必须把它写进 seat 槽而不是 watch 槽。
   */
  watch: (name: string) => Promise<{ token: string; seat: SeatKey | null }>;
  importBank: (fileText: string, passphrase: string) => Promise<void>;
  importText: (name: string, words: WordEntry[]) => Promise<void>;
  importDemo: () => Promise<void>;
}

/** 老房间（或半旧快照）可能缺后来才加的字段，补齐再进 UI */
function normalize(s: Snapshot): Snapshot {
  const st = s.state;
  if (!Array.isArray(st.history)) st.history = [];
  if (!Array.isArray(st.bankProposals)) st.bankProposals = [];
  if (!Array.isArray(st.spectators)) st.spectators = [];
  if (!Array.isArray(st.refereeIds)) st.refereeIds = [];
  if (typeof st.canUndo !== 'boolean') st.canUndo = false;
  if (typeof st.canRedo !== 'boolean') st.canRedo = false;
  if (!st.ready) st.ready = { RED_DESC: false, RED_GUESS: false, GREEN_DESC: false, GREEN_GUESS: false };
  if (st.closedAt === undefined) st.closedAt = null;
  // 老房间没有判对申请字段
  if (!Array.isArray(st.judgeVotes)) st.judgeVotes = [];
  if (st.judgeTarget === undefined) st.judgeTarget = null;
  if (st.undoRequest === undefined) st.undoRequest = null;
  // 老房间没有抢答开关（默认关闭）与重开表决
  if (typeof st.stealEnabled !== 'boolean') st.stealEnabled = false;
  if (!Array.isArray(st.restartVotes)) st.restartVotes = [];
  return s;
}

const POLL_IDLE = 1200;
const POLL_LIVE = 900;
const POLL_BACKOFF = 2500;

/**
 * 房间同步层（跨设备）。
 *
 * 所有裁决都在服务端进程里跑，这里只做两件事：
 *   1. 定时拉公开快照（不含答案）
 *   2. 把本席位/观众的操作意图提交上去
 *
 * 题面（reveal）由服务端按席位令牌下发，猜词位拿不到；
 * 开发者模式下服务端会把当前格答案一并下发，方便测试。
 */
export function useRoom(code: string | null, creds: Creds): RoomApi {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);

  const credRef = useRef<Creds>(creds);
  const aliveRef = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);

  credRef.current = creds;
  const credKey = `${creds.seat ?? ''}|${creds.host ?? ''}|${creds.watch ?? ''}|${creds.dev ?? ''}`;

  /**
   * 采用服务端时钟偏移，但设 ±30s 合理边界：响应在链路上被拖延时，
   * serverNow 会明显早于本机收到它的时间，直接采用会把计时器带偏
   * （实测见过 90 秒的选格窗口显示 98s）。超出边界就保留上一轮的偏移，
   * 下一个正常快照会把它纠正回来。
   */
  const adoptClock = useCallback((serverNow: number) => {
    const off = serverNow - Date.now();
    setClockOffset((prev) => (Math.abs(off) <= 30_000 ? off : prev));
  }, []);

  const applySnapshot = useCallback(
    (s: Snapshot) => {
      setSnap(normalize(s));
      setOnline(true);
      adoptClock(s.serverNow);
    },
    [adoptClock]
  );

  useEffect(() => {
    if (!code) {
      setSnap(null);
      return;
    }
    aliveRef.current = true;
    let stopped = false;

    const loop = async () => {
      if (!aliveRef.current) return;
      let nextDelay = POLL_LIVE;
      try {
        const s = normalize(await apiSnapshot(code, credRef.current));
        if (!aliveRef.current) return;
        setSnap(s);
        setOnline(true);
        adoptClock(s.serverNow);
        nextDelay = s.state.phase === 'lobby' ? POLL_IDLE : POLL_LIVE;
        // 房间已解散：再没有新状态可看，停掉轮询（界面会显示「房间已解散」）
        if (s.state.closedAt) return;
      } catch (e) {
        if (!aliveRef.current) return;
        setOnline(false);
        setNotice((e as Error).message);
        nextDelay = POLL_BACKOFF;
      }
      if (stopped) return;
      timerRef.current = window.setTimeout(loop, nextDelay);
    };

    loop();

    return () => {
      stopped = true;
      aliveRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [code, credKey]);

  const send = useCallback(
    async (intent: Intent) => {
      if (!code) return;
      try {
        applySnapshot(await apiAct(code, credRef.current, intent));
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [code, applySnapshot]
  );

  /**
   * 观众猜词。与 `send()` 唯一的差别：它要把服务端回的私下回执
   * （猜中 / 未命中）当场告诉这一台设备——回执不进公开快照。
   */
  const specGuess = useCallback(
    async (text: string) => {
      if (!code) return null;
      try {
        const s = await apiAct(code, credRef.current, { t: 'specGuess', text });
        applySnapshot(s);
        return s.guessResult ?? null;
      } catch (e) {
        setNotice((e as Error).message);
        return null;
      }
    },
    [code, applySnapshot]
  );

  /** 以观众身份登记（幂等，重复调用只会刷新昵称），返回令牌与（可能被认回的）席位 */
  const watch = useCallback(
    async (name: string) => {
      if (!code) throw new Error('没有房号');
      const out = await apiWatch(code, name, credRef.current);
      applySnapshot(out.snapshot);
      return { token: out.token, seat: out.snapshot.seat };
    },
    [code, applySnapshot]
  );

  const importBank = useCallback(
    async (fileText: string, passphrase: string) => {
      if (!code) return;
      applySnapshot(await apiImportBank(code, credRef.current, fileText, passphrase));
    },
    [code, applySnapshot]
  );

  /** 明文词库：词表由前端识别、可预览可改，提交后只进服务端 vault */
  const importText = useCallback(
    async (name: string, words: WordEntry[]) => {
      if (!code) return;
      applySnapshot(await apiImportTextBank(code, credRef.current, name, words));
    },
    [code, applySnapshot]
  );

  const importDemo = useCallback(async () => {
    if (!code) return;
    applySnapshot(await apiImportDemoBank(code, credRef.current));
  }, [code, applySnapshot]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);

  return {
    state: snap?.state ?? null,
    reveal: snap?.reveal ?? null,
    mySeat: snap?.seat ?? null,
    spectator: snap?.spectator ?? null,
    isHost: snap?.isHost ?? false,
    isReferee: snap?.isReferee ?? false,
    isDev: snap?.isDev ?? false,
    allCellWords: snap?.allCellWords ?? null,
    notice,
    clockOffset,
    online,
    send,
    specGuess,
    watch,
    importBank,
    importText,
    importDemo,
  };
}
