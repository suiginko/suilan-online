/**
 * 大厅里「废弃房间」的判定（纯函数，服务端与测试共用）。
 *
 * 为什么需要单独一套判定：`rt_rooms` 的 8 小时 TTL 只保证「不长期烂在库里」，
 * 但大厅是对外门面——一个「建完房、没等来任何人就关掉页面」的空房会占着首屏 8 小时。
 *
 * 关键在于**用哪根时间轴**判定：
 *   · 「最后一次状态变化」（`updated_at` 早先的唯一含义）→ 真人开局前静静等人 5 分钟就会被判死；
 *   · 「最后一次有人在线」→ 页面开着就续期，关掉才算静默。
 * 服务端为此在快照读取路径上挂了节流心跳（`touchRoom`，90 秒最多一次、只写一列时间戳），
 * 所以这里量到的静默时长真的等于「没人在看了」。
 */

/** 各阶段「静默多久算废弃」 */
export const ABANDON_IDLE_MS = {
  /** 大厅阶段：等人进来最多 20 分钟。页面开着会心跳续期，不会误伤真在等人的房主 */
  lobby: 20 * 60_000,
  /** 对局中：1 小时没人看（手机锁屏、全员掉线、开着标签页被浏览器冻结） */
  playing: 60 * 60_000,
  /** 已结束：2 小时没人看才算废。终局页本来就排在大厅末尾，不至于挡人，留足回看时间 */
  finished: 2 * 60 * 60_000,
} as const;

export type AbandonReason = 'lobby-idle' | 'playing-idle' | 'finished-idle';

/**
 * 快照心跳的最小间隔。
 *
 * 客户端在房间里每 900ms 拉一次快照；如果每次都写库，一个房一天就是十万次写。
 * 折到 90 秒一次后，一个活跃房最多 960 次/天，而且是只改 `updated_at` 一列的窄更新。
 * 这个值必须**明显小于**最短的判废阈值（大厅 20 分钟），否则页面开着也会被判死。
 */
export const HEARTBEAT_MS = 90_000;

/**
 * 这间房算不算废弃；不算就返回 null。
 *
 * @param state     公开快照（只需要 phase 与 closedAt）
 * @param updatedAt 最后一次有人在线的时间（库里的 `updated_at`）
 * @param now       当前时间
 */
export function abandonOf(
  state: { phase?: string | null; closedAt?: number | null } | null | undefined,
  updatedAt: number,
  now: number
): AbandonReason | null {
  if (!state?.phase) return null;
  // 已经解散过的房不再重复处理（重复标记只会白写一次库）
  if (state.closedAt) return null;
  const idle = now - updatedAt;
  // 时间戳颠倒（两端时钟漂移、刚写完还没落库）一律当活跃，宁可漏清不可误清
  if (!Number.isFinite(idle) || idle <= 0) return null;

  if (state.phase === 'lobby') return idle >= ABANDON_IDLE_MS.lobby ? 'lobby-idle' : null;
  if (state.phase === 'finished') return idle >= ABANDON_IDLE_MS.finished ? 'finished-idle' : null;
  return idle >= ABANDON_IDLE_MS.playing ? 'playing-idle' : null;
}
