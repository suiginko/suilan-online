import { WordEntry } from './types';

/**
 * 明文词库：把「随便什么格式」的一段文本识别成词表。
 *
 * 这是唯一实现——导入面板用它做实时预览，服务端用它做二次清洗
 * （客户端送来的词永远不可信，长度、去重、类型都要在服务端再判一次）。
 *
 * 识别规则（按顺序）：
 *   1. 一行一条；`#` 开头的行当注释跳过（与 tools/pack-bank.mjs 同一约定）
 *   2. 行内用 Tab 或 `|` 分列 → 词 / 提示 / 分类（Tab 是表格粘贴的形状，
 *      `|` 是打包脚本那份 .txt 的形状，两边共用一份词表）
 *   3. 没有分列的行，按 `,，、;；:：\ ~ + & * 空白` 切词
 *   4. **斜杠 `/` 不是词分隔，是「同一个答案的另一种写法」**：`言不二价/言无二价`
 *      算一个词，判对时任一种都行，界面只显示斜杠前的那个（见 types.WordEntry.alt）
 *   5. 每段剥掉行首序号（`1.` `(2)` `三、` `①`）、项目符号、成对引号书名号、行尾标点
 *   6. 去重（忽略大小写与空格）、丢弃不像词（纯数字/纯符号/超长）的碎片
 */
export const MIN_BANK_WORDS = 25;
/** 单份词库上限：棋盘只有 25 格，再多也用不上，纯粹防误传超大文件 */
export const MAX_BANK_WORDS = 3000;
export const MAX_WORD_CHARS = 30;
export const MAX_HINT_CHARS = 60;
export const MAX_CATEGORY_CHARS = 12;
/** 一个词最多带几种别名写法（`甲/乙/丙/丁` 这种长得离谱的行不再往下收） */
export const MAX_ALTS = 4;

/** 列分隔：Tab 一律是列分隔（表格粘贴的形状，词里不会出现 Tab） */
const TAB_SEP = /\t/;
/** 竖线：整份文本长成表格时才当列分隔，否则当普通分隔符 —— 见 parseWordList */
const PIPE_SEP = /[|｜]/;
/** 别名分隔：只有斜杠，且只在「一个词」内部生效 */
const ALT_SEP = /[/／]/;
/** 词分隔：中英文逗号、顿号、分号、冒号、空白、各种加号星号（**不含斜杠**） */
const WORD_SEP = /[,，、;；:：\\~～+＋&＆*＊=＝\s]+/;
/** 竖线不参与列分隔时，它退回成普通分隔符 */
const WORD_SEP_PIPE = /[,，、;；:：\\|｜~～+＋&＆*＊=＝\s]+/;

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;
/** 控制字符：会把 JSON 与界面搞乱，一律抹掉 */
const CTRL = /[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g;
/** 行级同理，但 Tab 要留着 —— 它是列分隔 */
const LINE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\ufeff]/g;

const WRAP_HEAD = /^["'“”‘’「」『』【】《》〈〉[\]()（）]+/;
const WRAP_TAIL = /["'“”‘’「」『』【】《》〈〉[\]()（）]+$/;
const TAIL_PUNCT = /[.。!！?？,，;；:：、~～]+\s*$/;

export interface ParsedBank {
  entries: WordEntry[];
  /** 切出来像词的片段数（去重前） */
  candidates: number;
  /** 因为重复被合并掉的条数 */
  duplicates: number;
  /** 因为不像词（纯数字、纯符号、超长）被丢掉的片段数 */
  ignored: number;
  /** 超过 MAX_BANK_WORDS 被截断的条数 */
  truncated: number;
}

export const EMPTY_BANK: ParsedBank = { entries: [], candidates: 0, duplicates: 0, ignored: 0, truncated: 0 };

/** 去重键：忽略大小写、空白与全半角差异，"New York" 与 "newyork" 视为同一个 */
export function wordKey(word: string): string {
  return (word ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 剥掉序号、项目符号、包装符号与行尾标点 */
export function cleanToken(raw: string): string {
  let s = (raw ?? '').replace(CTRL, '').trim();
  if (!s) return '';
  // 序号与项目符号会叠着出现："- 01、向日葵"
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/^[-–—*+•·※>＝=]+\s*/, '')
      .replace(/^[(（]\s*\d{1,3}\s*[)）]\s*/, '')
      .replace(/^\d{1,3}\s*[).、:：]\s*/, '')
      .replace(/^[一二三四五六七八九十]{1,3}\s*[、.．)）]\s*/, '')
      .replace(/^[①-⑳]\s*/, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(WRAP_HEAD, '').replace(WRAP_TAIL, '').replace(TAIL_PUNCT, '');
  return s.trim();
}

/** 像不像一个词：非空、不太长、至少含一个汉字或拉丁字母 */
export function isWordish(word: string): boolean {
  if (!word) return false;
  if ([...word].length > MAX_WORD_CHARS) return false;
  return HAN.test(word) || LATIN.test(word);
}

/** 提示/分类这类可选字段：抹掉控制字符，按字数截断 */
function optionalText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(CTRL, '').trim();
  return [...s].slice(0, max).join('').trim();
}

/**
 * 把「甲/乙/丙」拆成展示词 + 别名。展示词是斜杠前那个（界面只显示它）。
 * 拆完再各自 cleanToken：`《甲》/《乙》` 两边的书名号都要剥掉。
 */
function splitVariants(piece: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of piece.split(ALT_SEP)) {
    const v = cleanToken(part);
    if (!v) continue;
    const key = wordKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length > MAX_ALTS) break; // 1 个展示词 + MAX_ALTS 个别名
  }
  return out;
}

/**
 * 别名清洗：去掉不像词的、与展示词相同的、重复的，最多留 MAX_ALTS 个。
 * 服务端与客户端预览共用——两边口径必须一致，否则会出现「预览里有、判对不认」。
 */
export function altListOf(alts: unknown, word: string): string[] {
  if (!Array.isArray(alts)) return [];
  const out: string[] = [];
  const seen = new Set<string>([wordKey(word)]);
  for (const raw of alts) {
    if (out.length >= MAX_ALTS) break;
    if (typeof raw !== 'string') continue;
    const v = cleanToken(raw);
    if (!isWordish(v)) continue;
    const key = wordKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function parseWordList(text: string): ParsedBank {
  let candidates = 0;
  let duplicates = 0;
  let ignored = 0;
  let truncated = 0;
  const entries: WordEntry[] = [];
  /** 去重表：key → 已收录的那条，重复出现时把别名并进去 */
  const seen = new Map<string, WordEntry>();

  const put = (word: string, hint = '', category = '', alts: string[] = []) => {
    const key = wordKey(word);
    const existing = seen.get(key);
    if (existing) {
      duplicates++;
      // 同一个词出现两次（词表里很常见），别名要并进已收录的那条，
      // 否则「惨淡经营/惨澹经营」排在第二次出现的位置时，别名会被整条丢掉。
      const merged = altListOf([...(existing.alt ?? []), ...alts], existing.word);
      if (merged.length) existing.alt = merged;
      return;
    }
    if (entries.length >= MAX_BANK_WORDS) {
      truncated++;
      return;
    }
    const entry: WordEntry = { word };
    const cleanAlts = altListOf(alts, word);
    if (cleanAlts.length) entry.alt = cleanAlts;
    if (hint) entry.hint = hint;
    if (category) entry.category = category;
    seen.set(key, entry);
    entries.push(entry);
  };

  const lines = (text ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(LINE_CTRL, '').trim())
    .filter((l) => l && !l.startsWith('#'));

  /**
   * 竖线是不是列分隔？只有「几乎每行都带竖线」这种表格形状才算数。
   * 否则一份随手写的词表（`向日葵|人工智能|画龙点睛`）会被误并成一条，
   * 白白丢掉两个词 —— 宁可多切，不可吞词。
   */
  const withPipe = lines.filter((l) => PIPE_SEP.test(l)).length;
  const pipeAsColumn = lines.length > 0 && withPipe * 5 >= lines.length * 4;
  const wordSep = pipeAsColumn ? WORD_SEP : WORD_SEP_PIPE;
  const colSep = pipeAsColumn ? /[\t|｜]/ : TAB_SEP;

  for (const line of lines) {
    const cols = line.split(colSep).map((c) => c.trim());
    const hint = optionalText(cols[1], MAX_HINT_CHARS);
    const category = optionalText(cols[2], MAX_CATEGORY_CHARS);

    // 先剥掉整行开头的序号/项目符号，再按分隔符切 ——「一、向日葵」里的顿号是序号不是分隔符
    const head = cols.length > 1 ? cols[0] : cleanToken(cols[0]);
    const pieces = head.split(wordSep).map(cleanToken).filter(Boolean);
    // 一行切出多个词时，提示/分类归属不明，宁可不带
    const single = pieces.length === 1;
    for (const piece of pieces) {
      const variants = splitVariants(piece);
      candidates++;
      const word = variants[0];
      if (!word || !isWordish(word)) {
        ignored++;
        continue;
      }
      put(word, single ? hint : '', single ? category : '', variants.slice(1));
    }
  }

  return { entries, candidates, duplicates, ignored, truncated };
}

/**
 * 服务端唯一的入口：把客户端/接口送来的任意形状的数组洗成合法词表。
 * 非数组、非对象、超长、重复、空词一律丢掉——不报错，只缩小。
 */
export function normalizeEntries(raw: unknown): WordEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WordEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_BANK_WORDS) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const word = cleanToken(typeof rec.word === 'string' ? rec.word : '');
    if (!isWordish(word)) continue;
    const key = wordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: WordEntry = { word };
    const alts = altListOf(rec.alt, word);
    if (alts.length) entry.alt = alts;
    const hint = optionalText(rec.hint, MAX_HINT_CHARS);
    const category = optionalText(rec.category, MAX_CATEGORY_CHARS);
    if (hint) entry.hint = hint;
    if (category) entry.category = category;
    out.push(entry);
  }
  return out;
}

/**
 * 读入文本文件：先按 UTF-8 严格解码，失败再按 GBK 解。
 * 中文 .txt 在 Windows 上常是 GBK，直接当 UTF-8 读会整篇乱码。
 */
export function decodeTextFile(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}
