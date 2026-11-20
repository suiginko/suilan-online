import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWordList, wordKey } from '../src/bankText';
import { DEMO_BANK_NAME, DEMO_WORDS } from '../src/data/demoBank';

/**
 * 示例题库 = 仓库根目录的「词表随射.txt」。
 *
 * 这里守两件事：
 *   1. 示例词库确实来自那份词表（有人改了 .txt 却忘了 `npm run demo-bank`，这里就红）
 *   2. 点「示例题库」与把同一个 .txt 拖进导入框，解析结果必须一模一样（含斜杠别名）
 */

let pass = 0;
const failures: string[] = [];
function check(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const SRC = '词表随射.txt';

console.log('\n示例题库');
check(DEMO_BANK_NAME === '词表随射', `题库名取文件名（${DEMO_BANK_NAME}）`);
check(DEMO_WORDS.length >= 25, `够开局（${DEMO_WORDS.length} 词）`);

const withAlt = DEMO_WORDS.filter((w) => w.alt?.length);
check(withAlt.length > 0, `斜杠写法被识别成别名（${withAlt.length} 个词带别名）`);
check(
  DEMO_WORDS.every((w) => w.word && !w.word.includes('/')),
  '展示词里不残留斜杠'
);
check(
  DEMO_WORDS.filter((w) => w.alt).every((w) => !(w.alt ?? []).includes(w.word)),
  '别名不会与展示词重复'
);

const keys = DEMO_WORDS.map((w) => wordKey(w.word));
check(new Set(keys).size === keys.length, '示例词库内部没有重复词');

// 生成物 vs 源文件：一致说明没人绕过 `npm run demo-bank` 手改过 demoText.ts
const raw = readFileSync(resolve(SRC), 'utf8');
const parsed = parseWordList(raw);
check(
  parsed.entries.length === DEMO_WORDS.length,
  `词数与源文件一致（${parsed.entries.length}）`
);
check(
  parsed.entries.map((w) => wordKey(w.word)).join('|') === keys.join('|'),
  '词的顺序与内容都和源文件一致（改了 .txt 记得重跑 npm run demo-bank）'
);
check(
  JSON.stringify(parsed.entries.filter((w) => w.alt)) === JSON.stringify(DEMO_WORDS.filter((w) => w.alt)),
  '别名也与源文件一致'
);

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
