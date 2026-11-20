import { pinyin } from 'pinyin-pro';

const CJK_ONLY = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const NOISE = /[\s,，、。；;：:!！?？"“”'‘’()（）[\]【】《》<>—…·\-_~`/\\]+/g;

/** 取首个有意义字符的拼音首字母，"向日葵" -> "X" */
export function getFirstLetter(text: string): string {
  const clean = (text || '').trim().replace(/^[\s,，、。；;：:!！?？"“”'‘’()（）[\]【】《》<>—…·\-_~`/\\]+/, '');
  if (!clean) return '?';
  const first = clean[0];
  if (/^[a-zA-Z]/.test(first)) return first.toUpperCase();
  try {
    const py = pinyin(first, { toneType: 'none', type: 'array' });
    if (py && py.length > 0 && py[0].length > 0) return py[0][0].toUpperCase();
  } catch {
    /* 忽略拼音库异常 */
  }
  return first.toUpperCase();
}

/** 有效字数（忽略空白与标点） */
export function getCharCount(text: string): number {
  return (text || '').replace(NOISE, '').length;
}

export function getFullPinyin(text: string): string {
  try {
    return pinyin(text || '', { toneType: 'symbol' });
  } catch {
    return '';
  }
}

export function extractChineseChars(text: string): string {
  return (text || '').match(CJK_ONLY)?.join('') || '';
}

function extractLatin(text: string): string {
  return (text || '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * 判词：先洗掉符号/空格/括号/拼音标注再全等比较；纯拼音输入也接受。
 * 与主持人工作台的 checkAnswerMatch 保持同一口径。
 *
 * `alts` 是词表里用 `/` 写出的其它写法（`言不二价/言无二价`）：
 * 任意一种都算答对，但它们是「同一个答案」，所以不影响展示与代号。
 */
export function isAnswerMatch(guess: string, targetWord: string, alts: string[] = []): boolean {
  if (!guess) return false;
  if (matchOne(guess, targetWord)) return true;
  for (const alt of alts) {
    if (alt && alt !== targetWord && matchOne(guess, alt)) return true;
  }
  return false;
}

function matchOne(guess: string, targetWord: string): boolean {
  if (!guess || !targetWord) return false;

  const guessCJK = extractChineseChars(guess);
  const targetCJK = extractChineseChars(targetWord);

  if (guessCJK && targetCJK && guessCJK === targetCJK) return true;

  const norm = (s: string) =>
    (s || '').replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffa-zA-Z0-9]/g, '').toLowerCase();
  const normGuess = norm(guess);
  if (normGuess && normGuess === norm(targetWord)) return true;

  if (!guessCJK) {
    const guessPy = extractLatin(guess);
    if (guessPy) {
      try {
        const targetPy = extractLatin(pinyin(targetCJK || targetWord, { toneType: 'none' }));
        if (targetPy && guessPy === targetPy) return true;
      } catch {
        /* 忽略 */
      }
    }
  }

  return false;
}

/** 同一局内展示码重复时补 a/b/c 后缀，与工作台规则一致 */
export function assignCodes(words: string[]): { code: string; rawCode: string }[] {
  const raws = words.map((w) => `${getFirstLetter(w)}${getCharCount(w)}`);
  const counts: Record<string, number> = {};
  for (const r of raws) counts[r] = (counts[r] || 0) + 1;
  const tracker: Record<string, number> = {};
  return raws.map((raw) => {
    if (counts[raw] > 1) {
      const idx = tracker[raw] || 0;
      tracker[raw] = idx + 1;
      return { rawCode: raw, code: `${raw}${String.fromCharCode(97 + idx)}` };
    }
    return { rawCode: raw, code: raw };
  });
}

/** 换题后重新取一个不与现有格子冲突的展示码 */
export function uniqueCodeFor(word: string, taken: string[]): string {
  const raw = `${getFirstLetter(word)}${getCharCount(word)}`;
  if (!taken.includes(raw)) return raw;
  for (let i = 0; i < 26; i++) {
    const candidate = `${raw}${String.fromCharCode(97 + i)}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${raw}${Date.now() % 1000}`;
}

const HAN_CHAR = /^\p{Script=Han}$/u;

export function isHanChar(ch: string): boolean {
  return HAN_CHAR.test(ch);
}

export interface DescVerdict {
  ok: boolean;
  error?: string;
}

/**
 * 描述规则（前后端共用同一份判定，服务端才是权威）：
 *   1. 正好两个汉字
 *   2. 不能出现答案里的任何一个字
 *
 * 这两条是规则，不是输入框的装饰 —— 服务端会用同样的函数再验一次，
 * 绕过界面直接提交也过不去。
 */
export function validateDescription(text: string, answer: string): DescVerdict {
  const t = (text ?? '').trim();
  const chars = [...t];
  if (chars.length === 0) return { ok: false, error: '描述不能为空' };
  if (chars.length !== 2) {
    return { ok: false, error: `描述必须正好两个字，现在是 ${chars.length} 个字` };
  }
  const nonHan = chars.find((c) => !isHanChar(c));
  if (nonHan) {
    return { ok: false, error: `描述只能用汉字，去掉「${nonHan}」` };
  }
  const answerChars = new Set([...(answer ?? '')]);
  const shared = [...new Set(chars.filter((c) => answerChars.has(c)))];
  if (shared.length) {
    return { ok: false, error: `描述不能含答案里的字：${shared.join('、')}` };
  }
  return { ok: true };
}
