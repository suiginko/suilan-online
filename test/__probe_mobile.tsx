/**
 * 临时探针：手机宽度下的整页渲染（真实昵称 + 几轮对局历史），用来肉眼核对版面与截图。
 * 用法：npx tsx test/__probe_mobile.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { advance, applyIntent, createRoom, prepareSecrets, withBank } from '../src/engine';
import { GameState, Intent, SEAT_ORDER, Secrets, WordEntry } from '../src/types';
import { Room } from '../src/ui/Room';

let seed = 20261109;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const WORDS: WordEntry[] = Array.from({ length: 60 }, (_, i) => ({
  word: `测试词${String.fromCharCode(0x4e00 + i)}`,
  hint: `第 ${i} 条提示`,
  category: '测试',
}));

const NAMES: Record<string, string> = {
  RED_DESC: '宁',
  RED_GUESS: '烤面包机',
  GREEN_DESC: '选手',
  GREEN_GUESS: '雪湖',
};

const T0 = 1_700_000_000_000;
interface Ctx {
  state: GameState;
  secrets: Secrets;
}
const step = (ctx: Ctx, intent: Intent, now = T0): Ctx => {
  const r = applyIntent(ctx.state, ctx.secrets, intent, now);
  if (r.error) throw new Error(`意外被拒：${intent.t} → ${r.error}`);
  return { state: r.state, secrets: r.secrets };
};

let ctx: Ctx = { state: createRoom('002'), secrets: prepareSecrets(WORDS) };
for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'join', seat, name: NAMES[seat] });
ctx = { state: withBank(ctx.state, { name: '测试题库', count: WORDS.length, fingerprint: 'T' }), secrets: ctx.secrets };
for (const seat of SEAT_ORDER) ctx = step(ctx, { t: 'ready', seat, value: true });
const opened = advance(ctx.state, ctx.secrets, T0);
ctx = { state: opened.state, secrets: opened.secrets };

/** 打几轮：选格 → 描述 → 猜错，攒出对局历史 */
let now = T0 + 1000;
/** 选一格开局（只有当前选格方的描述位能选） */
const first = ctx.state.board.find((c) => !c.owner)!;
ctx = step(ctx, { t: 'select', seat: ctx.state.selector === 'RED' ? 'RED_DESC' : 'GREEN_DESC', cellId: first.id }, now);
now += 1000;

/** 答错不换格、只换描述方：两轮下来攒出对局历史，最后停在红方描述 */
for (let round = 0; round < 2; round++) {
  const desc = ctx.state.activeDescriber;
  const descSeat = desc === 'RED' ? 'RED_DESC' : 'GREEN_DESC';
  const guessSeat = desc === 'RED' ? 'RED_GUESS' : 'GREEN_GUESS';
  ctx = step(ctx, { t: 'describe', seat: descSeat, text: '甲乙' }, now);
  now += 1000;
  ctx = step(ctx, { t: 'guess', seat: guessSeat, text: '丙丁' }, now);
  now += 1000;
}
ctx = step(ctx, { t: 'describe', seat: ctx.state.activeDescriber === 'RED' ? 'RED_DESC' : 'GREEN_DESC', text: '甲乙' }, now);

const base = {
  isHost: false,
  isDev: false,
  nick: '宁',
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

const cssFile = (() => {
  for (const dir of ['web', 'dist']) {
    try {
      const assets = join(process.cwd(), dir, 'assets');
      const hit = readdirSync(assets).find((f: string) => f.endsWith('.css'));
      if (hit) return `../${dir}/assets/${hit}`;
    } catch { /* 试下一个 */ }
  }
  return '';
})();

const body = renderToStaticMarkup(<Room {...(base as any)} state={ctx.state} mySeat="RED_DESC" />);
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>手机版面</title>
<link rel="stylesheet" href="${cssFile}">
<style>body{margin:0;background:#f7f4ee;font-family:"Microsoft YaHei",system-ui,sans-serif}</style>
${body}`;

mkdirSync(join(process.cwd(), 'shot'), { recursive: true });
writeFileSync(join(process.cwd(), 'shot', 'mobile.html'), page);
console.log('已生成 shot/mobile.html');

/** 另一份：lobby 阶段（四人已入座、题库就绪、都还没准备），用来核对手机端的准备按钮没被压缩挤坏 */
let lobby: Ctx = { state: createRoom('003'), secrets: prepareSecrets(WORDS) };
for (const seat of SEAT_ORDER) lobby = step(lobby, { t: 'join', seat, name: NAMES[seat] });
lobby = { state: withBank(lobby.state, { name: '测试题库', count: WORDS.length, fingerprint: 'T' }), secrets: lobby.secrets };
const lobbyBody = renderToStaticMarkup(<Room {...(base as any)} state={lobby.state} mySeat="RED_DESC" />);
writeFileSync(
  join(process.cwd(), 'shot', 'mobile-lobby.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>手机 lobby</title>
<link rel="stylesheet" href="${cssFile}">
<style>body{margin:0;background:#f7f4ee;font-family:"Microsoft YaHei",system-ui,sans-serif}</style>
${lobbyBody}`
);
console.log('已生成 shot/mobile-lobby.html');

/**
 * 第三份：终局（对局结束 + 两条对局历史），用来量「答题区 / 对局历史」的紧凑度。
 * 只关心版面，规则是否真的走到终局不重要，所以直接把状态改成 finished 并手搓两条记录。
 */
const fin: Ctx = {
  state: {
    ...ctx.state,
    phase: 'finished',
    winner: 'GREEN',
    currentCellId: null,
    deadlineAt: null,
    history: [
      {
        cellId: 'S3',
        code: 'S3',
        owner: 'GREEN',
        word: '水墨画',
        attempts: [
          {
            team: 'RED',
            describer: '宁',
            description: '徐渭',
            guesser: '雪湖',
            guess: '黑染',
            outcome: 'wrong' as const,
            descAt: now,
            guessAt: now + 1000,
          },
        ],
      },
      {
        cellId: 'T3',
        code: 'T3',
        owner: 'RED',
        word: '太极图',
        attempts: [
          {
            team: 'RED',
            describer: '宁',
            description: '敦颐',
            guesser: '烤面包机',
            guess: '太极图',
            outcome: 'correct' as const,
            descAt: now + 2000,
            guessAt: now + 3000,
          },
        ],
      },
    ],
  },
  secrets: ctx.secrets,
};
const finBody = renderToStaticMarkup(<Room {...(base as any)} state={fin.state} mySeat="RED_DESC" />);
writeFileSync(
  join(process.cwd(), 'shot', 'mobile-finished.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>手机 终局</title>
<link rel="stylesheet" href="${cssFile}">
<style>body{margin:0;background:#f7f4ee;font-family:"Microsoft YaHei",system-ui,sans-serif}</style>
${finBody}`
);
console.log('已生成 shot/mobile-finished.html');
