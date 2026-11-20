#!/usr/bin/env node
/**
 * 题库打包器 —— 给「选手以外的人」用。
 *
 *   node tools/pack-bank.mjs --in words.txt --name "华夏风雅" --pass 2468 --out 华夏风雅.sbank
 *   node tools/pack-bank.mjs --demo --pass demo --out demo.sbank
 *
 * words.txt 每行一个词，可选追加 `|提示|分类`，例如：
 *   向日葵|向阳而生的金色菊科草本|植物
 *
 * 输出 .sbank 里只有密文，没有口令谁也解不开；房主在网页里用口令导入。
 */
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ITERATIONS = 210_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

function parseWords(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [head, hint, category] = line.split('|').map((s) => (s || '').trim());
      // 斜杠是「同一个答案的另一种写法」：斜杠前那个当展示词，其余进 alt（判对时任一种都行）
      const [word, ...alts] = (head || '').split(/[/／]/).map((s) => s.trim()).filter(Boolean);
      const entry = { word, hint: hint || undefined, category: category || undefined };
      return alts.length ? { ...entry, alt: alts } : entry;
    })
    .filter((w) => w.word);

  // 去重口径与网页导入一致（忽略大小写/全半角/空白）：同一个词出现两次时把别名并起来，
  // 否则棋盘上可能同时出现两个一模一样的词。
  const byKey = new Map();
  for (const row of rows) {
    const key = row.word.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, row);
      continue;
    }
    if (row.alt) hit.alt = [...new Set([...(hit.alt ?? []), ...row.alt])].filter((a) => a !== hit.word);
  }
  return [...byKey.values()];
}

const args = parseArgs(process.argv);
const passphrase = typeof args.pass === 'string' ? args.pass : '';
if (!passphrase) {
  console.error('缺少口令：--pass <口令>');
  process.exit(1);
}

let words;
if (args.demo) {
  // 示例词库只有一份真源：仓库根目录的「词表随射.txt」
  const demoPath = resolve('词表随射.txt');
  try {
    words = parseWords(readFileSync(demoPath, 'utf8'));
  } catch {
    console.error(`找不到示例词表 ${demoPath}（请在仓库根目录运行）`);
    process.exit(1);
  }
} else if (typeof args.in === 'string') {
  words = parseWords(readFileSync(resolve(args.in), 'utf8'));
} else {
  console.error('缺少输入：--in <词表.txt> 或 --demo');
  process.exit(1);
}

if (words.length < 25) {
  console.error(`题库只有 ${words.length} 词，至少需要 25 词`);
  process.exit(1);
}

const name = (typeof args.name === 'string' && args.name) || (args.demo ? '词表随射' : '未命名题库');
const payload = Buffer.from(JSON.stringify({ name, words }), 'utf8');

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([cipher.update(payload), cipher.final()]);
const tag = cipher.getAuthTag();
const ciphertext = Buffer.concat([body, tag]);

const file = {
  v: 1,
  name,
  createdAt: Date.now(),
  count: words.length,
  algo: 'AES-GCM-256',
  kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: salt.toString('base64') },
  iv: iv.toString('base64'),
  ciphertext: ciphertext.toString('base64'),
  fingerprint: createHash('sha256').update(ciphertext).digest('base64').slice(0, 12),
};

const outPath = resolve(typeof args.out === 'string' && args.out ? args.out : `${name}.sbank`);
writeFileSync(outPath, JSON.stringify(file, null, 2), 'utf8');
console.log(`已生成 ${outPath}`);
console.log(`题库：${name}　词数：${words.length}　指纹：${file.fingerprint}`);
console.log('把这个文件发给房主，口令另走一条渠道告知即可。');
