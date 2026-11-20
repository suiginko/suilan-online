/**
 * 导出图排版探针的截图器（仅开发验证用）。
 *
 * 为什么不用 `chrome --screenshot`：`--virtual-time-budget` 只会快进定时器，
 * 不会快进 canvas.toBlob 的真实异步回调，截到的是「渲染中…」。
 * 所以这里用 CDP 真等 `document.title === 'EXPORT-READY'` 再截。
 *
 * 用法：node test/exportShot.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const DPORT = 9377;
const SHOT = join(process.cwd(), 'shot', 'export-probe.png');
const PAGE = `file:///${join(process.cwd(), 'shot', 'export-probe.html').replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${DPORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'suilan-shot-'))}`, 'about:blank'],
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
await call('Emulation.setDeviceMetricsOverride', { width: 1120, height: 1300, deviceScaleFactor: 1, mobile: false });
await call('Page.navigate', { url: PAGE });

let ready = false;
for (let i = 0; i < 100; i++) {
  if ((await evalJs('document.title')) === 'EXPORT-READY') { ready = true; break; }
  await sleep(200);
}
const note = await evalJs(`document.getElementById('note').textContent`);
console.log('页面状态：', note);
if (!ready) {
  console.log('未在 20 秒内完成导出');
  chrome.kill();
  process.exit(1);
}

const { data } = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(SHOT, Buffer.from(data, 'base64'));
console.log('已写入', SHOT);
chrome.kill();
process.exit(0);
