/**
 * 分享码保留（`src/share.ts`）。
 *
 * 线上事故（2026-11-12）：平台的 node 应用要求链接带 `?sharecode=`，否则网关返回「链接不完整」。
 * 而 App 进房时把地址改写成了 `?room=000`，把 sharecode 抹掉了 —— 玩家从地址栏复制出去的邀请链接
 * 别人一打开就是 403。这里锁住三条不变量：
 *   ① 有分享码时，`?room=xxx` 必须带着它；
 *   ② 离房回到落地页也要带着它（否则在落地页复制的链接同样失效）；
 *   ③ 没有分享码时一个多余字符都不加（本地开发、旧链接不受影响）。
 */
import { landingHref, roomQuery, shareParam } from '../src/share';

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

console.log('\n== 分享码保留 ==\n');

// ── shareParam ────────────────────────────────────────────
check(shareParam('') === '', '空 query 不产出分享码');
check(shareParam('?room=000') === '', '只有房间号时不算分享码');
check(shareParam('?sharecode=EZH2JALIDX') === 'sharecode=EZH2JALIDX', '读出小写 sharecode');
check(shareParam('?shareCode=EZH2JALIDX') === 'sharecode=EZH2JALIDX', '驼峰写法也认，输出统一小写');
check(
  shareParam('?room=000&sharecode=EZH2JALIDX') === 'sharecode=EZH2JALIDX',
  '房间号与分享码并存时只取分享码'
);
check(shareParam('?sharecode=') === '', '空值视为没有分享码');
check(
  shareParam('?sharecode=a%20b%2Bc') === 'sharecode=a%20b%2Bc',
  '需要转义的分享码原样保留'
);

// ── roomQuery ─────────────────────────────────────────────
check(roomQuery('000', '') === '?room=000', '无分享码：进房地址保持原样');
check(
  roomQuery('000', '?sharecode=EZH2JALIDX') === '?room=000&sharecode=EZH2JALIDX',
  '有分享码：进房地址带着它（这是修复的核心）'
);
check(
  roomQuery('123', '?room=123&sharecode=EZH2JALIDX') === '?room=123&sharecode=EZH2JALIDX',
  '已在房间里换房号：分享码不丢'
);
check(
  roomQuery('007', '?sharecode=EZH2JALIDX&shareCode=OTHER') === '?room=007&sharecode=EZH2JALIDX',
  '同时存在两种写法时取先命中的小写那个'
);

// ── landingHref ───────────────────────────────────────────
check(landingHref('/', '') === '/', '无分享码：离房地址是干净的 pathname');
check(landingHref('/', '?room=000') === '/', '只有房间号：离房时清掉它');
check(
  landingHref('/', '?room=000&sharecode=EZH2JALIDX') === '/?sharecode=EZH2JALIDX',
  '有分享码：离房后仍保留（否则落地页复制出去的链接又失效）'
);
check(
  landingHref('/index.html', '?sharecode=ABC') === '/index.html?sharecode=ABC',
  'pathname 非根路径时照样拼接'
);

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
