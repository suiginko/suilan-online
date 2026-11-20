import {
  GameState,
  Intent,
  SeatKey,
  SpecGuessResult,
  Spectator,
  WordEntry,
} from '../types';

/** 题面：只有描述位（和开发者模式）拿得到，且只有单词本身 */
export interface Reveal {
  word: string;
}

export interface Snapshot {
  state: GameState;
  reveal: Reveal | null;
  seat: SeatKey | null;
  /** 本机的观战身份，坐进席位后为 null */
  spectator: Spectator | null;
  isSpectator: boolean;
  isHost: boolean;
  /** 是否是裁判 */
  isReferee: boolean;
  /** 开发者模式：可以代打四个席位、看到当前题面 */
  isDev: boolean;
  /** 裁判或开发者透视用全局词表 */
  allCellWords?: Record<string, WordEntry> | null;
  /** 观众猜词的私下回执（只有自己这一台设备看得到） */
  guessResult?: SpecGuessResult;
  serverNow: number;
}

/** 一台设备在某个房间里的四枚凭证：席位、房主、观众、开发者 */
export interface Creds {
  seat: string | null;
  host: string | null;
  watch: string | null;
  dev: string | null;
}

export const EMPTY_CREDS: Creds = { seat: null, host: null, watch: null, dev: null };

/** 大厅里的一行房间（服务端 `/api/rooms` 下发，只含公开信息） */
export interface RoomSummary {
  code: string;
  phase: GameState['phase'];
  round: number;
  /** 四席玩家名（SEAT_ORDER 顺序），null = 空位 */
  players: (string | null)[];
  seated: number;
  spectators: number;
  bank: { name: string; count: number } | null;
  updatedAt: number;
}

const SEAT_KEY = (code: string) => `suilan-rt-seat-${code}`;
const HOST_KEY = (code: string) => `suilan-rt-host-${code}`;
const WATCH_KEY = (code: string) => `suilan-rt-watch-${code}`;
const DEV_KEY = (code: string) => `suilan-rt-dev-${code}`;

/** 设备号：跨房间、跨「退出再进」都不变，是「这台设备一直是同一个人」的唯一依据 */
const DEVICE_KEY = 'suilan-device';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < bytes; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

let cachedDeviceId: string | null = null;

/**
 * 本机设备号。
 *
 * 为什么需要它：四枚令牌都存在 localStorage 里，点一次「返回」就会被清掉，
 * 清缓存/换标签页/隐私窗口也会丢。只靠令牌认人时，丢一次令牌服务端就当来了个新人，
 * 观战名单里于是多出一条同名记录——玩家就「看到了两个自己」。
 *
 * 设备号**不随 clearCreds 清除**，只在本机和服务端 vault 之间传递，
 * 不会出现在公开快照里，别的玩家看不到。
 */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(DEVICE_KEY);
  } catch {
    saved = null;
  }
  if (saved && saved.length >= 16) {
    cachedDeviceId = saved;
    return saved;
  }
  const fresh = randomHex(16);
  cachedDeviceId = fresh;
  try {
    localStorage.setItem(DEVICE_KEY, fresh);
  } catch {
    /* 隐私模式下写不进去：本次会话内仍然可用 */
  }
  return fresh;
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* 隐私模式下不可用，忽略 */
  }
}

export function readCreds(code: string): Creds {
  return {
    seat: readKey(SEAT_KEY(code)),
    host: readKey(HOST_KEY(code)),
    watch: readKey(WATCH_KEY(code)),
    dev: readKey(DEV_KEY(code)),
  };
}

export function writeCreds(code: string, creds: Partial<Creds>) {
  if ('seat' in creds) writeKey(SEAT_KEY(code), creds.seat ?? null);
  if ('host' in creds) writeKey(HOST_KEY(code), creds.host ?? null);
  if ('watch' in creds) writeKey(WATCH_KEY(code), creds.watch ?? null);
  if ('dev' in creds) writeKey(DEV_KEY(code), creds.dev ?? null);
}

export function clearCreds(code: string) {
  writeKey(SEAT_KEY(code), null);
  writeKey(HOST_KEY(code), null);
  writeKey(WATCH_KEY(code), null);
  writeKey(DEV_KEY(code), null);
}

async function call<T>(
  path: string,
  init?: RequestInit & { creds?: Creds | null }
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // 设备号每次都带：令牌丢失/失效时，服务端靠它把同一台设备认回原来的身份
  headers['x-device-id'] = deviceId();
  if (init?.creds?.seat) headers['x-seat-token'] = init.creds.seat;
  if (init?.creds?.host) headers['x-host-token'] = init.creds.host;
  if (init?.creds?.watch) headers['x-watch-token'] = init.creds.watch;
  if (init?.creds?.dev) headers['x-dev-token'] = init.creds.dev;

  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
    });
  } catch {
    throw new Error('网络连接失败，请检查网络后重试');
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok) {
    const msg =
      (payload as { error?: string } | null)?.error ??
      (res.status === 404 ? '房间不存在或已过期' : `请求失败（${res.status}）`);
    throw new Error(msg);
  }
  return payload as T;
}

/** 房间大厅：落地页列出所有还活着的房间 */
export function apiListRooms() {
  return call<{ rooms: RoomSummary[] }>('/api/rooms');
}

/** 建房：房主是观众身份，可以自己坐一席，也可以只审批题库 */export function apiCreateRoom(name: string, dev: boolean) {
  return call<{
    code: string;
    hostToken: string;
    watchToken: string;
    devToken: string | null;
    snapshot: Snapshot;
  }>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, dev }),
  });
}

export function apiClaimSeat(code: string, seat: SeatKey, name: string, creds: Creds) {
  return call<{ token: string; snapshot: Snapshot }>(`/api/rooms/${code}/seat`, {
    method: 'POST',
    creds,
    body: JSON.stringify({ seat, name }),
  });
}

export function apiWatch(code: string, name: string, creds: Creds) {
  return call<{ token: string; snapshot: Snapshot }>(`/api/rooms/${code}/watch`, {
    method: 'POST',
    creds,
    body: JSON.stringify({ name }),
  });
}

export function apiSnapshot(code: string, creds: Creds) {
  return call<Snapshot>(`/api/rooms/${code}`, { creds });
}

export function apiAct(code: string, creds: Creds, intent: Intent) {
  return call<Snapshot>(`/api/rooms/${code}/act`, {
    method: 'POST',
    creds,
    body: JSON.stringify({ intent }),
  });
}

export function apiImportBank(code: string, creds: Creds, fileText: string, passphrase: string) {
  return call<Snapshot>(`/api/rooms/${code}/bank`, {
    method: 'POST',
    creds,
    body: JSON.stringify({ fileText, passphrase }),
  });
}

/** 明文词库：词表已在前端识别成数组，服务端会重新清洗一遍 */
export function apiImportTextBank(code: string, creds: Creds, name: string, words: WordEntry[]) {
  return call<Snapshot>(`/api/rooms/${code}/bank/text`, {
    method: 'POST',
    creds,
    body: JSON.stringify({ name, words }),
  });
}

export function apiImportDemoBank(code: string, creds: Creds) {
  return call<Snapshot>(`/api/rooms/${code}/bank/demo`, {
    method: 'POST',
    creds,
    body: '{}',
  });
}
