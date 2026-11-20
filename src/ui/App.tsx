import { useCallback, useEffect, useRef, useState } from 'react';
import { SeatKey, WordEntry } from '../types';
import {
  Creds,
  EMPTY_CREDS,
  RoomSummary,
  apiClaimSeat,
  apiCreateRoom,
  apiListRooms,
  clearCreds,
  readCreds,
  writeCreds,
} from '../net/api';
import { useRoom } from '../net/room';
import { landingHref, roomQuery } from '../share';
import { Room } from './Room';

type Stage = { mode: 'landing' } | { mode: 'room'; code: string };

/** 房号是 3 位纯数字 */
const ROOM_CODE = /^\d{3}$/;
/** 隐藏口令：在落地页依次敲下这几个键开启开发者模式（再敲一次关闭） */
const DEV_PHRASE = 'suilan';
const DEV_FLAG = 'suilan-dev';

function stageFromUrl(): Stage {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') || '').trim();
  if (ROOM_CODE.test(room)) return { mode: 'room', code: room };
  return { mode: 'landing' };
}

function readDevFlag(): boolean {
  try {
    return localStorage.getItem(DEV_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 大厅里一行的阶段文案：大厅房说「等待开局」，对局中带回合数 */
function roomPhaseText(r: RoomSummary): string {
  if (r.phase === 'lobby') return '等待开局';
  if (r.phase === 'finished') return '已结束';
  return `对局中 · 第 ${r.round} 回合`;
}

export default function App() {
  const [stage, setStage] = useState<Stage>(() => stageFromUrl());
  const [creds, setCreds] = useState<Creds>(EMPTY_CREDS);
  const [nick, setNick] = useState(() => localStorage.getItem('suilan-name') || '');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(readDevFlag);
  const [devFlash, setDevFlash] = useState(false);
  /** 房间大厅：落地页列出还活着的房间，不用先知道房号 */
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomsErr, setRoomsErr] = useState<string | null>(null);

  const code = stage.mode === 'room' ? stage.code : null;
  const room = useRoom(code, creds);
  const watchingRef = useRef(false);
  const typedRef = useRef('');

  /**
   * 开发者模式的隐藏开关：在落地页依次敲下 suilan。
   * 打开后建房才会拿到开发者凭证（可以代打四个席位、看到当前题面）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key.length !== 1) return;
      typedRef.current = (typedRef.current + e.key.toLowerCase()).slice(-DEV_PHRASE.length);
      if (typedRef.current !== DEV_PHRASE) return;
      typedRef.current = '';
      setDevMode((prev) => {
        const next = !prev;
        try {
          localStorage.setItem(DEV_FLAG, next ? '1' : '0');
        } catch {
          /* 忽略 */
        }
        setDevFlash(true);
        window.setTimeout(() => setDevFlash(false), 2600);
        return next;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!code) return;
    setCreds(readCreds(code));
  }, [code]);

  /**
   * 房间大厅：只在落地页轮询（5 秒一次）。
   * 进来后房间列表就没有意义了，且每次都要读全表快照，没必要跟着 0.9 秒的房间轮询跑。
   */
  useEffect(() => {
    if (stage.mode !== 'landing') return;
    let alive = true;
    const load = async () => {
      try {
        const out = await apiListRooms();
        if (!alive) return;
        setRooms(out.rooms);
        setRoomsErr(null);
      } catch (e) {
        if (alive) setRoomsErr((e as Error).message);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [stage.mode]);

  /**
   * 打开链接但没有席位凭据：自动登记成观众。
   * 观众能看到棋盘、双方描述与作答，也能聊天、传题库、随时接替空位。
   *
   * 服务端可能认回你原来的身份（见 src/net/api.ts 的 deviceId）：
   * 如果它把某个席位还给你，返回的是**席位令牌**，必须放回 seat 槽。
   */
  useEffect(() => {
    if (!code || creds.seat || creds.watch || !room.state) return;
    if (watchingRef.current) return;
    watchingRef.current = true;
    room
      .watch(nick.trim() || '观众')
      .then(({ token, seat }) => {
        const base = readCreds(code);
        const next: Creds = seat
          ? { ...base, seat: token, watch: null }
          : { ...base, watch: token };
        writeCreds(code, next);
        setCreds(next);
      })
      .catch(() => {
        /* 登记失败不影响只看，下一轮会再试 */
      })
      .finally(() => {
        watchingRef.current = false;
      });
  }, [code, creds.seat, creds.watch, room, nick]);

  const enterRoom = (roomCode: string) => {
    // 分享码要跟着走：玩家分享房间就是复制地址栏，丢了它对方打开是「链接不完整」
    window.history.replaceState(null, '', roomQuery(roomCode, window.location.search));
    setStage({ mode: 'room', code: roomCode });
  };

  const createRoom = async () => {
    const name = nick.trim() || '房主';
    localStorage.setItem('suilan-name', name);
    setErr(null);
    setBusy(true);
    try {
      // 建房者默认在观战席：想下场就点空位，不想下场就只负责审批题库
      const out = await apiCreateRoom(name, devMode);
      const next: Creds = { seat: null, host: out.hostToken, watch: out.watchToken, dev: out.devToken };
      writeCreds(out.code, next);
      setCreds(next);
      enterRoom(out.code);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 进房只认房号：手动输入和大厅列表点「进入」走同一条路 */
  const enterByCode = (raw: string) => {
    const c = raw.trim();
    if (!ROOM_CODE.test(c)) return setErr('房号是 3 位数字');
    setErr(null);
    const saved = localStorage.getItem('suilan-name');
    if (saved) setNick(saved);
    // 不再把席位凭据强行抹掉。抹掉只是让本机「忘掉」，服务端仍然认为你坐在那儿，
    // 结果就是你既以旧名字留在席位里、又以新观众身份出现在观战名单——「两个自己」。
    // 现在交给服务端按令牌/设备号判定：还是你就还给你，不是你才当观众。
    setCreds(readCreds(c));
    enterRoom(c);
  };

  const joinRoom = () => enterByCode(joinCode);

  const claimSeat = useCallback(
    async (seat: SeatKey) => {
      if (!code) return;
      const finalName = nick.trim() || '选手';
      localStorage.setItem('suilan-name', finalName);
      setErr(null);
      try {
        const out = await apiClaimSeat(code, seat, finalName, creds);
        // 入座时服务端已收回观战令牌，本机也要清掉：留着它下次以「观众」身份回来时
        // 会拿一枚失效令牌去注册，服务端只好再发一个新身份——又是一条同名记录。
        const next: Creds = { seat: out.token, host: creds.host, watch: null, dev: creds.dev };
        writeCreds(code, next);
        setCreds(next);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [code, creds, nick]
  );

  /** 离席但不离开房间：位置空出来给观众接替，自己转为观战 */
  const leaveSeat = useCallback(async () => {
    if (!code || !room.mySeat) return;
    // 先等离席真正落库，再清本机凭据。否则下面「自动重新登记为观众」可能抢在离席之前
    // 到达服务端——那时设备还绑在席位上，服务端会把座位直接还给你，等于没离席。
    await room.send({ t: 'leave', seat: room.mySeat });
    // 观战令牌在入座时已被服务端收回，这里清掉让下面自动重新登记为观众
    const next: Creds = { seat: null, host: creds.host, watch: null, dev: creds.dev };
    writeCreds(code, next);
    setCreds(next);
  }, [code, room, creds.host, creds.dev]);

  /** 退出房间：先把席位让出来，再清本机凭据 */
  const exitRoom = useCallback(() => {
    // 只清本地令牌而不告诉服务端，席位会被占死（服务端还以为你坐在那儿），
    // 下次进房就会同时看到「席位里的你」和「观战名单里的你」。
    // 这里不必等它返回：清凭据后 stage 立刻变为落地页，不会触发自动重新登记，
    // 请求会在后台照常完成（只是 history.replaceState，页面没有真的跳走）。
    if (code && room.mySeat) void room.send({ t: 'leave', seat: room.mySeat });
    if (code) clearCreds(code);
    setCreds(EMPTY_CREDS);
    window.history.replaceState(null, '', landingHref(window.location.pathname, window.location.search));
    setStage({ mode: 'landing' });
  }, [code, room.mySeat, room.send]);

  const rename = useCallback(
    (name: string) => {
      localStorage.setItem('suilan-name', name);
      setNick(name);
      room.send({ t: 'rename', name });
    },
    [room]
  );

  const proposeFile = useCallback(
    async (file: File, passphrase: string) => {
      const text = await file.text();
      // 解密交给服务端做：本机不会落地明文词表
      await room.importBank(text, passphrase);
    },
    [room]
  );

  const proposeText = useCallback(
    async (name: string, words: WordEntry[]) => {
      await room.importText(name, words);
    },
    [room]
  );

  const proposeDemo = useCallback(async () => {
    await room.importDemo();
  }, [room]);

  if (stage.mode === 'landing') {
    return (
      <div className="landing">
        <div className="landing-card card stack" style={{ gap: 18 }}>
          <div className="row" style={{ gap: 14 }}>
            <div className="brand-mark">覆</div>
            <div>
              <h1 className="display" style={{ fontSize: 26 }}>随蓝射覆</h1>
              <p className="small muted">在线 2v2 · 无主持人 · 跨设备</p>
            </div>
            {devMode ? <span className="pill pill-blue">开发者模式</span> : null}
          </div>

          <p className="small muted">
            红方纵向连通，绿方横向连通。描述位选格后写下两个字，本方猜词位作答；开局前可勾选是否允许抢答。
          </p>

          <div className="stack" style={{ gap: 8 }}>
            <label className="tiny faint">你的昵称</label>
            <input
              className="input"
              placeholder="例如：阿蓝"
              maxLength={12}
              value={nick}
              onChange={(e) => setNick(e.target.value)}
            />
          </div>

          <div className="divider" />

          <button className="btn btn-primary btn-block" onClick={createRoom} disabled={busy}>
            {busy ? '正在建房…' : '创建房间'}
          </button>

          <div className="row">
            <input
              className="input mono"
              inputMode="numeric"
              placeholder="输入 3 位房号"
              value={joinCode}
              maxLength={3}
              onChange={(e) => {
                setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 3));
                setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') joinRoom();
              }}
            />
            <button className="btn" onClick={joinRoom}>
              进入
            </button>
          </div>

          {err ? <p className="small" style={{ color: 'var(--red)' }}>{err}</p> : null}

          <div className="divider" />

          <div className="stack" style={{ gap: 8 }}>
            <div className="row-between">
              <span className="small" style={{ fontWeight: 500 }}>
                房间大厅{rooms ? ` · ${rooms.length} 间` : ''}
              </span>
              {roomsErr ? <span className="tiny muted">列表读取失败</span> : null}
            </div>

            {rooms === null ? (
              <p className="small muted">正在读取房间…</p>
            ) : rooms.length === 0 ? (
              <p className="small muted">暂无房间 · 上面「创建房间」就是第一间</p>
            ) : (
              <div className="lobby-list">
                {rooms.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    className="lobby-row"
                    data-room={r.code}
                    onClick={() => enterByCode(r.code)}
                    title={`进入房间 ${r.code}`}
                  >
                    <span className="lobby-code mono">{r.code}</span>
                    <span className="lobby-main">
                      <span className="lobby-line">
                        <span
                          className={`pill ${
                            r.phase === 'lobby' ? 'pill-green' : r.phase === 'finished' ? '' : 'pill-blue'
                          }`}
                        >
                          {roomPhaseText(r)}
                        </span>
                        <span className="tiny muted">选手 {r.seated}/4</span>
                        {r.spectators ? <span className="tiny muted">观战 {r.spectators}</span> : null}
                      </span>
                      <span className="lobby-sub">
                        {r.bank ? (
                          <span className="lobby-bank" title={`题库 ${r.bank.name} · ${r.bank.count} 词`}>
                            {r.bank.name}
                          </span>
                        ) : (
                          <span className="tiny muted lobby-none">未导入题库</span>
                        )}
                        <span className="lobby-players">{r.players.filter(Boolean).join('、') || '还没有人入座'}</span>
                      </span>
                    </span>
                    <span className="lobby-go">进入</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="tiny muted">
            点开链接即可观战，点空位下场；四席准备后自动开局。题库由房间内任何人上传，房主同意后生效。
          </p>
        </div>

        {devFlash ? (
          <div className="toast">{devMode ? '开发者模式已开启' : '开发者模式已关闭'}</div>
        ) : null}
      </div>
    );
  }

  if (!room.state) {
    return (
      <div className="landing">
        <div className="card stack center" style={{ width: 'min(420px, 100%)', gap: 10 }}>
          <h2 className="display" style={{ fontSize: 20 }}>正在进入房间 {stage.code}</h2>
          <p className="small muted">{room.notice ?? '正在连接服务器…'}</p>
          <button className="btn" onClick={exitRoom}>返回</button>
        </div>
      </div>
    );
  }

  const displayName = room.mySeat
    ? room.state.players[room.mySeat] ?? nick
    : (room.spectator?.name ?? nick);

  return (
    <div className="shell-room-wrap">
      <Room
        state={room.state}
        reveal={room.reveal}
        mySeat={room.mySeat}
        spectatorId={room.spectator?.id ?? null}
        isHost={room.isHost}
        isReferee={room.isReferee}
        isDev={room.isDev}
        allCellWords={room.allCellWords}
        nick={displayName}
        clockOffset={room.clockOffset}
        onIntent={room.send}
        onSpecGuess={room.specGuess}
        onRename={rename}
        onClaimSeat={claimSeat}
        onLeaveSeat={leaveSeat}
        onExit={exitRoom}
        onProposeFile={proposeFile}
        onProposeText={proposeText}
        onProposeDemo={proposeDemo}
      />
      {!room.online ? <div className="toast">连接中断，正在重试…</div> : null}
      {room.notice && room.online ? <div className="toast">{room.notice}</div> : null}
      {err ? <div className="toast">{err}</div> : null}
    </div>
  );
}
