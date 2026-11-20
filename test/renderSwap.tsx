/**
 * 换题申请可见性探针：同一局面下，分别以「当前描述方」和「对方描述位」的视角
 * 服务端渲染房间界面，检查谁能看到「请求换题」入口与「换题票 1/2」。
 *
 * 用法：npx tsx test/renderSwap.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { advance, applyIntent, createRoom, prepareSecrets, withBank } from '../src/engine';
import { GameState, Intent, SEAT_ORDER, Secrets, WordEntry } from '../src/types';
import { Room } from '../src/ui/Room';

let seed = 20261108;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const WORDS: WordEntry[] = Array.from({ length: 60 }, (_, i) => ({
  word: `测试词${String.fromCharCode(0x4e00 + i)}`,
  hint: `第 ${i} 条提示`,
  category: '测试',
}));

const T0 = 1_700_000_000_000;
interface Ctx {
  state: GameState;
  secrets: Secrets;
}

function step(ctx: Ctx, intent: Intent, now = T0): Ctx {
  const r = applyIntent(ctx.state, ctx.secrets, intent, now);
  if (r.error) throw new Error(`意外被拒：${intent.t} → ${r.error}`);
  return { state: r.state, secrets: r.secrets };
}

let ctx: Ctx = { state: createRoom('462'), secrets: prepareSecrets(WORDS) };
for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'join', seat, name: `玩家${seat}` });
ctx = {
  state: withBank(ctx.state, { name: '测试题库', count: WORDS.length, fingerprint: 'T' }),
  secrets: ctx.secrets,
};
for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'ready', seat, value: true });
const opened = advance(ctx.state, ctx.secrets, T0);
ctx = { state: opened.state, secrets: opened.secrets };

// 红方选第一格 → 进入描述阶段，activeDescriber = RED
const cell = ctx.state.board.find((c) => !c.owner)!;
ctx = step(ctx, { t: 'select', seat: 'RED_DESC', cellId: cell.id }, T0 + 1000);
// 红方描述位写一条描述
ctx = step(ctx, { t: 'describe', seat: 'RED_DESC', text: '甲乙' }, T0 + 2000);
// 红方描述位发起换题 → 只到 1/2，尚未生效
ctx = step(ctx, { t: 'swap', seat: 'RED_DESC' }, T0 + 3000);

const base = {
  reveal: null,
  spectatorId: null,
  isHost: false,
  isDev: false,
  nick: '测试',
  clockOffset: 0,
  onIntent: () => {},
  onRename: () => {},
  onClaimSeat: () => {},
  onLeaveSeat: () => {},
  onExit: () => {},
  onProposeFile: async () => {},
  onProposeText: async () => {},
  onProposeDemo: async () => {},
};

const red = renderToStaticMarkup(
  <Room {...(base as any)} state={ctx.state} mySeat="RED_DESC" />
);
const green = renderToStaticMarkup(
  <Room {...(base as any)} state={ctx.state} mySeat="GREEN_DESC" />
);

const has = (html: string, text: string) => html.includes(text);
/** 只找真正的按钮元素，避免把日志里的文字误判成入口 */
const swapButton = (html: string) => {
  const m = html.match(/<button[^>]*btn-gold[^>]*>([^<]*)<\/button>/);
  if (!m) return null;
  return { label: m[1].trim(), disabled: /\sdisabled(=|>)/.test(m[0].slice(0, m[0].indexOf('>'))) };
};
const hint = (html: string) => {
  const m = html.match(/<span class="small faint">([^<]*换题[^<]*)<\/span>/);
  return m ? m[1].trim() : null;
};
const logLines = (html: string) =>
  [...html.matchAll(/<div class="log-item">([^<]*)<\/div>/g)].map((m) => m[1].trim());

const describeBtn = (b: ReturnType<typeof swapButton>) =>
  b ? `是（「${b.label}」，disabled=${b.disabled}）` : '否';

const rows = [
  ['状态 swapVotes', ctx.state.swapVotes.join(',') || '（空）'],
  ['红方描述位：换题按钮', describeBtn(swapButton(red))],
  ['红方描述位：换题提示', hint(red) ?? '无'],
  ['绿方描述位：换题按钮', describeBtn(swapButton(green))],
  ['绿方描述位：换题提示', hint(green) ?? '无'],
  ['绿方描述位：日志里出现换题提示', logLines(green).some((t) => t.includes('换题')) ? '是' : '否'],
];
for (const [k, v] of rows) console.log(`  ${k}：${v}`);
console.log('\n  绿方看到的界面日志：');
for (const t of logLines(green)) console.log(`    · ${t}`);

/* ── 判对申请：同一局面下两个描述位的视角 ── */
let jctx: Ctx = { state: createRoom('463'), secrets: prepareSecrets(WORDS) };
for (const seat of SEAT_ORDER) jctx = step(jctx, { t: 'join', seat, name: `玩家${seat}` });
jctx = {
  state: withBank(jctx.state, { name: '测试题库', count: WORDS.length, fingerprint: 'T' }),
  secrets: jctx.secrets,
};
for (const seat of SEAT_ORDER) jctx = step(jctx, { t: 'ready', seat, value: true });
const jopened = advance(jctx.state, jctx.secrets, T0);
jctx = { state: jopened.state, secrets: jopened.secrets };
const jcell = jctx.state.board.find((c) => !c.owner)!;
jctx = step(jctx, { t: 'select', seat: 'RED_DESC', cellId: jcell.id }, T0 + 1000);
jctx = step(jctx, { t: 'describe', seat: 'RED_DESC', text: '甲乙' }, T0 + 2000);
// 红方猜了个「其实就是答案」的说法，引擎按字面判错 → 正是要判对的场景
jctx = step(jctx, { t: 'guess', seat: 'RED_GUESS', text: '同义说法' }, T0 + 3000);
jctx = step(jctx, { t: 'judge', seat: 'RED_DESC' }, T0 + 4000);

const judgeRed = renderToStaticMarkup(
  <Room {...(base as any)} state={jctx.state} mySeat="RED_DESC" />
);
const judgeGreen = renderToStaticMarkup(
  <Room {...(base as any)} state={jctx.state} mySeat="GREEN_DESC" />
);

/** 只看答题卡（`.panel`）里的金色按钮：顶栏的重开也是 `btn-gold`，别混进来 */
const judgeBtn = (html: string) => {
  const start = html.indexOf('class="panel"');
  const end = html.indexOf('class="panel-more"');
  const scope = start >= 0 && end > start ? html.slice(start, end) : html;
  const m = scope.match(/<button[^>]*btn-gold[^>]*>([^<]*)<\/button>/g) ?? [];
  return m.map((b) => b.replace(/<[^>]+>/g, '')).join(' / ') || '无';
};
const judgeHint = (html: string) => {
  const m = html.match(/<span class="small faint">([^<]*(?:判|改判)[^<]*)<\/span>/g) ?? [];
  return m.map((t) => t.replace(/<[^>]+>/g, '').trim()).join(' | ') || '无';
};
console.log('\n  判对申请（红方已投一票）：');
for (const [k, v] of [
  ['judgeVotes / judgeTarget', `${jctx.state.judgeVotes.join(',')} / ${jctx.state.judgeTarget?.guess}`],
  ['红方描述位按钮', judgeBtn(judgeRed)],
  ['红方描述位提示', judgeHint(judgeRed)],
  ['绿方描述位按钮', judgeBtn(judgeGreen)],
  ['绿方描述位提示', judgeHint(judgeGreen)],
] as [string, string][]) console.log(`    ${k}：${v}`);

const dir = join(process.cwd(), 'shot');
mkdirSync(dir, { recursive: true });
/** 用构建产物的样式表，截图才和真实界面一致（文件名带 hash，现找现用）。
    产物目录是 web/（vite build.outDir），老构建在 dist/，两个都找一下，别拿到过期样式。 */
const cssFile = (() => {
  for (const dirName of ['web', 'dist']) {
    try {
      const assets = join(process.cwd(), dirName, 'assets');
      const hit = readdirSync(assets).find((f: string) => f.endsWith('.css'));
      if (hit) return `../${dirName}/assets/${hit}`;
    } catch {
      /* 没这个目录就试下一个 */
    }
  }
  return '';
})();
const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${title}</title>
${cssFile ? `<link rel="stylesheet" href="${cssFile}">` : ''}
<style>body{margin:0;background:#f7f4ee;font-family:"Microsoft YaHei",system-ui,sans-serif}
h2{font:600 15px/1.5 "Microsoft YaHei";margin:12px 16px;color:#1b2330}
.hero{outline:2px dashed #a32d2d;outline-offset:2px}</style>
<h2>${title}</h2>${body}</html>`;
writeFileSync(join(dir, 'swap-red.html'), page('红方描述位视角（已发起换题）', red));
writeFileSync(join(dir, 'swap-green.html'), page('绿方描述位视角（同一时刻）', green));
writeFileSync(join(dir, 'judge-red.html'), page('判对申请：红方描述位（已投一票）', judgeRed));
writeFileSync(join(dir, 'judge-green.html'), page('判对申请：绿方描述位（待同意）', judgeGreen));
console.log('  已写出 shot/swap-red.html 与 shot/swap-green.html');
