import { ABANDON_IDLE_MS, HEARTBEAT_MS, abandonOf } from '../src/lobby';

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

const MIN = 60_000;
const NOW = 1_700_000_000_000;
/** 建一间「最后一次有人在线是 agoMs 之前」的房 */
const at = (phase: string, agoMs: number, closedAt: number | null = null) =>
  abandonOf({ phase, closedAt }, NOW - agoMs, NOW);

console.log('== 大厅阶段：等人 20 分钟内不算废 ==');

check(at('lobby', 1 * MIN) === null, '刚建好的房不算废');
check(at('lobby', 19 * MIN) === null, '19 分钟仍算「还在等人」');
check(at('lobby', 20 * MIN) === 'lobby-idle', '满 20 分钟判废（边界取 >=）');
check(at('lobby', 21 * MIN) === 'lobby-idle', '21 分钟判废');

console.log('\n== 对局中与已结束：1 小时 ==');

check(at('select', 59 * MIN) === null, '对局中 59 分钟不算废');
check(at('describe', 60 * MIN) === 'playing-idle', '对局中满 1 小时判废');
check(at('guess', 120 * MIN) === 'playing-idle', '对局中 2 小时判废');
check(at('steal', 30 * MIN) === null, '抢答阶段 30 分钟不算废');
check(at('finished', 119 * MIN) === null, '终局页 2 小时内保留（够回看）');
check(at('finished', 120 * MIN) === 'finished-idle', '终局页满 2 小时判废');

console.log('\n== 不该动的情况 ==');

check(at('lobby', 999 * MIN, 12345) === null, '已解散的房不重复处理（否则白写一次库）');
check(abandonOf(null, NOW - 999 * MIN, NOW) === null, '没有快照的空行不动');
check(abandonOf({ phase: null }, NOW - 999 * MIN, NOW) === null, 'phase 缺失不动');
check(
  abandonOf({ phase: 'lobby' }, NOW + 5 * MIN, NOW) === null,
  '时间戳在未来（时钟漂移）当活跃处理，宁可漏清'
);
check(abandonOf({ phase: 'lobby' }, NaN, NOW) === null, '时间戳非法当活跃处理');
check(at('lobby', 0) === null, '刚好此刻有人在线（idle=0）不算废');

console.log('\n== 心跳与阈值的关系 ==');

check(
  HEARTBEAT_MS * 2 < ABANDON_IDLE_MS.lobby,
  `心跳 ${HEARTBEAT_MS / 1000}s 远小于大厅判废阈值 ${ABANDON_IDLE_MS.lobby / MIN}min（页面开着不会被判死）`
);
check(HEARTBEAT_MS > 0, '心跳间隔为正');
check(
  ABANDON_IDLE_MS.playing >= ABANDON_IDLE_MS.lobby,
  '对局中的容忍时间不短于大厅（打到一半的局更不该被清）'
);

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
