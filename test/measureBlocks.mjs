/**
 * 区块高度探针：量「答题面板 / 对局历史」这两个卡片在某个视口下的实际高度，
 * 用来证明紧凑化改动的收益（截图看不出 5~15px 的差别）。
 *
 * 用法：node test/measureBlocks.mjs [html] [宽]
 *       node test/measureBlocks.mjs shot/mobile.html 390
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const DPORT = 9397;
const html = process.argv[2] || 'shot/mobile.html';
const width = Number(process.argv[3]) || 390;
const PAGE = `file:///${join(process.cwd(), html).replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${DPORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'suilan-measure-'))}`, 'about:blank'],
  { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DPORT}/json/version`);
    const url = (await r.json()).webSocketDebuggerUrl;
    if (url) { ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; }
  } catch { await sleep(250); }
}
if (!ws) { console.log('无法启动 Chromium'); process.exit(1); }

let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
await call('Page.navigate', { url: PAGE });
await sleep(700);

const EXPR = `(() => {
  const h = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return Math.round(r.height);
  };
  const legend = document.querySelector('.rec-legend');
  /* 同一行的 chip 顶部可能差 1~2px（行高不同、baseline 对齐），按 8px 一档归并才数得准 */
  const legendRows = legend
    ? new Set([...legend.children].map((c) => Math.round(c.getBoundingClientRect().top / 8))).size
    : 0;
  const rowH = [...document.querySelectorAll('.rec-row')].map((r) => Math.round(r.getBoundingClientRect().height));
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };
  return {
    page: document.documentElement.scrollHeight,
    scrollW: document.documentElement.scrollWidth,
    panel: h('.panel'),
    panelCard: h('.panel > .card'),
    panelKids: [...(document.querySelector('.panel > .card')?.children ?? [])].map(
      (c) => Math.round(c.getBoundingClientRect().height) + ':' + (c.className || c.tagName).toString().slice(0, 24)
    ),
    recCard: h('.rec-card'),
    legend: h('.rec-legend'),
    legendRows,
    rows: rowH,
    rowPad: cs('.rec-row', 'paddingTop'),
    rowCols: cs('.rec-row', 'gridTemplateColumns'),
    hintFont: cs('.board-hint', 'fontSize'),
  };
})()`;

const r = await call('Runtime.evaluate', { expression: EXPR, returnByValue: true });
const m = r.result?.value;
if (!m) {
  console.log('测量失败：', JSON.stringify(r).slice(0, 400));
  chrome.kill();
  process.exit(1);
}
console.log(`视口 ${width}　整页高 ${m.page}　横向溢出 ${m.scrollW > width + 1 ? '是(' + m.scrollW + ')' : '否'}`);
console.log(`答题面板 ${m.panel}（卡内 ${m.panelCard}）　对局历史卡 ${m.recCard}`);
console.log(`图例 ${m.legend}（${m.legendRows} 行）　行高 ${m.rows.join('/')}　行内边距 ${m.rowPad}　列宽 ${m.rowCols}`);
console.log(`答题卡子块：${m.panelKids.join('　')}`);
chrome.kill();
process.exit(0);
