/**
 * 分享码（sharecode）在地址栏里的保留规则。
 *
 * 平台网关对 `*.app.workbuddy.host` 的 node 应用有访问校验：链接不带 `?sharecode=`、
 * 浏览器又还没有 `__wb_rsc` cookie 时，直接返回 403「链接不完整」。
 * 玩家分享房间的方式就是复制地址栏，所以**任何改写地址栏的地方都不能把它抹掉**，
 * 否则复制出去的邀请链接别人一打开就是「链接不完整」（2026-11-12 线上实际发生）。
 *
 * 参数名平台用小写 `sharecode`，历史上也见过 `shareCode`，两个都认；输出统一写小写。
 */

const SHARE_KEYS = ['sharecode', 'shareCode'];

/** 从 query string 里取出分享码参数（形如 `sharecode=ABC`）；没有则返回空串 */
export function shareParam(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of SHARE_KEYS) {
    const value = params.get(key);
    if (value) return `sharecode=${encodeURIComponent(value)}`;
  }
  return '';
}

/** 进房地址：`?room=000`，有分享码时接在后面 */
export function roomQuery(roomCode: string, search: string): string {
  const share = shareParam(search);
  return share ? `?room=${roomCode}&${share}` : `?room=${roomCode}`;
}

/** 离房地址：清掉 room，但分享码必须留着 */
export function landingHref(pathname: string, search: string): string {
  const share = shareParam(search);
  return share ? `${pathname}?${share}` : pathname;
}
