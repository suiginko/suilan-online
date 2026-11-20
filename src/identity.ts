import { Spectator } from './types';

/**
 * 身份解析（纯函数，无 IO）——「这台设备在这个房间里到底是谁」。
 *
 * 为什么需要它：令牌是易丢的（清缓存、点过「返回」、换了标签页、隐私窗口），
 * 而人是同一个。只靠令牌认人时，丢一次令牌就等于换了一个新人，观战名单里
 * 便会多出一条同名记录——玩家看到「两个自己」。
 *
 * 所以身份有两把钥匙：
 *   1. 令牌（token）：快，但会丢
 *   2. 设备号（deviceId）：持久（localStorage 里全局一份，不随房间清凭据），
 *      丢令牌时用它认回同一个 specId
 *
 * 约束：deviceId 只存在服务端 vault 与那台设备本地，**不进公开快照**。
 */

/** 观众令牌 → 观众记录（服务端 vault 里的一行） */
export interface SpectatorRecord {
  id: string;
  name: string;
}

/** 设备号 → 这台设备在本房间的观众身份 */
export interface DeviceRecord {
  specId: string;
  name: string;
}

/**
 * 认人：先看令牌，再退回设备号。
 * 返回本房间的观众 specId；两条线索都没命中返回 null（= 新来的）。
 */
export function spectatorIdFor(
  tokens: Record<string, SpectatorRecord>,
  devices: Record<string, DeviceRecord>,
  token: string | null | undefined,
  deviceId: string | null | undefined
): string | null {
  if (token && tokens[token]) return tokens[token].id;
  if (deviceId && devices[deviceId]) return devices[deviceId].specId;
  return null;
}

/** 观众表里还活着的 specId 集合：用于把 state.spectators 里的幽灵条目扫掉 */
export function liveSpecIds(tokens: Record<string, SpectatorRecord>): Set<string> {
  const live = new Set<string>();
  for (const rec of Object.values(tokens)) live.add(rec.id);
  return live;
}

/**
 * 扫掉观战名单里的幽灵条目：id 已经没有任何令牌/设备认领的那些。
 *
 * 只该在「观众登记」这条写路径上调用——那时才合法地新增/作废令牌，
 * 才有必要把历史遗留（旧版本清凭据留下的）一次性收拾干净。
 * 没变化时原样返回，避免为了空操作把状态写成新对象、白白消耗一次 CAS。
 */
export function pruneSpectators(list: Spectator[], live: Set<string>): Spectator[] {
  if (!list.length) return list;
  let dropped = false;
  const kept: Spectator[] = [];
  for (const sp of list) {
    if (live.has(sp.id)) kept.push(sp);
    else dropped = true;
  }
  return dropped ? kept : list;
}
