import fs from 'node:fs';
import path from 'node:path';

/**
 * 对局存储：**进程内存 + 本地快照文件**，不依赖任何云服务。
 *
 * 为什么不再用云库：一台房间服务器本来就在进程里，所有玩家连的是同一个进程，
 * 状态放内存就够同步；走云库每 0.9 秒读一次、每次落子写回 60 多 KB，
 * 资源点全烧在「同一个进程反复读自己刚写的数据」上（见 AGENTS 踩坑 #41）。
 *
 * 代价必须记住：**内存里的东西活不过进程**。沙箱被回收、重新发布、
 * 进程崩溃重启，房间就没了——这是刻意换来的零成本，不要再往上堆「长期存档」类需求。
 * 同一个进程重启（`node --watch`、崩溃后自动拉起）能从 `data/rooms.json` 捞回来。
 *
 * 这里保留 `sig` / `vault` 两个字段与原来的加解密：
 *  - `vault` 仍是密文。虽然内存外部读不到，但保持同一套数据形状，
 *    service 层的读写逻辑一行都不用改；快照文件落盘时也不会明文躺着答案。
 *  - `sig` 仍是快照签名。它挡住的是「有人改了内存里的 state 却没走 save」这类内部错乱，
 *    顺带给测试一个能篡改检测的入口。
 *
 * 接口与原云库版**完全一致**（都是 async），所以 service.ts 不需要知道存储换了。
 */

export interface RoomRow {
  code: string;
  ver: number;
  state: unknown;
  sig: string;
  vault: string;
  updated_at: string;
}

const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
/** 已解散的房间留 10 分钟让玩家看到「房间已解散」，之后直接丢弃（不必像云库那样永远留着） */
const CLOSED_KEEP_MS = 10 * 60 * 1000;

const rooms = new Map<string, RoomRow>();

const DATA_DIR = process.env.SUILAN_DATA_DIR ?? path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'rooms.json');
/** 落盘防抖：对局中每 0.9 秒就可能有一次写入，不能每次都整份写盘 */
const SNAPSHOT_DEBOUNCE_MS = 1500;

const liveOf = (row: RoomRow, now = Date.now()): boolean => {
  const closedAt = (row.state as { closedAt?: number | null } | null)?.closedAt;
  if (closedAt) return false;
  return now - new Date(row.updated_at).getTime() <= ROOM_TTL_MS;
};

/* ───────────────────────── 本地快照 ───────────────────────── */

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function persistNow(): void {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ v: 1, savedAt: Date.now(), rooms: Object.fromEntries(rooms) });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    // 先写临时文件再 rename：进程在写一半时被杀掉也不会留下半截 JSON
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (e) {
    console.warn(`[store] 快照写盘失败（不影响对局）：${(e as Error).message}`);
  }
}

function schedulePersist(): void {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, SNAPSHOT_DEBOUNCE_MS);
  // 别为了一个防抖定时器把进程钉住不退出
  persistTimer.unref?.();
}

function restore(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  } catch {
    return; // 第一次启动，没有快照很正常
  }
  try {
    const parsed = JSON.parse(raw) as { rooms?: Record<string, RoomRow> };
    const now = Date.now();
    let kept = 0;
    for (const [code, row] of Object.entries(parsed.rooms ?? {})) {
      if (!row || typeof row !== 'object' || typeof row.vault !== 'string') continue;
      if (!liveOf(row, now)) continue;
      rooms.set(code, row);
      kept++;
    }
    if (kept) console.log(`[store] 从快照恢复 ${kept} 间房`);
  } catch (e) {
    console.warn(`[store] 快照损坏，忽略：${(e as Error).message}`);
  }
}

// 进程收到退出信号时把最后一批改动落盘（SIGKILL 拦不住，那种情况丢最后一两秒的改动）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    persistNow();
    process.exit(0);
  });
}

restore();

/* ───────────────────────── 对外接口（与原云库版一致） ───────────────────────── */

export async function loadRoom(code: string): Promise<RoomRow | null> {
  const row = rooms.get(code);
  if (!row) return null;
  const closedAt = (row.state as { closedAt?: number | null } | null)?.closedAt;
  if (closedAt) {
    // 已解散：以解散时刻起算保留期，超过就真正丢掉
    if (Date.now() - Number(closedAt) > CLOSED_KEEP_MS) {
      rooms.delete(code);
      schedulePersist();
      return null;
    }
    return row;
  }
  if (Date.now() - new Date(row.updated_at).getTime() > ROOM_TTL_MS) {
    // 过期房没人再用了，顺手回收内存
    rooms.delete(code);
    schedulePersist();
    return null;
  }
  return row;
}

/** 新建房间。房号被占时抛「房号冲突」，与云库唯一键冲突的行为保持一致 */
export async function insertRoom(row: Omit<RoomRow, 'updated_at'>): Promise<void> {
  if (rooms.has(row.code) && liveOf(rooms.get(row.code)!)) {
    throw new Error('房号冲突，请重试');
  }
  rooms.set(row.code, { ...row, updated_at: new Date().toISOString() });
  schedulePersist();
}

/** 所有「活」房的房号：顺序分房时用来找最小空号（死房不占号） */
export async function listRoomCodes(): Promise<string[]> {
  const now = Date.now();
  return [...rooms.values()].filter((r) => liveOf(r, now)).map((r) => r.code);
}

/** 大厅用：所有「活」房的状态摘要，最近有人来过的在前 */
export async function listLiveRooms(limit = 60): Promise<{ code: string; state: unknown; updatedAt: number }[]> {
  const now = Date.now();
  return [...rooms.values()]
    .filter((r) => liveOf(r, now))
    .map((r) => ({ code: r.code, state: r.state, updatedAt: new Date(r.updated_at).getTime() }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/**
 * 心跳：只刷 `updated_at`，不动 ver / state / vault。
 *
 * 以前这一步在云库上很贵（改一列也会重写整行 60 多 KB），所以节流到 90 秒；
 * 现在只是改内存里的一个字段，调用它的节流逻辑保留着，因为「判废」语义没变。
 */
export async function touchRoom(code: string): Promise<string | null> {
  const row = rooms.get(code);
  if (!row) return null;
  if ((row.state as { closedAt?: number | null } | null)?.closedAt) return row.updated_at;
  row.updated_at = new Date().toISOString();
  schedulePersist();
  return row.updated_at;
}

/**
 * 回收一个死房号：把新房间原地写进那一格（活房间不受影响）。
 * 返回 false 表示那间房还活着（并发创建的活房间），调用方应顺延下一个号。
 */
export async function reclaimExpiredRoom(
  code: string,
  fresh: Omit<RoomRow, 'updated_at'>
): Promise<boolean> {
  const row = rooms.get(code);
  if (!row) return false;
  const closedAt = (row.state as { closedAt?: number | null } | null)?.closedAt;
  const alive = !closedAt && Date.now() - new Date(row.updated_at).getTime() <= ROOM_TTL_MS;
  if (alive) return false;
  rooms.set(code, { ...fresh, updated_at: new Date().toISOString() });
  schedulePersist();
  return true;
}

/**
 * 乐观锁写入：只有内存里的 ver 仍等于 expectedVer 时才生效。
 *
 * 单进程下 `withLock(code)` 已经把同一间房的请求串起来了，这里的 ver 校验是第二道保险：
 * 万一以后有人绕过锁、或者改成多进程，行为仍与云库版一致（返回 false 让调用方重读重算）。
 *
 * keepAlive = false 时把 updated_at 置成 1970（「这间房已经死了」）：
 * 解散房间用它——房间当场冻结，房号立刻回到可分配池。
 */
export async function casUpdate(
  code: string,
  expectedVer: number,
  patch: { state: unknown; sig: string; vault: string },
  opts: { keepAlive?: boolean } = {}
): Promise<boolean> {
  const row = rooms.get(code);
  if (!row || row.ver !== expectedVer) return false;
  row.ver = expectedVer + 1;
  row.state = patch.state;
  row.sig = patch.sig;
  row.vault = patch.vault;
  row.updated_at = opts.keepAlive === false ? new Date(0).toISOString() : new Date().toISOString();
  schedulePersist();
  return true;
}

/** 供启动日志/排查用：当前进程里还留着几间房 */
export function roomCount(): number {
  return rooms.size;
}
