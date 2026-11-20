/**
 * 版面探针：在几个常见视口宽度下量「棋盘还剩多宽」「两侧席位卡有没有压到六边形」。
 *
 * 为什么要量：棋盘是宽度受限的，席位卡放到两边就会吃掉棋盘的宽度。
 * 只靠肉眼看截图判断不了「窄屏会不会挤坏」，所以这里直接读布局盒。
 *
 * 用法：node test/layoutProbe.mjs             （先 npx tsx test/renderSwap.tsx 生成页面）
 *       node test/layoutProbe.mjs 430 390 360  （只量指定宽度；手机端用它，见 AGENTS 踩坑 #29）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const DPORT = 9381;
const PAGE = `file:///${join(process.cwd(), 'shot', 'swap-green.html').replace(/\\/g, '/')}`;
const ARGS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const WIDTHS = ARGS.length ? ARGS : [1600, 1440, 1280, 1180, 1120, 1024, 820, 700];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${DPORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'suilan-layout-'))}`, 'about:blank'],
  { stdio: 'ignore' }
);

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DPORT}/json/version`);
    const url = (await r.json()).webSocketDebuggerUrl;
    if (url) {
      ws = new WebSocket(url);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      break;
    }
  } catch { await sleep(250); }
}
if (!ws) { console.log('无法启动 Chromium'); process.exit(1); }

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);
const evalJs = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

await call('Page.enable');

const SCRIPT = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const svg = document.querySelector('.board-svg');
  const rails = [...document.querySelectorAll('.seat-rail')];
  /* 用 polygon 而不是 .hex：开局前棋盘只有 ghost 网格，没有 .hex 的 <g> 包裹 */
  const hexes = [...document.querySelectorAll('.board-svg polygon')].map((g) => {
    const r = g.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  /** 一对矩形若有一个轴分离就算没相交，取较大的分离量作为两者间距的下界（相交时为负） */
  const gapOf = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
  const minGap = (a) => {
    let best = Infinity;
    for (const h of hexes) {
      const g = gapOf(a, h);
      if (Number.isFinite(g) && g < best) best = g;
    }
    return Number.isFinite(best) ? Math.round(best) : null;
  };
  const cards = [...document.querySelectorAll('.seat-rail .roster-seat')].map(box);
  return {
    viewport: innerWidth,
    svg: box(svg),
    rails: rails.map(box),
    gaps: rails.map((el) => minGap(box(el))),
    cardW: Math.round(cards[0]?.w ?? 0),
    cardH: Math.round(cards[0]?.h ?? 0),
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
  };
})()`;

console.log('\n视口  棋盘宽  棋盘高  席位栏宽  卡片宽×高  距六边形  横向溢出  页面高');
console.log('─'.repeat(78));
for (const w of WIDTHS) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: PAGE });
  await sleep(320);
  const m = await evalJs(SCRIPT);
  const railW = m.rails.map((r) => Math.round(r.w)).join('/');
  const gap = m.gaps.some((g) => g < 0) ? `压住(${m.gaps.join('/')}px)` : `${Math.min(...m.gaps)}px`;
  const bad = m.scrollW > m.viewport + 1 ? `是(${m.scrollW})` : '否';
  console.log(
    `${String(w).padEnd(5)} ${String(Math.round(m.svg.w)).padEnd(7)} ${String(Math.round(m.svg.h)).padEnd(7)} ` +
    `${railW.padEnd(9)} ${`${m.cardW}×${m.cardH}`.padEnd(10)} ${gap.padEnd(9)} ${bad.padEnd(9)} ${m.scrollH}`
  );
}

chrome.kill();
process.exit(0);
