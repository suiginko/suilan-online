#!/usr/bin/env node
/**
 * 示例题库生成器：把仓库根目录的「词表随射.txt」原样搬进 `src/data/demoText.ts`。
 *
 *   npm run demo-bank
 *
 * 为什么要生成而不是运行时读文件：服务端会被打成单文件 `dist-server/index.mjs`，
 * 线上再读磁盘上的 .txt 就成了「多一个可能缺失的运行时依赖」。生成成模块后，
 * 词表跟着代码一起发布，不会出现「文件忘了传 → 示例题库空着」。
 *
 * 生成的文本**不加工**：斜杠、空格、异常行都照原样保留，交给 `parseWordList` 处理，
 * 这样「点示例题库」与「上传同一个 .txt」走的是同一条解析路径。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = '词表随射.txt';
const OUT = 'src/data/demoText.ts';

const raw = readFileSync(resolve(SRC), 'utf8').replace(/\r\n?/g, '\n').trim();
const lines = raw.split('\n');

// 每行一个 JSON 字符串再拼起来：中文不转义，diff 里看得到原词，也不怕反引号/${}
const body = lines.map((l) => `  ${JSON.stringify(l + '\n')}`).join(' +\n');

writeFileSync(
  resolve(OUT),
  `/**
 * 由 \`node tools/build-demo-bank.mjs\`（或 \`npm run demo-bank\`）从「${SRC}」生成。
 * 不要手改这个文件：改词表请改 ${SRC}，然后重新生成。
 */
export const DEMO_SOURCE_FILE = ${JSON.stringify(SRC)};
export const DEMO_TEXT =
${body};
`,
  'utf8'
);

console.log(`已生成 ${OUT}：${lines.length} 行（来源 ${SRC}）`);
