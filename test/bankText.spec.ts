import {
  MAX_BANK_WORDS,
  MAX_WORD_CHARS,
  MIN_BANK_WORDS,
  cleanToken,
  decodeTextFile,
  MAX_ALTS,
  normalizeEntries,
  parseWordList,
} from '../src/bankText';

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

const wordsOf = (text: string) => parseWordList(text).entries.map((e) => e.word);

console.log('\n[明文词库] 任意分隔的识别');
check(wordsOf('向日葵\n人工智能\n画龙点睛').join() === '向日葵,人工智能,画龙点睛', '换行分隔');
check(wordsOf('向日葵,人工智能,画龙点睛').length === 3, '英文逗号');
check(wordsOf('向日葵，人工智能、画龙点睛；青藏高原').length === 4, '中文逗号/顿号/分号混用');
check(wordsOf('向日葵 人工智能 画龙点睛').join() === '向日葵,人工智能,画龙点睛', '空格分隔');
check(wordsOf('向日葵、人工智能 画龙点睛').length === 3, '顿号与空格混用');
check(parseWordList('向日葵\t植物').entries[0].hint === '植物', 'Tab 后的第二列按 .txt 约定进提示（表格粘贴的形状）');
check(wordsOf('向日葵/人工智能=画龙点睛').join() === '向日葵,画龙点睛', '等号仍是分隔，斜杠不是（见下节「别名」）');
check(wordsOf('向日葵|人工智能\n画龙点睛').join() === '向日葵,人工智能,画龙点睛', '竖线不是表格形状时按分隔符切（不吞词）');
check(wordsOf('向日葵；人工智能；').length === 2, '行尾多余分隔符不产生空词');
check(wordsOf('  向日葵  \n\n  人工智能  ').join() === '向日葵,人工智能', '空行与首尾空白');

console.log('\n[明文词库] 斜杠 = 同一个词的另一种写法');
const alias = parseWordList('言不二价/言无二价\n向日葵').entries;
check(alias.length === 2, '斜杠两边算一个词，不拆成两条');
check(alias[0].word === '言不二价', '展示词取斜杠前那个');
check(JSON.stringify(alias[0].alt) === JSON.stringify(['言无二价']), '斜杠后的写法进 alt');
check(parseWordList('重复/重做/重为').entries[0].alt?.length === 2, '一行可以带多个别名');
const four = parseWordList('甲午/甲午2/甲午3/甲午4/甲午5/甲午6').entries[0];
check(1 + (four.alt?.length ?? 0) === MAX_ALTS + 1, `别名最多留 ${MAX_ALTS} 个`);
check(parseWordList('向日葵/向日葵').entries.length === 1, '重复写同一个词只留一条');
check(parseWordList('向日葵/向日葵').entries[0].alt === undefined, '别名与展示词相同则丢弃');
check(parseWordList('《甲》/《乙》').entries[0].alt?.[0] === '乙', '别名也要剥书名号');
check(parseWordList('向日葵/人工智能,画龙点睛').entries.length === 2, '斜杠只管一个词，逗号仍然分词');
const twice = parseWordList('惨淡经营\n惨淡经营/惨澹经营');
check(twice.entries.length === 1, '重复出现的词只留一条');
check(twice.entries[0].alt?.[0] === '惨澹经营', '重复行带来的别名并进已有那条，不丢');
const colAlt = parseWordList('言不二价/言无二价|提示甲|成语').entries[0];
check(colAlt.word === '言不二价' && colAlt.alt?.[0] === '言无二价', '列格式下第一列的斜杠同样生效');
check(colAlt.hint === '提示甲' && colAlt.category === '成语', '列格式下提示/分类不受影响');
const norm = normalizeEntries([{ word: '言不二价', alt: ['言无二价', '言不二价', '   ', '言无二价'] }]);
check(JSON.stringify(norm[0].alt) === JSON.stringify(['言无二价']), '服务端清洗别名：去重、去空、去同词');

console.log('\n[明文词库] 序号与包装符号');
check(wordsOf('1. 向日葵\n2. 人工智能\n3. 画龙点睛').join() === '向日葵,人工智能,画龙点睛', '阿拉伯数字序号');
check(wordsOf('1、向日葵\n2、人工智能').join() === '向日葵,人工智能', '顿号序号');
check(wordsOf('(3) 向日葵\n（4）人工智能').join() === '向日葵,人工智能', '括号序号（半角/全角）');
check(wordsOf('①向日葵\n②人工智能').join() === '向日葵,人工智能', '圈码序号');
check(wordsOf('一、向日葵\n二、人工智能').join() === '向日葵,人工智能', '中文数字序号');
check(wordsOf('- 向日葵\n* 人工智能\n• 画龙点睛').join() === '向日葵,人工智能,画龙点睛', '项目符号');
check(wordsOf('“向日葵”\n《清明上河图》\n【人工智能】').join() === '向日葵,清明上河图,人工智能', '成对引号/书名号/方头括号');
check(wordsOf('向日葵。\n人工智能！').join() === '向日葵,人工智能', '行尾标点');
check(wordsOf('- 01、向日葵').join() === '向日葵', '项目符号 + 序号叠用');

console.log('\n[明文词库] 列：词 / 提示 / 分类');
const cols = parseWordList('向日葵|向阳而生的金色菊科草本|植物').entries[0];
check(cols.word === '向日葵', '第一列是词');
check(cols.hint === '向阳而生的金色菊科草本', '第二列进 hint');
check(cols.category === '植物', '第三列进 category');
const tabbed = parseWordList('向日葵\t向阳而生的金色菊科草本\t植物\n人工智能\t让机器模拟认知\t科技').entries;
check(tabbed.length === 2 && tabbed[1].category === '科技', '表格粘贴（Tab 分列）逐行成词');
check(parseWordList('向日葵|').entries[0].hint === undefined, '空提示不会写成空串');
const table = parseWordList('向日葵|提示甲|植物\n人工智能|提示乙|科技');
check(table.entries.length === 2 && table.entries[1].hint === '提示乙', '整份都是竖线表格时才按列读');
check(parseWordList('向日葵、人工智能|画龙点睛').entries[0].hint === undefined, '一行切出多个词时提示不硬塞');

console.log('\n[明文词库] 去重与丢弃');
const dup = parseWordList('向日葵\n向日葵\n 向日葵 \n人工智能');
check(dup.entries.length === 2, '完全重复与带空白的重复都合并');
check(dup.duplicates === 2, `重复计数正确（${dup.duplicates}）`);
check(parseWordList('向日葵\nＳＵＩＬＡＮ\nsuilan').entries.length === 2, '全角/大小写差异也视为同一个词');
check(parseWordList('向日葵\n2026\n***\n#注释行\n人工智能').entries.length === 2, '纯数字、纯符号、注释行被丢弃');
check(parseWordList('向日葵\n2026').ignored === 1, '丢弃数量被记账（供预览显示）');
check(parseWordList('长'.repeat(MAX_WORD_CHARS + 1) + '\n向日葵').entries.length === 1, '超长片段被丢弃');

console.log('\n[明文词库] 上限与规模常量');
const many = Array.from({ length: MAX_BANK_WORDS + 20 }, (_, i) => `词${i}`).join('\n');
const capped = parseWordList(many);
check(capped.entries.length === MAX_BANK_WORDS, `超过上限截断到 ${MAX_BANK_WORDS} 词`);
check(capped.truncated === 20, `截断数量被记账（${capped.truncated}）`);
check(MIN_BANK_WORDS === 25, '下限仍是 25 词（棋盘 5×5）');

console.log('\n[明文词库] cleanToken');
check(cleanToken('  1. “向日葵”  ') === '向日葵', '一次性剥掉序号 + 引号 + 空白');
check(cleanToken('二十四节气') === '二十四节气', '中文数字开头的词不被误剥');
check(cleanToken('') === '', '空串进空串出');

console.log('\n[明文词库] 服务端清洗 normalizeEntries');
check(normalizeEntries(null).length === 0, '非数组直接作废');
check(normalizeEntries([{ word: ' 向日葵 ' }, { word: '向日葵' }]).length === 1, '再次去重');
check(normalizeEntries([{ word: '向日葵', hint: 'x'.repeat(200), category: 'y'.repeat(50) }])[0].hint!.length === 60, '提示按字数截断');
check(normalizeEntries([{ word: '向日葵', category: 'y'.repeat(50) }])[0].category!.length === 12, '分类按字数截断');
check(normalizeEntries(['向日葵', 42, null, { word: '人工智能' }]).length === 1, '非对象条目被跳过');
check(normalizeEntries([{ word: '' }, { hint: '没有词' }]).length === 0, '缺词条目的作废');
check(normalizeEntries([{ word: '向日葵\u0000\n' }])[0].word === '向日葵', '控制字符被抹掉');

console.log('\n[明文词库] 文件解码');
const utf8 = new TextEncoder().encode('向日葵').buffer;
check(decodeTextFile(utf8) === '向日葵', 'UTF-8 正常解码');
// "向日葵" 的 GBK 字节：cf f2 c8 d5 bf fb —— Windows 上常见，按 UTF-8 读会整篇乱码
const gbk = Uint8Array.from([0xcf, 0xf2, 0xc8, 0xd5, 0xbf, 0xfb]).buffer;
check(decodeTextFile(gbk) === '向日葵', 'GBK 文件自动兜底解码');

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
