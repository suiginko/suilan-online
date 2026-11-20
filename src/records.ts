import { CellRecord, Team } from './types';

/**
 * 对局历史的事件展开（界面与导出图共用）。
 *
 * 一个格子里的记录按「队」存：红方一条、绿方一条，答错就交替往下写。
 * 但一次抢答会插进对方的记录中间：
 *
 *   红描述(t1) → 绿抢答未命中(t2) → 红猜中(t3)
 *
 * 红方的描述和猜中写在同一条记录里，绿方的抢答是另一条。只按记录建立的先后渲染，
 * 就会变成 红描述 → 红猜中 → 绿抢答，把抢答后面的记录排到了前面。
 * 所以每条记录里都带 `descAt` / `guessAt`，这里展开成事件后按时间合并排序。
 */

export type EventKind = 'desc' | 'guess' | 'answer' | 'note';

export interface HistoryEvent {
  kind: EventKind;
  team: Team | null;
  text: string;
  who: string | null;
  /** 事件发生时刻；老房间没有时间戳，记为 0（排序时保持原顺序） */
  at: number;
}

export const PASS_TEXT: Record<'timeout' | 'skip', { desc: string; guess: string }> = {
  timeout: { desc: '描述超时', guess: '（超时）' },
  skip: { desc: '跳过描述', guess: '（放弃）' },
};

export function eventsOf(record: CellRecord): HistoryEvent[] {
  const raw: { ev: HistoryEvent; seq: number }[] = [];
  let seq = 0;
  /** 老数据没有时间戳时，沿用上一条事件的时间，避免整片排到最前面 */
  let last = 0;

  const push = (
    kind: EventKind,
    team: Team | null,
    text: string,
    who: string | null,
    at: number | undefined
  ) => {
    const t = typeof at === 'number' ? at : last;
    last = Math.max(last, t);
    raw.push({ ev: { kind, team, text, who, at: t }, seq: seq++ });
  };

  for (const a of record.attempts) {
    if (a.descPass) push('note', a.team, PASS_TEXT[a.descPass].desc, a.describer, a.descAt);
    if (a.description) push('desc', a.team, a.description, a.describer, a.descAt);
    if (a.guessPass) push('note', a.team, PASS_TEXT[a.guessPass].guess, a.guesser, a.guessAt);
    // 答对的那一次不再单独写猜测词：直接用「答案 ✓」收尾，避免重复
    if (a.guess && a.outcome !== 'correct') push('guess', a.team, a.guess, a.guesser, a.guessAt);
    if (a.outcome === 'correct' && record.word) {
      push('answer', a.team, `${record.word} ✓`, null, a.guessAt);
    }
  }

  // 时间相同（或都缺失）时保持展开顺序：同一毫秒内描述不会和作答撞车，稳定排序即可
  raw.sort((x, y) => x.ev.at - y.ev.at || x.seq - y.seq);
  return raw.map((r) => r.ev);
}
