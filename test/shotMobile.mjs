/**
 * 临时截图脚本：用 CDP 精确模拟手机视口（--window-size 在 500px 以下会被系统最小窗宽吃掉，
 * 直接截图会「按 500 布局、裁到 390」，看起来像棋盘被切了）。
 * 用法：node test/__shot_mobile.mjs <html 路径> <宽> <高> <输出 png>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const DPORT = 9393;
const [html, wArg, hArg, out] = process.argv.slice(2);
const width = Number(wArg) || 390;
const height = Number(hArg) || 844;
const PAGE = `file:///${join(process.cwd(), html).replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${DPORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'suilan-shot-'))}`, 'about:blank'],
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
await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
await call('Page.navigate', { url: PAGE });
await sleep(600);
const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
const size = await call('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight', returnByValue: true });
console.log(`已写 ${out}（页面 ${size.result.value}，视口 ${width}×${height}）`);
chrome.kill();
process.exit(0);
