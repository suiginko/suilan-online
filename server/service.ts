import { createHash } from 'node:crypto';
import { advance, applyIntent, createRoom, prepareSecrets, withProposal } from '../src/engine';
import { MIN_BANK_WORDS, normalizeEntries } from '../src/bankText';
import {
  GameState,
  Intent,
  Phase,
  SEAT_ORDER,
  Secrets,
  SeatKey,
  SpecGuessResult,
  Spectator,
  WordEntry,
  roleOf,
} from '../src/types';
import { decryptBank } from '../src/bank';
import {
  DeviceRecord,
  SpectatorRecord,
  liveSpecIds,
  pruneSpectators,
  spectatorIdFor,
} from '../src/identity';
import { nextRoomCode, randomToken, seal, signState, unseal, verifyState } from './crypto';
import {
  casUpdate,
  insertRoom,
  listLiveRooms,
  listRoomCodes,
  loadRoom,
  reclaimExpiredRoom,
  touchRoom,
} from './store';
import { abandonOf, HEARTBEAT_MS } from '../src/lobby';

/** 题面：描述位与开发者模式可见，且只有单词本身 */
export interface Reveal {
  word: string;
}

interface ProposalRecord {
  words: WordEntry[];
  name: string;
  count: number;
  fingerprint: string;
  by: string;
}

interface HistorySnapshot {
  state: GameState;
  secrets: Secrets | null;
  desc?: string;
  at: number;
}

interface VaultData {
  secrets: Secrets | null;
  /** 待审批的题库：词表只存在这里，客户端永远拿不到 */
  proposals?: Record<string, ProposalRecord>;
  seatTokens: Partial<Record<SeatKey, string>>;
  hostToken: string;
  /** 开发者模式凭证：建房时若带 dev 才下发，房间里没有它就没有开发者权限 */
  devToken?: string;
  /** 观众令牌 → 观众记录（老房间没有这个字段） */
  spectators?: Record<string, SpectatorRecord>;
  /**
   * 设备号 → 本房间里的观众身份。
   *
   * 令牌会丢（清缓存 / 点过「返回」/ 换标签页 / 隐私窗口），设备号不会。
   * 登记观众时先按令牌认，认不到再按设备号认回同一个 specId，
   * 这样同一个人重复进房间不会在观战名单里留下第二条同名记录。
   */
  devices?: Record<string, DeviceRecord>;
  /** 席位 → 占着它的设备号：席位令牌丢了也能认回座位，且离席时一并清掉 */
  seatDevices?: Partial<Record<SeatKey, string>>;
  /** 房主身份绑定的设备号：房主清掉凭据后回到同一房间仍是房主 */
  hostDevice?: string;
  /** 裁判历史快照栈（撤销） */
  undoStack?: HistorySnapshot[];
  /** 裁判历史快照栈（恢复） */
  redoStack?: HistorySnapshot[];
}

export interface Snapshot {
  state: GameState;
  reveal: Reveal | null;
  seat: SeatKey | null;
  /** 本机在这间房里的观战身份，坐进席位后为 null */
  spectator: Spectator | null;
  isSpectator: boolean;
  isHost: boolean;
  /** 是否是裁判 */
  isReferee: boolean;
  isDev: boolean;
  /** 裁判/开发者下发全局题面（透视用） */
  allCellWords?: Record<string, WordEntry> | null;
  /**
   * 观众刚提交的那次猜词的结果。只回给发起请求的这台设备，
   * 不进公开快照——「谁猜错了什么」本身就是答案的线索。
   */
  guessResult?: SpecGuessResult;
  serverNow: number;
}

export class RoomError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 同一个房号的写操作串行化，避免进程内并发把 ver 撞飞 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(code) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    code,
    next.catch(() => undefined)
  );
  return next as Promise<T>;
}

interface Loaded {
  state: GameState;
  vault: VaultData;
  ver: number;
  /** 库里 `updated_at`：最后一次有人在线（心跳会刷新它），大厅判废就看这个 */
  updatedAt: number;
}

async function load(code: string): Promise<Loaded> {
  const row = await loadRoom(code);
  if (!row) throw new RoomError('房间不存在或已过期', 404);
  if (!verifyState(row.code, row.ver, row.state, row.sig)) {
    throw new RoomError('房间数据校验失败，已被外部改写', 409);
  }
  let vault: VaultData;
  try {
    vault = unseal<VaultData>(row.vault);
  } catch {
    throw new RoomError('房间密钥数据损坏', 500);
  }
  return {
    state: row.state as GameState,
    vault,
    ver: row.ver,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

async function save(loaded: Loaded, state: GameState, vault: VaultData, opts: { markDead?: boolean } = {}): Promise<boolean> {
  const nextVer = loaded.ver + 1;
  const ok = await casUpdate(
    loaded.state.roomCode,
    loaded.ver,
    {
      state,
      sig: signState(loaded.state.roomCode, nextVer, state),
      vault: seal(vault),
    },
    { keepAlive: !opts.markDead }
  );
  if (ok) {
    loaded.ver = nextVer;
    loaded.state = state;
    loaded.vault = vault;
    // 与云端保持一致：这次写就是「刚刚还有人在」，否则刚存完就被判废
    loaded.updatedAt = opts.markDead ? 0 : Date.now();
  }
  return ok;
}

function seatOfToken(vault: VaultData, token: string | null | undefined): SeatKey | null {
  if (!token) return null;
  for (const [seat, t] of Object.entries(vault.seatTokens)) {
    if (t && t === token) return seat as SeatKey;
  }
  return null;
}

function specOfToken(vault: VaultData, token: string | null | undefined): SpectatorRecord | null {
  if (!token) return null;
  return vault.spectators?.[token] ?? null;
}

/** 席位属于哪台设备：入座时写下，离席时清掉。用来在席位令牌丢失后认回座位 */
function seatOfDevice(vault: VaultData, deviceId: string | null | undefined): SeatKey | null {
  if (!deviceId) return null;
  for (const [seat, dev] of Object.entries(vault.seatDevices ?? {})) {
    if (dev === deviceId && vault.seatTokens[seat as SeatKey]) return seat as SeatKey;
  }
  return null;
}

/** 先按令牌认，认不到再按设备号认回同一身份 */
function specOf(
  vault: VaultData,
  watchToken: string | null | undefined,
  deviceId: string | null | undefined
): SpectatorRecord | null {
  const byToken = specOfToken(vault, watchToken);
  if (byToken) return byToken;
  if (!deviceId) return null;
  const dev = (vault.devices ?? {})[deviceId];
  return dev ? { id: dev.specId, name: dev.name } : null;
}

interface Identity {
  seat: SeatKey | null;
  spec: SpectatorRecord | null;
  isHost: boolean;
  isReferee: boolean;
  isDev: boolean;
  /** 展示用昵称 */
  name: string | null;
}

function identityOf(
  loaded: Loaded,
  token: string | null,
  hostToken: string | null,
  watchToken: string | null,
  devToken: string | null,
  deviceId: string | null = null
): Identity {
  // 席位：令牌优先，令牌丢了（清过缓存/换过标签页）按设备号认回自己的座位
  const seat = seatOfToken(loaded.vault, token) ?? seatOfDevice(loaded.vault, deviceId);
  const spec = seat ? null : specOf(loaded.vault, watchToken, deviceId);
  const isHost =
    (!!hostToken && hostToken === loaded.vault.hostToken) ||
    (!!deviceId && loaded.vault.hostDevice === deviceId);
  const isDev = !!devToken && !!loaded.vault.devToken && devToken === loaded.vault.devToken;
  const isReferee = !!(spec && (loaded.state.refereeIds ?? []).includes(spec.id));
  const name = seat ? loaded.state.players[seat] : (spec?.name ?? null);
  return { seat, spec, isHost, isReferee, isDev, name };
}

function revealOf(
  state: GameState,
  secrets: Secrets | null,
  seat: SeatKey | null,
  isDev: boolean
): Reveal | null {
  if (!secrets || !state.currentCellId) return null;
  if (state.phase === 'lobby' || state.phase === 'finished') return null;
  // 开发者模式用来测试：任何阶段都能看到当前格答案
  if (!isDev) {
    if (!seat) return null;
    if (roleOf(seat) !== 'DESC') return null;
    if (state.phase !== 'describe' && state.phase !== 'guess' && state.phase !== 'steal') return null;
  }
  const entry = secrets.cellWords[state.currentCellId];
  return entry ? { word: entry.word } : null;
}

function snapshotOf(
  loaded: Loaded,
  id: Identity,
  watchToken: string | null = null
): Snapshot {
  const isRefOrDev = id.isReferee || id.isDev;
  return {
    state: loaded.state,
    reveal: revealOf(loaded.state, loaded.vault.secrets, id.seat, id.isDev),
    seat: id.seat,
    spectator: id.spec ? { id: id.spec.id, name: id.spec.name, isReferee: id.isReferee } : null,
    isSpectator: !!id.spec,
    isHost: id.isHost,
    isReferee: id.isReferee,
    isDev: id.isDev,
    allCellWords: isRefOrDev ? (loaded.vault.secrets?.cellWords ?? null) : null,
    serverNow: Date.now(),
  };
}

/**
 * 大厅里的一行房间：只放「决定进不进」的信息，不放棋盘 / 历史 / 日志。
 * 这些都是公开快照里本来就能看到的东西，不涉及答案与令牌。
 */
export interface RoomSummary {
  code: string;
  phase: Phase;
  round: number;
  /** 四席玩家名（SEAT_ORDER 顺序），null = 空位 */
  players: (string | null)[];
  seated: number;
  spectators: number;
  bank: { name: string; count: number } | null;
  updatedAt: number;
}

/** 排序权重：还开着的大厅房 < 对局中 < 已结束 */
const PHASE_RANK: Record<string, number> = { lobby: 0, finished: 2 };

/**
 * 房间大厅：落地页靠它「找到房间」，不再需要别人报房号。
 *
 * 读的是公开快照（`state`），与玩家进房后看到的信息同级，所以不需要任何令牌；
 * 已解散 / 超过 8 小时 TTL 的房间在 `listLiveRooms` 里已被过滤掉，不会列出「点进去 404」的死房。
 */
export async function listRoomSummaries(limit = 40): Promise<RoomSummary[]> {
  const rows = await listLiveRooms();
  const rooms: RoomSummary[] = [];
  for (const row of rows) {
    const s = row.state as Partial<GameState> | null;
    if (!s || !s.phase) continue;
    const players = SEAT_ORDER.map((seat) => s.players?.[seat] ?? null);
    rooms.push({
      code: row.code,
      phase: s.phase,
      round: s.round ?? 0,
      players,
      seated: players.filter(Boolean).length,
      spectators: s.spectators?.length ?? 0,
      bank: s.bank ? { name: s.bank.name, count: s.bank.count } : null,
      updatedAt: row.updatedAt,
    });
  }
  // 排序：大厅房排前面（那是能进去坐下开局的房间），已结束排最后；
  // 同组里人多的在前——空房里往往只剩一个没关页面的房主，没必要占住大厅首屏。
  rooms.sort(
    (a, b) =>
      (PHASE_RANK[a.phase] ?? 1) - (PHASE_RANK[b.phase] ?? 1) ||
      b.seated - a.seated ||
      b.updatedAt - a.updatedAt
  );
  // 顺手清理（不 await）：这一轮可能还会把废房列出来，5 秒后的下一次轮询就干净了。
  // 平台没有定时器，只能把「清理」挂在真实请求上；大厅是唯一一个「总会有人来」的入口。
  void sweepAbandoned(rows).catch(() => undefined);
  return rooms.slice(0, limit);
}

/**
 * 大厅的「适时清理」：有人来看大厅时，把已经没人管的房间标记成解散（房号随即释放）。
 *
 * 三条约束：
 *   ① **不阻塞列表**——fire-and-forget，不然刷新大厅要等几次云库往返；
 *   ② **节流 + 限量**——每清一间要「读整间房 + 重签写回」，不能让人刷大厅变成写库风暴；
 *      60 秒最多一轮、一轮最多 5 间，最坏情况下 40 间废房约 8 分钟清完；
 *   ③ **判废看「最后一次有人在线」**（`abandonOf`），不是「最后一次状态变化」——
 *      前者靠快照心跳续期，真人建完房静静等人不会被误清。
 */
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_MAX_PER_ROUND = 5;
let lastSweepAt = 0;

async function sweepAbandoned(
  rows: { code: string; state: unknown; updatedAt: number }[]
): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  const due: string[] = [];
  for (const row of rows) {
    if (due.length >= SWEEP_MAX_PER_ROUND) break;
    if (abandonOf(row.state as Partial<GameState> | null, row.updatedAt, now)) due.push(row.code);
  }
  if (!due.length) return;

  for (const code of due) {
    try {
      await withLock(code, async () => {
        const loaded = await load(code);
        // 拿到锁后重新判定：从上面列出来到这会儿，可能刚好有人推门进来了（心跳已续期）
        const reason = abandonOf(loaded.state, loaded.updatedAt, Date.now());
        if (!reason) return;
        // markDead：写 closedAt 并把 updated_at 置成 1970——既从大厅消失，也让房号立刻可回收。
        // 房间连同它的 vault 会在 10 分钟后被 store 真正丢掉（见 CLOSED_KEEP_MS）。
        await save(loaded, { ...loaded.state, closedAt: Date.now() }, loaded.vault, { markDead: true });
        console.log(`[大厅] 清理废弃房间 ${code}（${reason}）`);
      });
    } catch {
      // 房刚被别人解散（load 404）、锁竞争：都不该影响大厅返回，跳过即可
    }
  }
}

/**
 * 建房：房主默认是观众（可以随时坐进席位，也可以一直观战并审批题库）。
 * 只有带 dev 建房才会下发开发者凭证。
 *
 * 房号从 000 开始顺序分配：每次拿当前最小的空号（死房不占号）。
 * 撞号时分两种情况——撞上死房（过期/已解散）就把新房间原地写进那一行，回收该号；
 * 撞上并发创建的活房间就顺延下一个号。
 */
export async function createNewRoom(
  name: string,
  dev = false,
  deviceId: string | null = null
): Promise<{ code: string; hostToken: string; watchToken: string; devToken: string | null; snapshot: Snapshot }> {
  const trimmed = name.trim().slice(0, 12) || '房主';
  const used = new Set(await listRoomCodes());
  // 房号只有 1000 个；每一轮要么成功、要么回收一个死房号、要么顺延一个号，都会实质推进
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = nextRoomCode(used);
    if (!code) break;
    const hostToken = randomToken();
    const watchToken = randomToken();
    const devToken = dev ? randomToken() : null;
    const specId = randomToken().slice(0, 10);
    const base = createRoom(code);
    const state: GameState = {
      ...base,
      spectators: [{ id: specId, name: trimmed, isReferee: false }],
      seq: 1,
    };
    const vault: VaultData = {
      secrets: null,
      proposals: {},
      seatTokens: {},
      hostToken,
      devToken: devToken ?? undefined,
      spectators: { [watchToken]: { id: specId, name: trimmed } },
      // 房主身份跟设备走：清了浏览器凭据再打开同一房号，仍然是房主
      hostDevice: deviceId ?? undefined,
      devices: deviceId ? { [deviceId]: { specId, name: trimmed } } : undefined,
    };
    const fresh = {
      code,
      ver: 0,
      state,
      sig: signState(code, 0, state),
      vault: seal(vault),
    };
    const out = {
      code,
      hostToken,
      watchToken,
      devToken,
      snapshot: {
        state,
        reveal: null,
        seat: null,
        spectator: { id: specId, name: trimmed, isReferee: false },
        isSpectator: true,
        isHost: true,
        isReferee: false,
        isDev: dev,
        allCellWords: null,
        serverNow: Date.now(),
      },
    };
    try {
      await insertRoom(fresh);
      return out;
    } catch (e) {
      if (!(e as Error).message.includes('房号冲突')) throw e;
      // 这一行还占着主键：是死房就原地覆盖（等价于删旧建新，且不需要 DELETE 权限）；
      // 是并发创建的活房间就顺延
      const reclaimed = await reclaimExpiredRoom(code, fresh).catch(() => false);
      if (reclaimed) return out;
      used.add(code);
    }
  }
  throw new RoomError('房号已用尽，请稍后重试', 503);
}

/**
 * 观众注册：同一台设备重复进来只会刷新昵称，不会重复占位。
 *
 * 认人的两把钥匙见 `src/identity.ts`：先看令牌，令牌丢了再按设备号认回同一个 specId。
 * 设备已经坐在席位上时直接返回座位身份——否则同一个人会同时出现在「选手」和「观战」两处。
 */
export async function registerSpectator(
  code: string,
  name: string,
  existingToken: string | null,
  deviceId: string | null = null,
  hostToken: string | null = null
): Promise<{ token: string; snapshot: Snapshot }> {
  return withLock(code, async () => {
    const loaded = await load(code);
    const clean = name.trim().slice(0, 12) || '观众';

    // ① 这台设备本来就坐在席位上（席位令牌可能清掉了，设备号还在）。
    //    把座位和真令牌一并还给它，不登记观战身份。
    const seated = seatOfDevice(loaded.vault, deviceId);
    if (seated) {
      const seatToken = loaded.vault.seatTokens[seated] as string;
      const identity = identityOf(loaded, seatToken, hostToken, null, null, deviceId);
      return { token: seatToken, snapshot: snapshotOf(loaded, identity) };
    }

    const tokens = { ...(loaded.vault.spectators ?? {}) };
    const devices = { ...(loaded.vault.devices ?? {}) };

    // ② 先按令牌认，认不到再按设备号认回同一个人；都没命中才是新观众
    const knownId = spectatorIdFor(tokens, devices, existingToken, deviceId);
    const id = knownId ?? randomToken().slice(0, 10);

    // ③ 一个身份只保留一枚有效令牌：旧版本每次清凭据都会多发一枚，
    //    这里把同一个 id 的历史令牌一次性收敛掉
    const keep = existingToken && tokens[existingToken]?.id === id ? existingToken : null;
    let collapsed = false;
    for (const t of Object.keys(tokens)) {
      if (tokens[t].id === id && t !== keep) {
        delete tokens[t];
        collapsed = true;
      }
    }
    const token = keep ?? randomToken();
    const prevName = tokens[token]?.name;
    tokens[token] = { id, name: clean };
    if (deviceId) devices[deviceId] = { specId: id, name: clean };
    loaded.vault.spectators = tokens;
    if (deviceId) loaded.vault.devices = devices;

    // ④ 幂等：身份与昵称都没变、名单里也在，不必写库
    const listed = loaded.state.spectators.some((s) => s.id === id && s.name === clean);
    if (knownId && prevName === clean && !collapsed && listed) {
      const identity = identityOf(loaded, null, hostToken, token, null, deviceId);
      return { token, snapshot: snapshotOf(loaded, identity, token) };
    }

    const now = Date.now();
    const res = applyIntent(loaded.state, loaded.vault.secrets, { t: 'watch', id, name: clean }, now);
    if (res.error) throw new RoomError(res.error, 409);
    const next = advance(res.state, res.secrets, now);
    // ⑤ 顺手扫掉幽灵条目：旧版本清凭据后留下的同名记录，在这一轮登记里一次性收拾干净
    next.state.spectators = pruneSpectators(next.state.spectators, liveSpecIds(tokens));
    loaded.vault.secrets = next.secrets;
    const ok = await save(loaded, next.state, loaded.vault);
    if (!ok) throw new RoomError('房间正忙，请重试', 409);

    const identity = identityOf(loaded, null, hostToken, token, null, deviceId);
    return { token, snapshot: snapshotOf(loaded, identity, token) };
  });
}

export async function claimSeat(
  code: string,
  seat: SeatKey,
  name: string,
  existingToken: string | null,
  hostToken: string | null,
  watchToken: string | null,
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<{ token: string; snapshot: Snapshot }> {
  return withLock(code, async () => {
    const loaded = await load(code);
    const now = Date.now();
    const me = identityOf(loaded, existingToken, hostToken, watchToken, devToken, deviceId);

    if (me.seat === seat) {
      // 已经在这一席（可能是靠设备号认回来的）：把真令牌还回去，别再发新的
      const token = existingToken ?? (loaded.vault.seatTokens[seat] as string) ?? '';
      return { token, snapshot: snapshotOf(loaded, me) };
    }

    // 同一台设备换席：先释放自己原来的座位，再占新座（对局中不允许换席，避免破坏正在进行的行动）
    if (me.seat && (existingToken || deviceId)) {
      if (loaded.state.phase !== 'lobby') throw new RoomError('对局已开始，不能换席', 409);
      loaded.state = {
        ...loaded.state,
        players: { ...loaded.state.players, [me.seat]: null },
        ready: { ...loaded.state.ready, [me.seat]: false },
      };
      const tokens = { ...loaded.vault.seatTokens };
      delete tokens[me.seat];
      loaded.vault.seatTokens = tokens;
      const seatDevices = { ...(loaded.vault.seatDevices ?? {}) };
      delete seatDevices[me.seat];
      loaded.vault.seatDevices = seatDevices;
    }

    const occupant = loaded.state.players[seat];
    const seatToken = loaded.vault.seatTokens[seat];
    if (occupant && seatToken) {
      throw new RoomError('该席位已被其他设备占用', 409);
    }

    const token = randomToken();
    loaded.vault.seatTokens = { ...loaded.vault.seatTokens, [seat]: token };

    // 观众坐进席位：把观战身份收回，避免同一个人既在席又在观战名单里
    const spec = specOf(loaded.vault, watchToken, deviceId);
    const res = applyIntent(
      loaded.state,
      loaded.vault.secrets,
      { t: 'join', seat, name, specId: spec?.id },
      now
    );
    if (res.error) throw new RoomError(res.error, 409);

    if (spec && watchToken) {
      const map = { ...(loaded.vault.spectators ?? {}) };
      delete map[watchToken];
      loaded.vault.spectators = map;
    }

    // 席位记住是哪台设备的：令牌丢了也能认回座位；离席时再把同一个观众身份还回来
    if (deviceId) {
      const devices = { ...(loaded.vault.devices ?? {}) };
      const specId = spec?.id ?? devices[deviceId]?.specId ?? randomToken().slice(0, 10);
      const cleanName = name.trim().slice(0, 12) || '选手';
      devices[deviceId] = { specId, name: cleanName };
      loaded.vault.devices = devices;
      loaded.vault.seatDevices = { ...(loaded.vault.seatDevices ?? {}), [seat]: deviceId };
    }

    const next = advance(res.state, res.secrets, now);
    loaded.vault.secrets = next.secrets;
    const ok = await save(loaded, next.state, loaded.vault);
    if (!ok) throw new RoomError('房间正忙，请重试', 409);

    const after = identityOf(loaded, token, hostToken, null, devToken, deviceId);
    return { token, snapshot: snapshotOf(loaded, after) };
  });
}

/** 只有席位/观众/房主/裁判/开发者才能做的通用操作 */
const ANY_PARTICIPANT: Intent['t'][] = ['rename'];
/** 必须落在某个席位上（开发者可以代打） */
const NEED_SEAT: Intent['t'][] = ['select', 'describe', 'guess', 'steal', 'lock', 'swap', 'judge', 'undo', 'undoAgree', 'reject', 'skip', 'ready', 'leave', 'restart'];
/** 开局前的房间规则（抢答开关）：选手、房主、裁判、开发者都能改 */
const RULE_SET: Intent['t'][] = ['setSteal'];
/** 房主或裁判可审批题库 */
const REFEREE_OR_HOST: Intent['t'][] = ['approveBank', 'rejectBank'];
/** 裁判专属操作 */
const REFEREE_ONLY: Intent['t'][] = ['refereeEditCell', 'refereeSwapCells', 'refereeUndo', 'refereeRedo'];
/** 选手、裁判、房主均可设置裁判 */
const SET_REFEREE: Intent['t'][] = ['setReferee'];
/** 房主（或开发者）解散房间：解散后房号立即回收 */
const DISSOLVE: Intent['t'][] = ['close'];
/**
 * 只有观战身份（不在任何席位上）才能做的操作。
 * 观众猜词按观战令牌认人——选手没有 spec，也就没有这个入口。
 */
const SPEC_ONLY: Intent['t'][] = ['specGuess'];
/** 开发者专属 */
const DEV_ONLY: Intent['t'][] = ['devSetup', 'devReadyAll', 'start', 'join'];

export async function applyPlayerIntent(
  code: string,
  token: string | null,
  hostToken: string | null,
  intent: Intent,
  watchToken: string | null = null,
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<Snapshot> {
  return withLock(code, async () => {
    const loaded = await load(code);
    const me = identityOf(loaded, token, hostToken, watchToken, devToken, deviceId);
    const t = intent.t;
    const participant = !!(me.seat || me.spec || me.isHost || me.isDev);

    if (DEV_ONLY.includes(t)) {
      if (!me.isDev) throw new RoomError('该操作只在开发者模式下可用', 403);
    } else if (REFEREE_ONLY.includes(t)) {
      if (!me.isReferee && !me.isDev) throw new RoomError('只有裁判可以执行该操作', 403);
    } else if (SET_REFEREE.includes(t)) {
      if (!me.seat && !me.isHost && !me.isReferee && !me.isDev) {
        throw new RoomError('只有选手、房主或裁判可以设置裁判', 403);
      }
    } else if (REFEREE_OR_HOST.includes(t)) {
      if (!me.isHost && !me.isReferee && !me.isDev) throw new RoomError('只有房主或裁判可以审批题库', 403);
    } else if (RULE_SET.includes(t)) {
      if (!me.seat && !me.isHost && !me.isReferee && !me.isDev) {
        throw new RoomError('只有选手、房主或裁判可以修改规则', 403);
      }
    } else if (DISSOLVE.includes(t)) {
      if (!me.isHost && !me.isDev) throw new RoomError('只有房主可以解散房间', 403);
    } else if (SPEC_ONLY.includes(t)) {
      if (!me.spec) {
        throw new RoomError(
          me.seat ? '你在席位上，用作答框提交' : '观战身份已失效，请刷新页面后重试',
          403
        );
      }
    } else if (NEED_SEAT.includes(t)) {
      if (!me.seat && !me.isDev) {
        throw new RoomError(
          me.spec ? '你现在是观众，先接替一个空席位才能操作' : '席位凭证无效，请重新入座',
          401
        );
      }
    } else if (t === 'pause' || t === 'resume') {
      // 只有选手、房主、裁判、开发者可以暂停/继续；普通观众不行
      if (!me.seat && !me.isHost && !me.isReferee && !me.isDev) {
        throw new RoomError('只有选手或裁判可以暂停对局', 403);
      }
    } else if (ANY_PARTICIPANT.includes(t)) {
      if (!participant) throw new RoomError('请先进入房间', 401);
    }

    const now = Date.now();

    // 裁判撤销上一步操作
    if (t === 'refereeUndo') {
      const undoStack = loaded.vault.undoStack ?? [];
      if (undoStack.length === 0) throw new RoomError('没有可撤销的历史步骤', 400);
      const prev = undoStack.pop()!;
      const redoStack = loaded.vault.redoStack ?? [];
      redoStack.push({
        state: JSON.parse(JSON.stringify(loaded.state)),
        secrets: loaded.vault.secrets ? JSON.parse(JSON.stringify(loaded.vault.secrets)) : null,
        desc: '当前状态',
        at: now,
      });
      loaded.vault.undoStack = undoStack;
      loaded.vault.redoStack = redoStack;
      loaded.state = prev.state;
      loaded.vault.secrets = prev.secrets;
      // 撤销后为了安全防止立即超时，若在对决中则自动暂停
      if (loaded.state.phase !== 'lobby' && loaded.state.phase !== 'finished') {
        loaded.state.pausedAt = now;
        loaded.state.pausedBy = me.name ?? '裁判';
      }
      loaded.state.canUndo = undoStack.length > 0;
      loaded.state.canRedo = redoStack.length > 0;
      const ok = await save(loaded, loaded.state, loaded.vault);
      if (!ok) throw new RoomError('房间正忙，请重试', 409);
      return snapshotOf(loaded, me, watchToken);
    }

    // 裁判恢复撤销的操作
    if (t === 'refereeRedo') {
      const redoStack = loaded.vault.redoStack ?? [];
      if (redoStack.length === 0) throw new RoomError('没有可恢复的历史步骤', 400);
      const nextFrame = redoStack.pop()!;
      const undoStack = loaded.vault.undoStack ?? [];
      undoStack.push({
        state: JSON.parse(JSON.stringify(loaded.state)),
        secrets: loaded.vault.secrets ? JSON.parse(JSON.stringify(loaded.vault.secrets)) : null,
        desc: '恢复前状态',
        at: now,
      });
      loaded.vault.undoStack = undoStack;
      loaded.vault.redoStack = redoStack;
      loaded.state = nextFrame.state;
      loaded.vault.secrets = nextFrame.secrets;
      if (loaded.state.phase !== 'lobby' && loaded.state.phase !== 'finished') {
        loaded.state.pausedAt = now;
        loaded.state.pausedBy = me.name ?? '裁判';
      }
      loaded.state.canUndo = undoStack.length > 0;
      loaded.state.canRedo = redoStack.length > 0;
      const ok = await save(loaded, loaded.state, loaded.vault);
      if (!ok) throw new RoomError('房间正忙，请重试', 409);
      return snapshotOf(loaded, me, watchToken);
    }

    // 记录可撤销的历史快照
    const SNAPSHOT_INTENTS: Intent['t'][] = [
      'select', 'describe', 'guess', 'skip', 'steal', 'lock', 'swap',
      'refereeEditCell', 'refereeSwapCells', 'approveBank'
    ];
    const shouldSnapshot = SNAPSHOT_INTENTS.includes(t);
    const preSnapshot: HistorySnapshot | null = shouldSnapshot
      ? {
          state: JSON.parse(JSON.stringify(loaded.state)),
          secrets: loaded.vault.secrets ? JSON.parse(JSON.stringify(loaded.vault.secrets)) : null,
          desc: t,
          at: now,
        }
      : null;

    const advanced = advance(loaded.state, loaded.vault.secrets, now);
    loaded.state = advanced.state;
    loaded.vault.secrets = advanced.secrets;

    // 一律用凭证解析出的席位覆盖客户端自报的席位，杜绝冒名；开发者模式例外（要能代打四席）
    let withSeat: Intent = intent;
    if (NEED_SEAT.includes(t) && me.seat && !me.isDev) {
      withSeat = { ...intent, seat: me.seat } as Intent;
    }
    if (t === 'rename') {
      withSeat = {
        ...intent,
        seat: me.seat ?? undefined,
        specId: me.seat ? undefined : me.spec?.id,
      } as Intent;
    }
    if ((t === 'pause' || t === 'resume') && !intent.by) {
      withSeat = { ...intent, by: me.name ?? (me.isReferee ? '裁判' : '选手') } as Intent;
    }
    if (t === 'join') {
      withSeat = { ...intent, force: me.isDev } as Intent;
    }
    // 观众猜词：身份按观战令牌覆盖，客户端自报的 id / 昵称一律不作数
    if (t === 'specGuess' && me.spec) {
      withSeat = { ...intent, id: me.spec.id, name: me.spec.name } as Intent;
    }

    // 离席时把自己的令牌一并作废，否则该席位会永久占死；设备绑定也要一起解除，
    // 否则同一台设备下次进房会被当成「还坐在席位上」，永远离不了席。
    if (withSeat.t === 'leave' && me.seat) {
      const tokens = { ...loaded.vault.seatTokens };
      delete tokens[me.seat];
      loaded.vault.seatTokens = tokens;
      const seatDevices = { ...(loaded.vault.seatDevices ?? {}) };
      delete seatDevices[me.seat];
      loaded.vault.seatDevices = seatDevices;
    }

    const res = applyIntent(loaded.state, loaded.vault.secrets, withSeat, now);
    if (res.error) {
      // 即使操作被拒，也可能已经把到期窗口推进了，需要落库
      if (advanced.state !== loaded.state) {
        await save(loaded, loaded.state, loaded.vault);
      }
      throw new RoomError(res.error, 409);
    }

    // 题库审批通过：把 vault 里的词表激活成当前局题库
    let advanceSecrets = res.secrets;
    if (withSeat.t === 'approveBank') {
      const proposal = loaded.vault.proposals?.[withSeat.id];
      if (!proposal) throw new RoomError('这份题库提案已失效，请重新上传', 409);
      if (loaded.state.phase === 'lobby') {
        loaded.vault.secrets = prepareSecrets(proposal.words);
        advanceSecrets = loaded.vault.secrets;
      } else {
        // 对局中途更换题库：
        const newSecrets = prepareSecrets(proposal.words);
        const pool = [...newSecrets.all];
        const usedWords = new Set(loaded.state.board.filter(c => c.owner).map(c => c.revealedWord).filter(Boolean));
        const available = pool.filter(w => !usedWords.has(w.word));
        let availIdx = 0;
        for (const cell of loaded.state.board) {
          if (!cell.owner && availIdx < available.length) {
            const nextWord = available[availIdx++];
            newSecrets.cellWords[cell.id] = nextWord;
            cell.code = `${nextWord.word[0]?.toUpperCase() || '?'}${nextWord.word.length}`;
            cell.firstLetter = cell.code[0];
            cell.charCount = nextWord.word.length;
          }
        }
        newSecrets.pool = available.slice(availIdx);
        // 已经摆上盘的也算「用过了」：之后重开不该再发这些词
        newSecrets.used = available.slice(0, availIdx).map((w) => w.word);
        loaded.vault.secrets = newSecrets;
        advanceSecrets = newSecrets;
        loaded.state.bank = {
          name: proposal.name,
          count: proposal.count,
          fingerprint: proposal.fingerprint,
        };
      }
      const rest = { ...(loaded.vault.proposals ?? {}) };
      delete rest[withSeat.id];
      loaded.vault.proposals = rest;
    }
    if (withSeat.t === 'rejectBank') {
      const rest = { ...(loaded.vault.proposals ?? {}) };
      delete rest[withSeat.id];
      loaded.vault.proposals = rest;
    }
    // 观众改名：vault 里的记录也要同步，否则下次快照会退回旧昵称
    if (withSeat.t === 'rename' && !me.seat && me.spec) {
      const clean = withSeat.name.trim().slice(0, 12);
      const map = { ...(loaded.vault.spectators ?? {}) };
      let touched = false;
      for (const [t2, rec] of Object.entries(map)) {
        if (rec.id === me.spec.id) {
          map[t2] = { ...rec, name: clean };
          touched = true;
        }
      }
      if (touched) loaded.vault.spectators = map;
      // 设备记录里的昵称也要跟上，否则下次靠设备号认回来时还是旧名字
      const devices = { ...(loaded.vault.devices ?? {}) };
      let devTouched = false;
      for (const [dev, rec] of Object.entries(devices)) {
        if (rec.specId === me.spec.id) {
          devices[dev] = { ...rec, name: clean };
          devTouched = true;
        }
      }
      if (devTouched) loaded.vault.devices = devices;
    }

    const next = advance(res.state, advanceSecrets, now);
    loaded.vault.secrets = next.secrets;

    // 意图执行成功，将 preSnapshot 压入 undoStack 并清空 redoStack
    if (preSnapshot) {
      const undoStack = loaded.vault.undoStack ?? [];
      undoStack.push(preSnapshot);
      if (undoStack.length > 30) undoStack.shift();
      loaded.vault.undoStack = undoStack;
      loaded.vault.redoStack = [];
    }
    next.state.canUndo = (loaded.vault.undoStack?.length ?? 0) > 0;
    next.state.canRedo = (loaded.vault.redoStack?.length ?? 0) > 0;

    // 解散：把行置成「已死」，房号立刻回到可分配池（回收不依赖 DELETE 权限）
    const ok = await save(loaded, next.state, loaded.vault, { markDead: withSeat.t === 'close' });
    if (!ok) throw new RoomError('房间正忙，请重试', 409);

    // 重新解析身份（可能刚改过昵称、设为裁判或离席）
    const after = identityOf(loaded, token, hostToken, watchToken, devToken, deviceId);
    const snap = snapshotOf(loaded, after);
    // 观众猜词的私下回执：只挂在这一次响应上，不写进 state——公开快照是全房间共享的
    if (withSeat.t === 'specGuess') {
      snap.guessResult = {
        cell: res.state.board.find((c) => c.id === res.state.currentCellId)?.code ?? '',
        hit: !!res.guessHit,
      };
    }
    return snap;
  });
}

/**
 * 上传题库提案：房间里任何人都可以传（选手、观众、房主、裁判）。
 * 解密拿到词表后只存进 vault，等房主或裁判点同意才生效。
 */
async function proposeBank(
  code: string,
  words: WordEntry[],
  info: { name: string; count: number; fingerprint: string },
  token: string | null,
  hostToken: string | null,
  watchToken: string | null,
  devToken: string | null,
  deviceId: string | null = null
): Promise<Snapshot> {
  return withLock(code, async () => {
    const loaded = await load(code);
    const me = identityOf(loaded, token, hostToken, watchToken, devToken, deviceId);
    if (!me.seat && !me.spec && !me.isHost && !me.isDev) {
      throw new RoomError('请先进入房间', 401);
    }
    if (loaded.state.phase !== 'lobby' && !me.isReferee && !me.isDev) {
      throw new RoomError('对局已开始，不能再上传题库', 409);
    }

    const id = randomToken().slice(0, 12);
    const proposals = { ...(loaded.vault.proposals ?? {}) };
    proposals[id] = { words, name: info.name, count: info.count, fingerprint: info.fingerprint, by: me.name ?? '匿名' };

    // 只保留最近 6 份，免得 vault 无限膨胀
    const ids = Object.keys(proposals);
    if (ids.length > 6) {
      for (const old of ids.slice(0, ids.length - 6)) delete proposals[old];
    }
    loaded.vault.proposals = proposals;

    const state = withProposal(loaded.state, {
      id,
      name: info.name,
      count: info.count,
      fingerprint: info.fingerprint,
      by: me.name ?? '匿名',
      at: Date.now(),
    });
    const next = advance(state, loaded.vault.secrets, Date.now());
    loaded.vault.secrets = next.secrets;
    const ok = await save(loaded, next.state, loaded.vault);
    if (!ok) throw new RoomError('房间正忙，请重试', 409);
    return snapshotOf(loaded, identityOf(loaded, token, hostToken, watchToken, devToken, deviceId));
  });
}

export async function importBankFile(
  code: string,
  token: string | null,
  hostToken: string | null,
  watchToken: string | null,
  fileText: string,
  passphrase: string,
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<Snapshot> {
  // 先做一次纯解析（耗时 ~0.3s 的 PBKDF2），放到锁外，避免阻塞同房间轮询
  const { file, payload } = await decryptBank(fileText, passphrase);
  if (payload.words.length < 25) throw new RoomError('题库不足 25 词', 400);
  return proposeBank(
    code,
    payload.words,
    { name: payload.name, count: payload.words.length, fingerprint: file.fingerprint },
    token,
    hostToken,
    watchToken,
    devToken,
    deviceId
  );
}

/**
 * 明文词库：浏览器把「用户粘贴或上传的文本」识别成词表后整份送来。
 *
 * 与 .sbank 的差别只在传输形式：那边传密文 + 口令，这里传明文（服务端反正要拿到明文才能开局）。
 * 词表落点没变——只进 vault，公开快照里仍然只有名字/词数/指纹。
 * 客户端的识别结果一律不可信：这里重新清洗、重新去重、重新判长度。
 */
export async function importTextBank(
  code: string,
  token: string | null,
  hostToken: string | null,
  watchToken: string | null,
  name: string,
  rawWords: unknown,
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<Snapshot> {
  const words = normalizeEntries(rawWords);
  if (words.length < MIN_BANK_WORDS) {
    throw new RoomError(`题库至少要 ${MIN_BANK_WORDS} 个不同的词，现在只有 ${words.length} 个`, 400);
  }
  // 指纹只取决于词表内容：同一份词表换了分隔符再传，指纹不变
  const fingerprint = createHash('sha256')
    .update(words.map((w) => w.word).join('\n'))
    .digest('base64')
    .slice(0, 12);
  const cleanName = String(name ?? '').trim().slice(0, 20) || '手动词库';
  return proposeBank(
    code,
    words,
    { name: cleanName, count: words.length, fingerprint },
    token,
    hostToken,
    watchToken,
    devToken,
    deviceId
  );
}

/** 内置示例题库：方便第一次试玩，不需要准备 .sbank 文件 */
export async function importDemoBank(
  code: string,
  token: string | null,
  hostToken: string | null,
  watchToken: string | null,
  name: string,
  words: WordEntry[],
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<Snapshot> {
  return proposeBank(
    code,
    words,
    { name: name || '内置示例题库', count: words.length, fingerprint: 'DEMO-BUILTIN' },
    token,
    hostToken,
    watchToken,
    devToken,
    deviceId
  );
}

export async function readSnapshot(
  code: string,
  token: string | null,
  hostToken: string | null,
  watchToken: string | null = null,
  devToken: string | null = null,
  deviceId: string | null = null
): Promise<Snapshot> {
  return withLock(code, async () => {
    const loaded = await load(code);
    const now = Date.now();
    const advanced = advance(loaded.state, loaded.vault.secrets, now);
    if (advanced.state !== loaded.state) {
      loaded.vault.secrets = advanced.secrets;
      const ok = await save(loaded, advanced.state, loaded.vault);
      if (!ok) throw new RoomError('房间正忙，请重试', 409);
    }
    // 心跳：页面还开着就续期，大厅靠它区分「人在看」与「人走了」。
    // 只更新 updated_at 一列、90 秒最多一次，不碰 state / vault（vault 装着整份题库）。
    // 不 await：心跳失败最多让这间房早 20 分钟被判废，不值得拖慢每一次轮询。
    if (!loaded.state.closedAt && now - loaded.updatedAt > HEARTBEAT_MS) {
      void touchRoom(code).catch(() => undefined);
    }
    return snapshotOf(loaded, identityOf(loaded, token, hostToken, watchToken, devToken, deviceId));
  });
}
