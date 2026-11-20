/**
 * 多台"设备"的浏览器端到端测试。
 *
 * 用 CDP 的 Target.createBrowserContext 开互相隔离的浏览器上下文
 * —— localStorage / cookie 完全分开，等价于不同设备。
 *
 * 覆盖：落地页 → 隐藏口令开启开发者模式 → 建房即见棋盘（等待导入题库）
 *      → 观众进房 / 改昵称 → 点席位入座 → 明文词库（粘贴 → 预览 → 删改 → 提交 → 拒绝）
 *      → 观众上传示例题库 + 房主审批
 *      → 开发者坐满四席、四席准备后自动开局 → 选格 → 描述校验 → 作答
 *      → 对局历史（描述/作答/超时跳过/答对）→ 暂停 → 复制局面图到剪贴板
 *      → 解散房间（两步确认，两端同步「房间已解散」）。
 *
 * 用法：BASE=http://127.0.0.1:4519 node test/e2e.mjs
 *      线上：BASE=https://suilan-online.app.workbuddy.host WB_SHARECODE=xxxx node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:4519';
/** 线上分享码：设了它，每次导航前先落地 __wb_rsc cookie（本地跑不用设） */
const SHARECODE = process.env.WB_SHARECODE || '';
const DPORT = Number(process.env.CDP_PORT || 9341);
const PROFILE = join(tmpdir(), `suilan-cdp-${Date.now()}`);
const SHOT_DIR = join(process.cwd(), 'shot');
mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 描述必须是两个汉字且不含答案里的字：从干支表里挑两个安全的字 */
const CLUE_POOL = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
function clueFor(answer, skip = 0) {
  const banned = new Set([...(answer ?? '')]);
  return [...CLUE_POOL].filter((c) => !banned.has(c)).slice(skip, skip + 2).join('');
}

let pass = 0;
const fails = [];
function check(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}

/** 一条 CDP 连接；sessionId 为空时直接对 browser 目标发命令 */
class Cdp {
  constructor(ws, name, sessionId = null) {
    this.ws = ws;
    this.name = name;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (this.sessionId) msg.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return (${expression}); } catch (e) { return '__ERR__' + e.message; } })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const v = res.result?.value;
    if (typeof v === 'string' && v.startsWith('__ERR__')) throw new Error(`${this.name}: ${v.slice(7)}`);
    return v;
  }
  async goto(url) {
    // 线上（app.workbuddy.host）要求先带 ?sharecode= 换 __wb_rsc cookie，否则网关 403「链接不完整」。
    // 每个浏览器上下文（= 一台设备）cookie 隔离，所以每次导航前都先预热一遍。
    if (SHARECODE && !url.includes('sharecode=')) {
      await this.send('Page.navigate', { url: `${BASE}/?sharecode=${SHARECODE}` });
      await sleep(900);
    }
    await this.send('Page.navigate', { url });
    await sleep(700);
  }
  async waitFor(expression, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        /* 页面切换中，重试 */
      }
      await sleep(150);
    }
    return false;
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, file), Buffer.from(data, 'base64'));
  }
}

const setValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT_FOUND';
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'OK';
})()`;

const setByPlaceholder = (needle, value) => `(() => {
  const el = [...document.querySelectorAll('input')].find((n) => (n.placeholder || '').includes(${JSON.stringify(needle)}));
  if (!el) return 'NOT_FOUND';
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'OK';
})()`;

/** SVG 元素没有 click()，统一用 dispatchEvent */
const FIRE = `const fire = (el) => {
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};`;

const click = (selector, index = 0) => `(() => {
  ${FIRE}
  const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
  if (!el) return 'NOT_FOUND';
  fire(el);
  return 'OK';
})()`;

const clickText = (tag, text) => `(() => {
  ${FIRE}
  const el = [...document.querySelectorAll('${tag}')].find((n) => n.textContent.includes(${JSON.stringify(text)}));
  if (!el) return 'NOT_FOUND';
  fire(el);
  return 'OK';
})()`;

/** 开发者代打：先点顶栏的席位开关，再像真人一样操作它 */
async function devAs(device, seat) {
  const r = await device.eval(`(() => {
    const b = document.querySelector('[data-dev-seat="${seat}"]');
    if (!b) return 'NOT_FOUND';
    b.click();
    return 'OK';
  })()`);
  if (r !== 'OK') throw new Error(`找不到开发者席位开关 ${seat}`);
  await sleep(120);
}

const textOf = (selector) => {
  const el = `document.querySelector(${JSON.stringify(selector)})`;
  return `(${el} ? ${el}.textContent : '')`;
};

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${DPORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let ws = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DPORT}/json/version`);
    const url = (await r.json()).webSocketDebuggerUrl;
    if (url) {
      ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      break;
    }
  } catch {
    await sleep(250);
  }
}
if (!ws) {
  console.log('无法启动 Chromium');
  process.exit(1);
}

const routed = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const key = msg.sessionId ?? null;
  const target = routed.get(key);
  if (!target) return;
  if (msg.id && target.pending.has(msg.id)) {
    const { resolve, reject } = target.pending.get(msg.id);
    target.pending.delete(msg.id);
    if (msg.error) reject(new Error(`${target.name} ${JSON.stringify(msg.error)}`));
    else resolve(msg.result);
  }
};

const browser = new Cdp(ws, 'browser');
routed.set(null, browser);

/** 每个设备一个独立的 browser context（独立 localStorage） */
async function newDevice(name) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', {});
  const { targetId } = await browser.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const dev = new Cdp(ws, name, sessionId);
  routed.set(sessionId, dev);
  await dev.send('Page.enable');
  await dev.send('Runtime.enable');
  await dev.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return dev;
}

let host;
let spec;
/** 第三个设备：全程只是观众，用来验证「观众猜词」 */
let guest;

try {
  console.log(`\n[E2E] 单页房间 / 开发者代打 / 复制局面图 @ ${BASE}\n`);

  // ── 1. 落地页 + 隐藏口令 ────────────────────────────────
  host = await newDevice('host');
  // 带分享码落地：后面进房要验证地址栏没把它抹掉（抹掉 → 复制出去的邀请链接「链接不完整」）
  const testShare = SHARECODE || 'E2E-SMOKE';
  await host.goto(`${BASE}/?sharecode=${testShare}`);
  check(await host.waitFor(`!!document.querySelector('input[placeholder="例如：阿蓝"]')`), '落地页渲染');
  check(
    (await host.eval(`document.body.textContent.includes('单人练习')`)) === false,
    '机器人入口已从落地页移除（改为开发者工具）'
  );
  await host.shot('01-landing.png');

  // 隐藏口令：依次敲下 s u i l a n
  await host.eval(`(() => {
    for (const k of 'suilan') window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    return 'OK';
  })()`);
  check(
    await host.waitFor(`document.body.textContent.includes('开发者模式')`, 3000),
    '隐藏口令可以开启开发者模式'
  );

  await host.eval(setByPlaceholder('例如：阿蓝', '测试者'));
  await host.eval(clickText('button', '创建房间'));
  check(await host.waitFor(`document.querySelectorAll('.roster-seat').length === 4`), '建房后直接进入游戏界面');
  check(await host.waitFor(`!!document.querySelector('.board-veil')`), '未导入题库时棋盘盖着提示');
  check(
    (await host.eval(textOf('.board-veil'))).includes('等待导入本局题库'),
    '提示文案是「等待导入本局题库」'
  );
  check(
    (await host.eval(`document.querySelectorAll('.hex').length`)) === 0,
    '没有题库时不画任何可点的格子'
  );

  const roomCode = await host.eval(`new URLSearchParams(location.search).get('room')`);
  check(typeof roomCode === 'string' && /^\d{3}$/.test(roomCode), `拿到 3 位数字房号 ${roomCode}`);
  const searchAfterEnter = await host.eval(`location.search`);
  check(
    searchAfterEnter.includes(`sharecode=${testShare}`),
    '进房后地址栏仍带着分享码（否则玩家复制出来的邀请链接是「链接不完整」）'
  );
  check(searchAfterEnter.includes(`room=${roomCode}`), '进房后地址栏带着房号');
  await host.shot('02-room-waiting.png');

  // ── 2. 观众：从大厅找到房间 / 改昵称 ────────────────────
  spec = await newDevice('spectator');
  await spec.goto(`${BASE}/`);
  check(
    await spec.waitFor(`!!document.querySelector('.lobby-row[data-room="${roomCode}"]')`),
    '落地页房间大厅列出刚建的房间（不用先知道房号）'
  );
  check(
    (await spec.eval(textOf(`.lobby-row[data-room="${roomCode}"]`))).includes('等待开局'),
    '大厅条目带有阶段与人数'
  );
  await spec.shot('02b-lobby.png');
  await spec.eval(click(`.lobby-row[data-room="${roomCode}"]`));
  check(await spec.waitFor(`document.querySelectorAll('.roster-seat').length === 4`), '打开链接即可看到棋盘与游戏界面');
  check(
    await spec.waitFor(`document.body.textContent.includes('观战')`),
    '未入座的访客自动成为观众'
  );

  await spec.eval(click('.nick-btn'));
  check(await spec.waitFor(`!!document.querySelector('.nick-input')`), '观众可以点开昵称编辑');
  await spec.eval(setValue('.nick-input', '路人甲'));
  await spec.eval(`(() => {
    const el = document.querySelector('.nick-input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'OK';
  })()`);
  check(await spec.waitFor(`document.body.textContent.includes('路人甲')`), '观众昵称改成功');

  // 第三个设备全程只观战：选手没有「观众猜词」入口，验证它得有一台真正在观战的设备
  guest = await newDevice('guest');
  await guest.goto(`${BASE}/?room=${roomCode}`);
  check(
    await guest.waitFor(`document.querySelectorAll('.roster-seat').length === 4`),
    '第三个设备以观众身份进房（不入座）'
  );

  // ── 3. 点席位入座 ──────────────────────────────────────
  await host.eval(click('.roster-seat', 0));
  check(await host.waitFor(`document.querySelectorAll('.roster-seat')[0].textContent.includes('测试者')`), '点空位即入座（房主也可以是选手）');
  check(
    await host.waitFor(`[...document.querySelectorAll('.roster-seat button')].some((b) => b.textContent.includes('准备'))`),
    '入座后出现「准备」按钮'
  );

  await spec.eval(click('.roster-seat', 3));
  check(
    await spec.waitFor(`document.querySelectorAll('.roster-seat')[3].textContent.includes('路人甲')`),
    '观众点空位即可接替上场'
  );

  // ── 3b. 规则：启用抢答（默认关闭）──────────────────────
  check(await host.waitFor(`!!document.querySelector('.rule-check input')`), '大厅里有「启用抢答功能」勾选框');
  check(
    (await host.eval(`document.querySelector('.rule-check input').checked`)) === false,
    '抢答默认为关闭'
  );
  await host.eval(click('.rule-check input'));
  check(
    await host.waitFor(`document.querySelector('.rule-check input').checked === true`, 8000),
    '点一下即可启用抢答（勾选状态以服务端快照回填为准）'
  );
  check(
    await spec.waitFor(`document.querySelector('.rule-check input').checked === true`, 8000),
    '另一端同步看到规则已启用'
  );

  // ── 4. 题库：明文词库（粘贴 → 实时预览 → 改 → 提交）──────
  await spec.eval(clickText('button', '导入题库'));
  check(await spec.waitFor(`!!document.querySelector('.bank-src')`), '题库面板展开，默认落在明文词库');

  // 一行塞满「序号 + 顿号」，末尾再补一个重复词和一个纯数字
  const pasted = Array.from({ length: 30 }, (_, i) => `${i + 1}. 测试词${i}`).join('、');
  await spec.eval(setValue('.bank-src', `${pasted}\n测试词0\n2026`));
  check(
    await spec.waitFor(`document.querySelectorAll('.bank-word').length === 30`),
    '粘贴即识别：任意分隔切成 30 个词（重复与纯数字被剔除）'
  );

  // 删一行、改一行：预览本身就是编辑器
  await spec.eval(click('.bank-del', 2));
  await spec.eval(`(() => {
    const el = document.querySelectorAll('.bank-word')[0];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '改成这个词');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  })()`);
  check(
    await spec.waitFor(
      `document.querySelectorAll('.bank-word').length === 29 &&
       document.querySelectorAll('.bank-word')[0].value === '改成这个词'`
    ),
    '预览里可以逐条删除与改写，改完不用重新解析'
  );
  await spec.shot('03a-bank-text-draft.png');

  await spec.eval(setByPlaceholder('题库名', '粘贴题库'));
  await spec.eval(clickText('button', '提交审批'));
  // 线上首跑（沙箱刚醒来）提交这份 30 词明文，往返能到十几秒，默认 15s 不够，给到 30s。
  check(
    await spec.waitFor(`!!document.querySelector('.proposal')`, 30000),
    '提交后立刻进入待审批（本端）'
  );
  check(
    await host.waitFor(`document.body.textContent.includes('粘贴题库')`, 30000),
    '另一端看到这份明文题库'
  );
  // 这里必须是 waitFor 而不是即时 eval：提案卡的昵称和词数不在同一帧到齐，
  // 上一行刚等到昵称就立刻读词数，慢网络下会假阴性（线上首跑踩过）。
  check(
    await host.waitFor(`document.body.textContent.includes('29 词')`, 10000),
    '提案里显示的是改完之后的确切词数（29）'
  );
  await host.eval(clickText('button', '拒绝'));
  check(await host.waitFor(`document.querySelectorAll('.proposal').length === 0`), '房主拒绝后提案撤回');

  // 斜杠写法：一个词、两种写法都算答对，预览里只用第一段当词，行尾标出别名数量。
  // 上一步提交后面板会自动收起，这里要重新打开。
  await spec.eval(clickText('button', '导入题库'));
  await spec.waitFor(`!!document.querySelector('.bank-src')`);
  await spec.eval(setValue('.bank-src', '别名甲/别名乙\n测试词丙'));
  check(
    await spec.waitFor(`document.querySelectorAll('.bank-word').length === 2`),
    '斜杠两边算一个词（2 行 → 2 个词，不是 3 个）'
  );
  check(
    (await spec.eval(`document.querySelectorAll('.bank-word')[0].value`)) === '别名甲',
    '预览里的词取斜杠前那个'
  );
  check(
    (await spec.eval(`document.querySelectorAll('.bank-alt').length`)) === 1,
    '带别名的行有标记'
  );
  check(
    (await spec.eval(textOf('.bank-alt'))).includes('1'),
    '标记上写明别名数量'
  );
  await spec.shot('03b-bank-alias.png');
  // 「用内置示例题库」只在收起状态下出现，下一步要用
  await spec.eval(clickText('button', '收起'));
  check(await spec.waitFor(`!document.querySelector('.bank-src')`), '收起题库面板');

  // ── 4b. 题库：观众上传示例库 → 房主同意 ───────────────
  await spec.eval(clickText('button', '用内置示例题库'));
  check(await host.waitFor(`document.querySelectorAll('.proposal').length === 1`), '观众上传的题库出现在待审批列表');
  check(
    (await host.eval(`document.body.textContent.includes('词表随射')`)) === true,
    '提案里显示题库名称（取自词表文件名）'
  );
  await host.shot('03-bank-proposal.png');

  await host.eval(clickText('button', '同意'));
  check(await host.waitFor(`document.body.textContent.includes('已就绪')`), '房主同意后题库就绪');
  check(
    (await host.eval(`document.querySelectorAll('.proposal').length`)) === 0,
    '同意后待审批列表清空'
  );

  // ── 5. 开发者坐满 + 四席准备 → 自动开局 ─────────────────
  await host.eval(clickText('button', '坐满四个测试选手'));
  check(
    await host.waitFor(`[...document.querySelectorAll('.roster-name')].every((n) => n.textContent.trim() !== '空位')`),
    '开发者一键坐满剩余席位'
  );

  await host.eval(clickText('button', '四席全部准备'));
  // 这一串是「审批题库 → 坐满 → 全部准备 → 自动开局」，云端 round-trip 多，
  // 偶发抽息时 15 秒不够；放宽到 30 秒（服务端已有 6 秒硬超时 + 重试兜底）
  check(
    await host.waitFor(`document.querySelectorAll('.hex').length === 25`, 30000),
    '四席准备后自动开局并发出 25 格'
  );
  check(
    await host.waitFor(`document.body.textContent.includes('红方 选格')`),
    '开局后进入红方选格'
  );
  // 重开是对局级动作，入口在顶栏；答题卡里只放「本回合要做什么」
  check(
    (await host.eval(`!!document.querySelector('.topbar [data-restart]')`)) === true,
    '重开按钮在页面顶部'
  );
  check(
    (await host.eval(`!document.querySelector('.panel [data-restart]')`)) === true,
    '答题卡里不再放重开按钮'
  );
  // 顶栏那个按钮要真能投票：点一次记一票（按钮自带 n/4），再点一次撤回
  await devAs(host, 'RED_DESC');
  await host.eval(click('[data-restart]'));
  check(
    await host.waitFor(`(document.querySelector('[data-restart]')?.textContent || '').includes('1/4')`),
    '点顶栏「重开」投出一票，票数显示在按钮上'
  );
  await host.eval(click('[data-restart]'));
  check(
    await host.waitFor(`(document.querySelector('[data-restart]')?.textContent || '').trim() === '重开'`),
    '再点一次撤回同意，票数回到 0'
  );
  await host.shot('04-board.png');

  // ── 6. 选格 → 描述校验 → 作答 ───────────────────────────
  await devAs(host, 'RED_DESC');
  await host.eval(click('.hex', 0));
  check(await host.waitFor(`!!document.querySelector('.desc-input')`), '选格后出现描述输入框');
  check(
    (await host.eval(
      `!/抢答|防抢/.test(document.querySelector('.panel')?.textContent || '')`
    )) === true,
    '描述位看不到抢答/防抢按钮'
  );
  const answer = (await host.eval(textOf('.word-main'))).trim();
  check(answer.length > 0, `开发者能看到题面「${answer}」`);

  // ── 6b. 换题申请：对方必须同时能同意和拒绝 ─────────────
  await host.eval(clickText('button', '请求换题'));
  check(
    await host.waitFor(`document.body.textContent.includes('换题票 1/2')`),
    '描述位可以发起换题，并看到 1/2 票数'
  );
  check(
    (await host.eval(
      `[...document.querySelectorAll('.panel button')].some((b) => b.textContent.trim() === '撤销申请')`
    )) === true,
    '发起方能撤销自己的换题申请'
  );
  await devAs(host, 'GREEN_DESC');
  check(
    await host.waitFor(`document.body.textContent.includes('对方请求换题')`),
    '对方描述位看到这条换题申请'
  );
  const swapBtns = await host.eval(
    `[...document.querySelectorAll('.panel button')].map((b) => b.textContent.trim())`
  );
  check(
    swapBtns.includes('同意换题') && swapBtns.includes('拒绝'),
    `同意与拒绝两个按钮都在（${swapBtns.join(' / ')}）`
  );
  await host.eval(clickText('button', '拒绝'));
  check(
    await host.waitFor(`document.body.textContent.includes('换题票 0/2')`),
    '拒绝后换题申请作废，票数回到 0/2'
  );
  await devAs(host, 'RED_DESC');

  // 输入过程中不该提前警告（需求：只有提交后才提示）
  await host.eval(setValue('.desc-input', '一'));
  await sleep(250);
  check(
    (await host.eval(`!!document.querySelector('.desc-error')`)) === false,
    '输入过程中不提前警告字数不足'
  );
  // 三个字：绕过界面直接塞进去，应当被规则拦下
  await host.eval(setValue('.desc-input', '一二三'));
  await sleep(250);
  check(
    (await host.eval(`!!document.querySelector('.desc-error')`)) === false,
    '提交之前同样不警告'
  );
  await host.eval(clickText('button', '提交描述'));
  check(
    await host.waitFor(`!!document.querySelector('.desc-error')`),
    '无效描述提交后才提示修改'
  );
  const badMsg = await host.eval(textOf('.desc-error'));
  check(badMsg.includes('两个字'), `提示文案点明字数要求：${badMsg}`);
  check(
    (await host.eval(`!!document.querySelector('.desc-input')`)) === true,
    '被拒后仍停在描述阶段，可以改完再交'
  );

  const clue = clueFor(answer);
  await host.eval(setValue('.desc-input', clue));
  check(
    await host.waitFor(`!document.querySelector('.desc-error')`),
    '改成合法描述后提示自动消失'
  );
  await host.eval(clickText('button', '提交描述'));
  check(
    await host.waitFor(`!!document.querySelector('.desc-bubble') && document.body.textContent.includes('红方 作答')`),
    '描述提交后进入作答阶段'
  );
  check(
    (await host.eval(`!!document.querySelector('input[placeholder*="输入你猜的词语"]')`)) === false,
    '描述位看不到作答框（各席位只看得到自己的操作）'
  );
  check(
    (await host.eval(`document.querySelector('.desc-bubble')?.textContent.includes(${JSON.stringify(clue)})`)) === true,
    '描述对所有人公开显示'
  );

  // ── 6c. 观众猜词：猜中只在战况里说一句「猜中了」 ──────────
  check(
    (await guest.waitFor(`!!document.querySelector('[data-spec-guess]')`, 8000)) === true,
    '观众在对局中能看到「观众猜词」入口'
  );
  check(
    (await host.eval(`!!document.querySelector('[data-spec-guess]')`)) === false,
    '坐在席位上的人没有观众猜词入口'
  );
  await guest.eval(setValue('[data-spec-guess] input', '肯定不是这个'));
  await guest.eval(click('[data-spec-guess] button'));
  check(
    await guest.waitFor(`(document.querySelector('.spec-guess-hint')?.textContent || '').includes('未命中')`, 8000),
    '观众猜错只在自己这边提示「未命中」'
  );
  check(
    (await guest.eval(textOf('.log'))).includes('猜中了') === false,
    '猜错不写进公开战况'
  );
  await guest.eval(setValue('[data-spec-guess] input', answer));
  await guest.eval(click('[data-spec-guess] button'));
  check(
    await guest.waitFor(`(document.querySelector('.spec-guess-hint')?.textContent || '').includes('猜中了')`, 8000),
    '猜中时这台设备立刻看到「猜中了」'
  );
  check(
    await host.waitFor(`(document.querySelector('.log')?.textContent || '').includes('猜中了')`, 10000),
    '别的设备在战况里看到「观众 xx 猜中了」'
  );
  const logAfterSpec = await host.eval(textOf('.log'));
  check(!logAfterSpec.includes(answer), `战况里没有出现答案本身（${answer}）`);
  check(
    (await host.eval(`document.body.textContent.includes('红方 作答')`)) === true,
    '观众猜中不改变对局阶段'
  );
  await guest.shot('06b-spec-guess.png');
  // 手机宽度再看一眼：观众猜词那一行不能被挤出屏幕
  await guest.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(400);
  check(
    (await guest.eval(
      `document.querySelector('[data-spec-guess]').getBoundingClientRect().right <= window.innerWidth + 1`
    )) === true,
    '390px 下观众猜词那一行没有横向溢出'
  );
  await guest.shot('06c-spec-guess-mobile.png');
  await guest.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);

  await devAs(host, 'RED_GUESS');
  check(
    (await host.eval(`!!document.querySelector('input[placeholder*="输入你猜的词语"]')`)) === true,
    '切到猜词位后才有作答框'
  );  await host.eval(setByPlaceholder('输入你猜的词语', '肯定不是这个'));
  await host.eval(clickText('button', '提交答案'));
  check(
    await host.waitFor(`document.querySelectorAll('.rec-row').length === 1`),
    '对局历史按格子分行显示'
  );
  check(
    (await host.eval(`document.querySelector('.rec-row .rec-flow')?.textContent.includes(${JSON.stringify(clue)})`)) === true,
    '记录行里有第一次的描述'
  );
  check(
    await host.waitFor(`document.querySelector('.rec-row .rec-flow')?.textContent.includes('肯定不是这个')`),
    '记录行里有猜词内容'
  );
  check(
    (await host.eval(`document.body.textContent.includes('改由') || document.body.textContent.includes('仍由')`)) === true,
    '答错后仍在这一格，改由对方描述'
  );
  await host.shot('05-record.png');

  // ── 7. 跳过描述 → 本方作答 → 跳过作答 → 对方描述 → 猜对 ──
  await devAs(host, 'GREEN_DESC');
  check(await host.waitFor(`!!document.querySelector('.desc-input')`), '答错后回到描述阶段（对方描述）');
  check(
    (await host.eval(
      `!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '跳过描述')`
    )) === true,
    '描述位有「跳过描述」按钮'
  );
  await host.eval(clickText('button', '跳过描述'));
  check(
    await host.waitFor(`document.querySelector('.desc-bubble')?.textContent.includes('没有描述')`),
    '描述跳过后仍由本方猜词位作答（不再直接跳到对方描述）'
  );
  await devAs(host, 'GREEN_GUESS');
  check(
    (await host.eval(`!!document.querySelector('input[placeholder*="输入你猜的词语"]')`)) === true,
    '切到猜词位就能直接作答'
  );
  await host.eval(clickText('button', '跳过作答'));
  await devAs(host, 'RED_DESC');
  check(await host.waitFor(`!!document.querySelector('.desc-input')`), '跳过作答后交棒给对方描述');
  check(
    await host.waitFor(`document.querySelectorAll('.rec-flow .ev-note.is-green').length >= 2`),
    '跳过也按绿方颜色进历史，而不是灰色字'
  );

  await host.eval(setValue('.desc-input', clueFor(answer, 6)));
  await host.eval(clickText('button', '提交描述'));
  await devAs(host, 'RED_GUESS');
  await host.waitFor(`!!document.querySelector('input[placeholder*="输入你猜的词语"]')`);
  await host.eval(setByPlaceholder('输入你猜的词语', answer));
  await host.eval(clickText('button', '提交答案'));
  check(await host.waitFor(`!!document.querySelector('.rec-flow .ev-answer')`), '答对后记录行出现「答案 ✓」');
  const answerText = await host.eval(textOf('.rec-flow .ev-answer'));
  check(answerText.includes(answer) && answerText.includes('✓'), `记录里写着「${answerText}」`);
  check(
    (await host.eval(`document.querySelectorAll('.rec-row').length`)) === 1,
    '整局记录仍按格子分行（不因交棒而拆行）'
  );
  await host.shot('06-solved.png');

  // ── 8. 暂停 / 继续 ────────────────────────────────────
  // 答对后结算展示 3 秒，随后自动进入下一轮选格（新的 90 秒窗口）。
  // 等到计时条真的出现再测暂停，不要用写死的 sleep——轮询慢一步就会读到结算相位的空 timer。
  check(
    await host.waitFor(`!!document.querySelector('.timer-fill')`, 20000),
    '答对后进入下一轮选格计时'
  );
  await host.eval(clickText('button', '暂停'));
  check(await host.waitFor(`!!document.querySelector('.pause-banner')`), '任意选手可以随时暂停');
  check(
    (await host.eval(`document.querySelector('.pause-banner').textContent.includes('计时已冻结')`)) === true,
    '暂停时明确提示计时冻结'
  );
  await sleep(500);
  const widthAfter = await host.eval(`document.querySelector('.timer-fill')?.style.width || ''`);
  const secAfter = await host.eval(textOf('[data-timer]'));
  check(widthAfter !== '100%', `暂停后计时条不会变成满条（${widthAfter || '空'}）`);
  // 冻结的真正含义：暂停期间再等一秒半，读数必须一动不动。
  // （不能拿暂停前的读数做对比——云端链路上的秒级抖动会让暂停操作晚几秒才落地，
  //   那时的倒计时本来就该少几秒，那是抖动不是没冻结。）
  await sleep(1500);
  const widthFrozen = await host.eval(`document.querySelector('.timer-fill')?.style.width || ''`);
  const secFrozen = await host.eval(textOf('[data-timer]'));
  check(
    widthFrozen === widthAfter && secFrozen === secAfter,
    `暂停期间计时冻结（${widthAfter} → ${widthFrozen}）`
  );
  check(/\d+s/.test(secAfter), `暂停后仍显示剩余秒数（${secAfter}）`);
  await host.shot('07-paused.png');

  await host.eval(clickText('button', '继续对局'));
  check(await host.waitFor(`!document.querySelector('.pause-banner')`), '可以继续对局');

  // ── 9. 复制局面图到剪贴板（不再下载） ───────────────────
  await host.eval(`(() => {
    window.__copied = null;
    window.__img = null;
    window.__dl = 0;
    HTMLAnchorElement.prototype.click = function () { window.__dl += 1; };
    window.ClipboardItem = class {
      constructor(obj) { this._o = obj; this.types = Object.keys(obj); }
      getType(t) { return Promise.resolve(this._o[t]); }
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          const item = items[0];
          const blob = await item.getType('image/png');
          window.__copied = { type: item.types[0], size: blob.size };
          const fr = new FileReader();
          fr.onload = () => { window.__img = fr.result; };
          fr.readAsDataURL(blob);
        },
      },
    });
    return 'OK';
  })()`);

  await host.eval(clickText('button', '复制局面图'));
  check(await host.waitFor(`!!window.__copied`, 15000), '点击后把局面图写进剪贴板');
  check(
    (await host.eval(`(window.__copied || {}).type`)) === 'image/png',
    '剪贴板里是 PNG 图片'
  );
  check((await host.eval(`(window.__copied || {}).size || 0`)) > 10_000, '图片有实际内容（不是空图）');
  check((await host.eval(`window.__dl`)) === 0, '不再触发文件下载');
  check(
    await host.waitFor(`(document.querySelector('.toast')?.textContent || '').includes('剪贴板')`),
    '界面明确提示已复制到剪贴板'
  );

  // 把复制到的图片落盘，便于人工核看版式
  await host.waitFor(`typeof window.__img === 'string'`, 8000);
  const dataUrl = await host.eval(`window.__img`);
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(join(SHOT_DIR, 'export.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    check(true, '复制内容已落盘 shot/export.png');
  } else {
    console.log(`    （返回类型：${typeof dataUrl}，前 40 字：${String(dataUrl).slice(0, 40)}）`);
    check(false, '复制内容可读');
  }

  // ── 10. 观众也能看到记录 ───────────────────────────────
  check(
    await spec.waitFor(`document.querySelectorAll('.rec-row').length === 1`),
    '观众同样能看到历史描述与作答记录'
  );
  await spec.shot('08-spectator.png');

  // ── 11. 解散房间（房号立即回收） ───────────────────────
  check(
    await host.waitFor(`!!document.querySelector('[data-close-room]')`),
    '房主顶栏出现「解散房间」'
  );
  await host.eval(click('[data-close-room]'));
  check(
    await host.waitFor(`(document.querySelector('[data-close-room]')?.textContent || '').includes('确认解散')`),
    '第一次点击只进入两步确认，不会直接解散'
  );
  check(
    await host.waitFor(`!!document.querySelector('.topbar')`),
    '确认态下对局界面还在'
  );
  await host.eval(click('[data-close-room]'));
  check(
    await host.waitFor(`document.body.textContent.includes('房间已解散')`),
    '再次确认后整局解散，界面提示「房间已解散」'
  );
  check(
    await spec.waitFor(`document.body.textContent.includes('房间已解散')`),
    '观众端同步看到「房间已解散」'
  );
  check(
    await host.waitFor(`!document.querySelector('[data-close-room]')`),
    '解散后解散按钮随之消失'
  );
  await host.shot('09-dissolved.png');

  console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  - ' + f);
  }
} catch (e) {
  console.log(`\n[E2E] 异常：${e.message}`);
  fails.push(e.message);
} finally {
  try {
    await browser.send('Browser.close');
  } catch {
    /* ignore */
  }
  chrome.kill();
  process.exit(fails.length ? 1 : 0);
}
