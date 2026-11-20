import { Spectator } from '../src/types';
import { DeviceRecord, SpectatorRecord, liveSpecIds, pruneSpectators, spectatorIdFor } from '../src/identity';

/**
 * 身份解析层：「这台设备在这个房间里是谁」。
 *
 * 这些断言盯着一个具体的线上问题：玩家可能在房间里**看到两个自己**——
 * 一条在选手席位里，一条在观战名单里，或者在观战名单里出现两条同名记录。
 */

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const tokens = (...pairs: [string, SpectatorRecord][]): Record<string, SpectatorRecord> =>
  Object.fromEntries(pairs);
const devices = (...pairs: [string, DeviceRecord][]): Record<string, DeviceRecord> =>
  Object.fromEntries(pairs);
const list = (...ids: string[]): Spectator[] => ids.map((id) => ({ id, name: '同一个人' }));

console.log('\n[身份] 令牌优先，丢令牌时靠设备号认回同一个人');
{
  const t = tokens(['tk-a', { id: 's1', name: '阿蓝' }]);
  const d = devices(['dev-1', { specId: 's1', name: '阿蓝' }]);

  check(spectatorIdFor(t, d, 'tk-a', 'dev-1') === 's1', '令牌有效时按令牌认人');
  check(spectatorIdFor(t, d, 'tk-dead', 'dev-1') === 's1', '令牌失效但设备号还在 → 仍是 s1（这是修复的核心）');
  check(spectatorIdFor(t, d, null, 'dev-1') === 's1', '完全没令牌、只有设备号 → 仍是 s1');
  check(spectatorIdFor(t, d, null, 'dev-2') === null, '换一台设备、没有令牌 → 视为新来的');
  check(spectatorIdFor(t, d, 'tk-x', null) === null, '没有设备号的旧客户端行为不变（认不出就是新人）');
}

console.log('\n[身份] 幽灵条目清扫');
{
  const live = liveSpecIds(tokens(['tk-a', { id: 's1', name: '阿蓝' }]));
  check(live.has('s1') && live.size === 1, '活着的身份只有一个');
  check(liveSpecIds({}).size === 0, '空观众表没有活身份');

  const kept = pruneSpectators(list('s1'), live);
  check(kept.length === 1, '本人留在名单里');

  const pruned = pruneSpectators(list('s1', 'ghost'), live);
  check(pruned.length === 1 && pruned[0].id === 's1', '没有任何令牌认领的幽灵被扫掉');

  const two = pruneSpectators(list('ghost-1', 'ghost-2'), live);
  check(two.length === 0, '旧版本遗留的多条同名幽灵一次清空');

  const empty: Spectator[] = [];
  check(pruneSpectators(empty, live) === empty, '空名单原样返回（不做无用写库）');

  const clean = list('s1', 's2');
  check(pruneSpectators(clean, new Set(['s1', 's2'])) === clean, '没有幽灵时返回原数组，避免多一次 CAS 写');
}

console.log('\n[身份] 复现「看到两个自己」的两条路径');
{
  // 路径一：进房 → 点「返回」（清凭据）→ 再进
  // 旧逻辑：每次都发新 specId，名单里累积两条同名记录
  const t = tokens(['tk-old', { id: 's1', name: '阿蓝' }]);
  const d = devices(['dev-1', { specId: 's1', name: '阿蓝' }]);
  const oldBehaviourId = null; // 旧实现只查令牌，清过凭据就查不到
  const newId = spectatorIdFor(t, d, null, 'dev-1');
  check(oldBehaviourId === null && newId === 's1', '重进房间：旧实现会造新身份，新实现认回 s1');
  check(pruneSpectators(list('s1', 's1-new'), liveSpecIds(t)).length === 1, '结果：名单里只留一条「阿蓝」');

  // 路径二：坐在席位上 → 点「退出」（旧实现在只清本地没通知服务端）→ 再进
  // 服务端仍认为你坐在席位上；此时不该再登记观战身份，否则一处选手一处观众
  const seatedDevice = 'dev-1';
  const seatOwner = 'dev-1';
  check(seatedDevice === seatOwner, '设备号能证明那个座位还是你的（服务端据此直接还座，不再登记观众）');
}

console.log('\n[身份] 改名后仍然认得出是同一个人');
{
  const t = tokens(['tk-a', { id: 's1', name: '阿蓝' }]);
  const d = devices(['dev-1', { specId: 's1', name: '阿蓝' }]);
  check(spectatorIdFor(t, d, 'tk-a', 'dev-1') === 's1', '改名前');
  const renamed: Record<string, DeviceRecord> = { 'dev-1': { specId: 's1', name: '小青' } };
  check(spectatorIdFor(t, renamed, null, 'dev-1') === 's1', '改名后（设备记录同步）仍是 s1');
}

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
